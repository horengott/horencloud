import os
import uuid
import boto3
import asyncio
import hmac
import hashlib
import json
from urllib.parse import quote, unquote
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, Depends, HTTPException, status, UploadFile, File, Form
from fastapi.responses import FileResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
import jwt
import schemas
from db import crud
from db import models
from db.database import get_db, engine, Base
from contextlib import asynccontextmanager
from sqlalchemy import select, update
from bot.main import bot, dp

BOT_TOKEN = os.getenv('BOT_TOKEN')
JWT_SECRET = os.getenv('JWT_SECRET', 'default_horencloud_fallback_jwt_secret_key_2026_99x')
ALGORITHM = 'HS256'

R2_ENDPOINT_URL = os.getenv('ENDPOINT_URL')
R2_ACCESS_KEY_ID = os.getenv('KEY_ID')
R2_SECRET_ACCESS_KEY = os.getenv('SECRET_ACCESS_KEY')
R2_BUCKET_NAME = os.getenv('BUCKET_NAME')

s3_client = boto3.client(
    service_name="s3",
    endpoint_url=R2_ENDPOINT_URL,
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name="auto"
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl='auth')


def validate_telegram_data(init_data: str) -> dict:
    parsed_data = dict(qc.split('=') for qc in init_data.split('&'))
    hash_val = parsed_data.pop('hash', None)
    if not hash_val:
        return {}
    
    data_check_string = '\n'.join(f'{k}={unquote(parsed_data[k])}' for k in sorted(parsed_data.keys()))
    secret_key = hmac.new(b'WebAppData', BOT_TOKEN.encode(), hashlib.sha256).digest()
    calculated_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
    
    if calculated_hash != hash_val:
        return {}
    
    return json.loads(unquote(parsed_data.get('user', '{}')))


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(days=7)
    to_encode.update({'exp': expire})
    return jwt.encode(to_encode, JWT_SECRET, algorithm=ALGORITHM)


async def get_current_user(token: str = Depends(oauth2_scheme), db_session: AsyncSession = Depends(get_db)) -> models.User:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[ALGORITHM])
        user_id: str = payload.get('sub')
        if user_id is None:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    except jwt.PyJWTError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    
    user = await crud.get_user_by_telegram_id(db_session, int(user_id))
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED)
    return user


async def init_db():
    async with engine.begin() as conn:
        try:
            await conn.run_sync(Base.metadata.create_all)
        except Exception as e:
            print(f'db failed: {e}')


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    polling_task = asyncio.create_task(dp.start_polling(bot))
    yield


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def serve_frontend():
    return FileResponse('frontend/index.html')


@app.post('/auth', response_model=schemas.Token)
async def auth_telegram(auth_data: schemas.TelegramAuth, db_session: AsyncSession = Depends(get_db)):
    user_data = validate_telegram_data(auth_data.init_data)
    if not user_data:
        raise HTTPException(status_code=401, detail='Invalid Telegram data')
    
    user = await crud.get_or_create_user(
        db_session, 
        telegram_id=user_data.get('id'), 
        first_name=user_data.get('first_name'), 
        username=user_data.get('username')
    )
    access_token = create_access_token(data={'sub': str(user.telegram_id)})
    return {'access_token': access_token, 'token_type': 'bearer'}


