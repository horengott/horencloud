import os
import uuid
import boto3
import shutil
import asyncio
from fastapi import Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
import hmac
import hashlib
import json
from urllib.parse import unquote
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, Depends, HTTPException, status, UploadFile, File
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
async def create_folder(folder: schemas.FolderCreate, current_user: models.User = Depends(get_current_user), db_session: AsyncSession = Depends(get_db)):
    return await crud.create_folder(db_session, current_user.id, folder)


@app.get('/folders', response_model=list[schemas.FolderResponse])
async def get_folders(parent_id: int | None = None, current_user: models.User = Depends(get_current_user), db_session: AsyncSession = Depends(get_db)):
    return await crud.get_user_folders(db_session, current_user.id, parent_id)


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

    file_key = f"uploads/{current_user.id}_{uuid.uuid4()}_{file.filename}"

    try:
        s3_client.upload_fileobj(
            file.file,
            R2_BUCKET_NAME,
            file_key,
            ExtraArgs={"ContentType": file.content_type or "application/octet-stream"}
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"no se ha guardado en el storage: {str(e)}")

    file_url = s3_client.generate_presigned_url(
        'get_object',
        Params={'Bucket': R2_BUCKET_NAME, 'Key': file_key},
        ExpiresIn=604800 
    )

    return await crud.create_file(
        db_session,
        user_id=current_user.id,
        name=file.filename,
        storage_path=file_url,  
        size_bytes=file_size,
        mime_type=file.content_type,
        folder_id=folder_id
    )


@app.get('/files')
async def get_files(
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    files = await crud.get_user_files(db_session, user_id=current_user.id)
    
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
    if not db_file or not os.path.exists(db_file.storage_path):
        raise HTTPException(status_code=404, detail='file not found')
    
    return FileResponse(
        path=db_file.storage_path, 
        filename=db_file.name, 
        media_type=db_file.mime_type
    )


@app.delete('/files/{file_id}')
async def delete_file(
    file_id: int, 
    current_user: models.User = Depends(get_current_user), 
    db_session: AsyncSession = Depends(get_db)
):
    db_file = await crud.delete_file(db_session, file_id, current_user.id)
    if not db_file:
        raise HTTPException(status_code=404, detail='file not found')
    
    if os.path.exists(db_file.storage_path):
        os.remove(db_file.storage_path)
        
    return {'status': 'deleted'}


@app.delete('/folders/{folder_id}')
async def delete_folder(
    folder_id: int,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    success = await crud.delete_folder(db_session, folder_id, current_user.id)
    if not success:
        raise HTTPException(status_code=404, detail='Folder not found')
    
    return {'status': 'deleted'}


app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")