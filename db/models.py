from datetime import datetime
from typing import Optional, List
from sqlalchemy import BigInteger, ForeignKey, String, DateTime, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from db.database import Base


class User(Base):
    __tablename__ = 'users'

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True, nullable=False)
    username: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    first_name: Mapped[str] = mapped_column(String(64), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    folders: Mapped[List["Folder"]] = relationship('Folder', back_populates='user', cascade='all, delete-orphan')
    files: Mapped[List["File"]] = relationship('File', back_populates='user', cascade='all, delete-orphan')


class Folder(Base):
    __tablename__ = 'folders'

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    parent_id: Mapped[Optional[int]] = mapped_column(ForeignKey('folders.id', ondelete='CASCADE'), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    user: Mapped["User"] = relationship('User', back_populates='folders')
    parent: Mapped[Optional["Folder"]] = relationship('Folder', remote_side=[id], back_populates='subfolders')
    subfolders: Mapped[List["Folder"]] = relationship('Folder', back_populates='parent', cascade='all, delete-orphan')
    files: Mapped[List["File"]] = relationship('File', back_populates='folder', cascade='all, delete-orphan')


class File(Base):
    __tablename__ = 'files'

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(255), nullable=False)
    storage_path: Mapped[str] = mapped_column(String(512), nullable=False)
    size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    mime_type: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    
    user_id: Mapped[int] = mapped_column(ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
    folder_id: Mapped[Optional[int]] = mapped_column(ForeignKey('folders.id', ondelete='CASCADE'), nullable=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())

    user: Mapped["User"] = relationship("User", back_populates='files')
    folder: Mapped[Optional["Folder"]] = relationship('Folder', back_populates='files')