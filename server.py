import os
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