@app.post('/folders', response_model=schemas.FolderResponse)
async def create_folder(
    name: str = Form(...),
    parent_id: int | None = Form(None),
    cover: UploadFile | None = File(None),
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    cover_url = None
    if cover:
        file_ext = cover.filename.split('.')[-1]
        s3_key = f"user_{current_user.telegram_id}/covers/{uuid.uuid4()}.{file_ext}"
        try:
            s3_client.upload_fileobj(
                cover.file,
                R2_BUCKET_NAME,
                s3_key,
                ExtraArgs={"ContentType": cover.content_type or "image/jpeg"}
            )
            cover_url = s3_key
        except Exception as e:
            raise HTTPException(status_code=500, detail=str(e))

    db_folder = models.Folder(
        name=name,
        user_id=current_user.id,
        parent_id=parent_id,
        cover_url=cover_url
    )
    db_session.add(db_folder)
    await db_session.commit()
    await db_session.refresh(db_folder)
    
    if db_folder.cover_url:
        db_folder.cover_url = s3_client.generate_presigned_url(
            'get_object',
            Params={'Bucket': R2_BUCKET_NAME, 'Key': db_folder.cover_url},
            ExpiresIn=604800
        )
        
    return db_folder


@app.get('/folders', response_model=list[schemas.FolderResponse])
async def get_folders(
    parent_id: int | None = None,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    folders = await crud.get_user_folders(
        db_session,
        current_user.id,
        parent_id
    )

    folder_list = []

    for f in folders:
        url = None

        if f.cover_url:
            url = s3_client.generate_presigned_url(
                'get_object',
                Params={
                    'Bucket': R2_BUCKET_NAME,
                    'Key': f.cover_url
                },
                ExpiresIn=604800
            )

        folder_list.append({
            "id": f.id,
            "name": f.name,
            "cover_url": url,
            "parent_id": f.parent_id,
            "created_at": f.created_at
        })

    return folder_list


@app.patch('/folders/{folder_id}', response_model=schemas.FolderResponse)
async def update_folder(
    folder_id: int,
    name: str | None = Form(None),
    cover_file_id: int | None = Form(None),
    clear_cover: bool = Form(False),
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    db_folder = await crud.get_folder_by_id(
        db_session,
        folder_id,
        current_user.id
    )

    if not db_folder:
        raise HTTPException(status_code=404, detail='Folder not found')

    if name is not None:
        clean_name = name.strip()

        if not clean_name:
            raise HTTPException(
                status_code=422,
                detail='Folder name cannot be empty'
            )

        db_folder.name = clean_name

    if cover_file_id is not None:
        db_file = await crud.get_file_by_id(
            db_session,
            cover_file_id,
            current_user.id
        )

        if not db_file:
            raise HTTPException(
                status_code=404,
                detail='Cover file not found'
            )

        if db_file.folder_id != folder_id:
            raise HTTPException(
                status_code=400,
                detail='Cover must belong to this folder'
            )

        is_image = (
            (db_file.mime_type or '').startswith('image/')
            or db_file.name.lower().endswith((
                '.avif', '.bmp', '.gif', '.heic', '.heif',
                '.jpeg', '.jpg', '.png', '.tif', '.tiff', '.webp'
            ))
        )

        if not is_image:
            raise HTTPException(
                status_code=400,
                detail='Cover must be an image'
            )

        db_folder.cover_url = db_file.storage_path

    elif clear_cover:
        db_folder.cover_url = None

    await db_session.commit()
    await db_session.refresh(db_folder)

    cover_url = None

    if db_folder.cover_url:
        if db_folder.cover_url.startswith('http'):
            cover_url = db_folder.cover_url
        else:
            cover_url = s3_client.generate_presigned_url(
                'get_object',
                Params={
                    'Bucket': R2_BUCKET_NAME,
                    'Key': db_folder.cover_url
                },
                ExpiresIn=604800
            )

    return {
        'id': db_folder.id,
        'name': db_folder.name,
        'cover_url': cover_url,
        'parent_id': db_folder.parent_id,
        'created_at': db_folder.created_at
    }


@app.post('/files', response_model=schemas.FileResponse)
async def upload_file(
    file: UploadFile,
    folder_id: int | None = Form(None),
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    file.file.seek(0, os.SEEK_END)
    file_size = file.file.tell()
    file.file.seek(0)

    file_ext = file.filename.split('.')[-1]
    if folder_id:
        file_key = f"user_{current_user.telegram_id}/folder_{folder_id}/{uuid.uuid4()}.{file_ext}"
    else:
        file_key = f"user_{current_user.telegram_id}/root/{uuid.uuid4()}.{file_ext}"

    try:
        s3_client.upload_fileobj(
            file.file,
            R2_BUCKET_NAME,
            file_key,
            ExtraArgs={"ContentType": file.content_type or "application/octet-stream"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

    db_file = await crud.create_file(
        db_session,
        user_id=current_user.id,
        name=file.filename,
        storage_path=file_key,  
        size_bytes=file_size,
        mime_type=file.content_type,
        folder_id=folder_id
    )
    
    db_file.storage_path = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': R2_BUCKET_NAME, 'Key': file_key},
        ExpiresIn=604800 
    )
    
    return db_file


@app.get('/files')
async def get_files(
    folder_id: int | None = None,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    files = await crud.get_user_files(db_session, user_id=current_user.id, folder_id=folder_id)
    
    file_list = []
    for f in files:
        if f.storage_path and not f.storage_path.startswith("http"):
            url = s3_client.generate_presigned_url(
                'get_object',
                Params={'Bucket': R2_BUCKET_NAME, 'Key': f.storage_path},
                ExpiresIn=604800 
            )
        else:
            url = f.storage_path

        file_list.append({
            "id": f.id,
            "name": f.name,
            "storage_path": url,  
            "size_bytes": f.size_bytes,
            "mime_type": f.mime_type,
            "folder_id": f.folder_id
        })
            
    return file_list


@app.get('/files/{file_id}/download')
async def download_file(
    file_id: int,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    db_file = await crud.get_file_by_id(
        db_session,
        file_id,
        current_user.id
    )

    if not db_file:
        raise HTTPException(
            status_code=404,
            detail='file not found'
        )

    try:
        s3_object = await asyncio.to_thread(
            s3_client.get_object,
            Bucket=R2_BUCKET_NAME,
            Key=db_file.storage_path
        )
    except Exception:
        raise HTTPException(
            status_code=502,
            detail='No se pudo obtener el archivo del almacenamiento'
        )

    body = s3_object['Body']

    def stream_body():
        try:
            for chunk in body.iter_chunks(chunk_size=1024 * 1024):
                if chunk:
                    yield chunk
        finally:
            body.close()

    media_type = (
        s3_object.get('ContentType')
        or db_file.mime_type
        or 'application/octet-stream'
    )

    content_disposition = (
        f"attachment; filename*=UTF-8''{quote(db_file.name, safe='')}"
    )

    return StreamingResponse(
        stream_body(),
        media_type=media_type,
        headers={
            'Content-Disposition': content_disposition
        }
    )


@app.delete('/files/{file_id}')
async def delete_file(
    file_id: int,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    db_file = await crud.get_file_by_id(
        db_session,
        file_id,
        current_user.id
    )

    if not db_file:
        raise HTTPException(
            status_code=404,
            detail='file not found'
        )

    try:
        await asyncio.to_thread(
            s3_client.delete_object,
            Bucket=R2_BUCKET_NAME,
            Key=db_file.storage_path
        )
    except Exception:
        raise HTTPException(
            status_code=502,
            detail='No se pudo eliminar el archivo del almacenamiento'
        )

    await db_session.execute(
        update(models.Folder)
        .where(
            models.Folder.user_id == current_user.id,
            models.Folder.cover_url == db_file.storage_path
        )
        .values(cover_url=None)
    )

    deleted = await crud.delete_file(
        db_session,
        file_id,
        current_user.id
    )

    if not deleted:
        raise HTTPException(
            status_code=404,
            detail='file not found'
        )

    return {'status': 'deleted'}


@app.delete('/folders/{folder_id}')
async def delete_folder(
    folder_id: int,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    db_folder = await crud.get_folder_by_id(
        db_session,
        folder_id,
        current_user.id
    )

    if not db_folder:
        raise HTTPException(
            status_code=404,
            detail='Folder not found'
        )

    folder_result = await db_session.execute(
        select(models.Folder).where(
            models.Folder.user_id == current_user.id
        )
    )

    user_folders = list(folder_result.scalars().all())

    file_result = await db_session.execute(
        select(models.File).where(
            models.File.user_id == current_user.id
        )
    )

    user_files = list(file_result.scalars().all())

    children_by_parent = {}

    for folder in user_folders:
        children_by_parent.setdefault(folder.parent_id, []).append(folder.id)

    subtree_ids = set()
    pending_ids = [folder_id]

    while pending_ids:
        current_id = pending_ids.pop()

        if current_id in subtree_ids:
            continue

        subtree_ids.add(current_id)
        pending_ids.extend(children_by_parent.get(current_id, []))

    subtree_folders = [
        folder for folder in user_folders
        if folder.id in subtree_ids
    ]

    subtree_files = [
        file for file in user_files
        if file.folder_id in subtree_ids
    ]

    all_file_keys = {
        file.storage_path
        for file in user_files
        if file.storage_path
    }

    subtree_file_keys = {
        file.storage_path
        for file in subtree_files
        if file.storage_path
    }

    external_cover_keys = {
        folder.cover_url
        for folder in user_folders
        if folder.id not in subtree_ids and folder.cover_url
    }

    keys_to_delete = set(subtree_file_keys)

    for folder in subtree_folders:
        cover_key = folder.cover_url

        if not cover_key or cover_key.startswith('http'):
            continue

        if (
            cover_key not in all_file_keys
            and cover_key not in external_cover_keys
        ):
            keys_to_delete.add(cover_key)

    for key in keys_to_delete:
        try:
            await asyncio.to_thread(
                s3_client.delete_object,
                Bucket=R2_BUCKET_NAME,
                Key=key
            )
        except Exception:
            raise HTTPException(
                status_code=502,
                detail='No se pudo eliminar todo el contenido del almacenamiento'
            )

    if subtree_file_keys:
        await db_session.execute(
            update(models.Folder)
            .where(
                models.Folder.user_id == current_user.id,
                ~models.Folder.id.in_(subtree_ids),
                models.Folder.cover_url.in_(subtree_file_keys)
            )
            .values(cover_url=None)
        )

    success = await crud.delete_folder(
        db_session,
        folder_id,
        current_user.id
    )

    if not success:
        raise HTTPException(
            status_code=404,
            detail='Folder not found'
        )

    return {'status': 'deleted'}

app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")