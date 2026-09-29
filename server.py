import os
import shutil
from fastapi import Form
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
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

BOT_TOKEN = os.getenv('BOT_TOKEN')
JWT_SECRET = os.getenv('JWT_SECRET')
ALGORITHM = 'HS256'

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
    yield

app = FastAPI(lifespan=lifespan)

app.mount('/css', StaticFiles(directory='frontend'), name='css')
app.mount('/js', StaticFiles(directory='frontend'), name='js')
app.mount('/img', StaticFiles(directory='frontend/img'), name='img')


@app.get('/')
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
    upload_dir = 'uploads'
    os.makedirs(upload_dir, exist_ok=True)
    
    file_path = f'{upload_dir}/{current_user.id}_{file.filename}'
    
    with open(file_path, 'wb') as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    file_size = os.path.getsize(file_path)
    
    return await crud.create_file(
        db_session,
        user_id=current_user.id,
        name=file.filename,
        storage_path=file_path,
        size_bytes=file_size,
        mime_type=file.content_type,
        folder_id=folder_id
    )

@app.get('/files', response_model=list[schemas.FileResponse])
async def get_files(
    folder_id: int | None = None, 
    current_user: models.User = Depends(get_current_user), 
    db_session: AsyncSession = Depends(get_db)
):
    return await crud.get_user_files(db_session, current_user.id, folder_id)

@app.get('/files/{file_id}/download')
async def download_file(
    file_id: int, 
    current_user: models.User = Depends(get_current_user), 
    db_session: AsyncSession = Depends(get_db)
):
    db_file = await crud.get_file_by_id(db_session, file_id, current_user.id)
    if not db_file or not os.path.exists(db_file.storage_path):
        raise HTTPException(status_code=404, detail='File not found')
    
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
        raise HTTPException(status_code=404, detail='File not found')
    
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