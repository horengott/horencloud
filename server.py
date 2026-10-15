import os
import uuid
import boto3
import asyncio
import hmac
import hashlib
import json
from urllib.parse import unquote
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, Depends, HTTPException, status, UploadFile, File, Form
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
import jwt
import schemas
from db import crud
from db import models
from db.database import get_db, engine, Base
from contextlib import asynccontextmanager
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
    db_file = await crud.get_file_by_id(db_session, file_id, current_user.id)
    if not db_file:
        raise HTTPException(status_code=404, detail='file not found')
    
    url = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': R2_BUCKET_NAME, 'Key': db_file.storage_path},
        ExpiresIn=3600
    )
    return RedirectResponse(url)


@app.delete('/files/{file_id}')
async def delete_file(
    file_id: int, 
    current_user: models.User = Depends(get_current_user), 
    db_session: AsyncSession = Depends(get_db)
):
    db_file = await crud.get_file_by_id(db_session, file_id, current_user.id)
    if not db_file:
        raise HTTPException(status_code=404, detail='file not found')
    
    try:
        s3_client.delete_object(Bucket=R2_BUCKET_NAME, Key=db_file.storage_path)
    except Exception:
        pass
        
    await crud.delete_file(db_session, file_id, current_user.id)
    return {'status': 'deleted'}


@app.delete('/folders/{folder_id}')
async def delete_folder(
    folder_id: int,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    db_folder = await crud.get_folder_by_id(db_session, folder_id, current_user.id)
    if not db_folder:
        raise HTTPException(status_code=404, detail='Folder not found')
        
    if db_folder.cover_url:
        try:
            s3_client.delete_object(Bucket=R2_BUCKET_NAME, Key=db_folder.cover_url)
        except Exception:
            pass

    success = await crud.delete_folder(db_session, folder_id, current_user.id)
    if not success:
        raise HTTPException(status_code=404, detail='Folder not found')
    
    return {'status': 'deleted'}

app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")