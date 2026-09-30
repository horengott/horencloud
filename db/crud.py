from typing import Optional, Sequence
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from db import models
import schemas


async def get_user_by_telegram_id(db: AsyncSession, telegram_id: int) -> Optional[models.User]:
    result = await db.execute(select(models.User).where(models.User.telegram_id == telegram_id))
    return result.scalars().first()


async def create_user(db: AsyncSession, telegram_id: int, first_name: str, username: Optional[str] = None) -> models.User:
    db_user = models.User(
        telegram_id=telegram_id,
        first_name=first_name,
        username=username
    )
    db.add(db_user)
    await db.commit()
    await db.refresh(db_user)
    return db_user


async def get_or_create_user(db: AsyncSession, telegram_id: int, first_name: str, username: Optional[str] = None) -> models.User:
    user = await get_user_by_telegram_id(db, telegram_id)
    if not user:
        user = await create_user(db, telegram_id, first_name, username)
    return user


async def create_folder(db: AsyncSession, user_id: int, folder_data: schemas.FolderCreate) -> models.Folder:
    db_folder = models.Folder(
        name=folder_data.name,
        user_id=user_id,
        parent_id=folder_data.parent_id
    )
    db.add(db_folder)
    await db.commit()
    await db.refresh(db_folder)
    return db_folder


async def get_user_folders(db: AsyncSession, user_id: int, parent_id: Optional[int] = None) -> Sequence[models.Folder]:
    query = select(models.Folder).where(
        models.Folder.user_id == user_id,
        models.Folder.parent_id == parent_id
    )
    result = await db.execute(query)
    return result.scalars().all()


async def get_folder_by_id(db: AsyncSession, folder_id: int, user_id: int) -> Optional[models.Folder]:
    query = select(models.Folder).where(
        models.Folder.id == folder_id,
        models.Folder.user_id == user_id
    )
    result = await db.execute(query)
    return result.scalars().first()


async def delete_folder(db: AsyncSession, folder_id: int, user_id: int) -> bool:
    folder = await get_folder_by_id(db, folder_id, user_id)
    if not folder:
        return False
    await db.delete(folder)
    await db.commit()
    return True


async def create_file(
    db: AsyncSession,
    user_id: int,
    name: str,
    storage_path: str,
    size_bytes: int,
    mime_type: Optional[str] = None,
    folder_id: Optional[int] = None
) -> models.File:
    db_file = models.File(
        name=name,
        storage_path=storage_path,
        size_bytes=size_bytes,
        mime_type=mime_type,
        user_id=user_id,
        folder_id=folder_id
    )
    db.add(db_file)
    await db.commit()
    await db.refresh(db_file)
    return db_file


async def get_user_files(db: AsyncSession, user_id: int, folder_id: Optional[int] = None) -> Sequence[models.File]:
    query = select(models.File).where(
        models.File.user_id == user_id,
        models.File.folder_id == folder_id
    )
    result = await db.execute(query)
    return result.scalars().all()


async def get_file_by_id(db: AsyncSession, file_id: int, user_id: int) -> Optional[models.File]:
    query = select(models.File).where(
        models.File.id == file_id,
        models.File.user_id == user_id
    )
    result = await db.execute(query)
    return result.scalars().first()


async def delete_file(db: AsyncSession, file_id: int, user_id: int) -> Optional[models.File]:
    db_file = await get_file_by_id(db, file_id, user_id)
    if not db_file:
        return None
    await db.delete(db_file)
    await db.commit()
    return db_file