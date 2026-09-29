from pydantic import BaseModel, ConfigDict
from typing import Optional
from datetime import datetime

class TelegramAuth(BaseModel):
    init_data: str

class Token(BaseModel):
    access_token: str
    token_type: str = 'bearer'

class UserResponse(BaseModel):
    id: int
    telegram_id: int
    first_name: str
    username: Optional[str] = None
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)

class FolderCreate(BaseModel):
    name: str
    parent_id: Optional[int] = None

class FolderResponse(BaseModel):
    id: int
    name: str
    parent_id: Optional[int]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)

class FileResponse(BaseModel):
    id: int
    name: str
    size_bytes: int
    mime_type: Optional[str]
    folder_id: Optional[int]
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)