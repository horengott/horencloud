
import os
import uuid
import boto3
import asyncio
import hmac
import hashlib
import json
from urllib.parse import unquote, parse_qsl
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, Depends, HTTPException, status, UploadFile, File, Form
from fastapi.responses import FileResponse, RedirectResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
import jwt
import schemas
from db import crud
from db import models
from db.database import get_db, engine, Base
from contextlib import asynccontextmanager
from bot.main import bot, dp

BOT_TOKEN = os.getenv("BOT_TOKEN")
JWT_SECRET = os.getenv("JWT_SECRET", "default_horencloud_fallback_jwt_secret_key_2026_99x")
ALGORITHM = "HS256"
STORAGE_LIMIT_BYTES = 10 * 1024 * 1024 * 1024

R2_ENDPOINT_URL = os.getenv("ENDPOINT_URL")
R2_ACCESS_KEY_ID = os.getenv("KEY_ID")
R2_SECRET_ACCESS_KEY = os.getenv("SECRET_ACCESS_KEY")
R2_BUCKET_NAME = os.getenv("BUCKET_NAME")

s3_client = boto3.client(
    service_name="s3",
    endpoint_url=R2_ENDPOINT_URL,
    aws_access_key_id=R2_ACCESS_KEY_ID,
    aws_secret_access_key=R2_SECRET_ACCESS_KEY,
    region_name="auto"
)

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="auth")


def validate_telegram_data(init_data: str) -> dict:
    try:
        parsed_data = dict(parse_qsl(init_data, keep_blank_values=True))
        hash_val = parsed_data.pop("hash", None)

        if not hash_val or not BOT_TOKEN:
            return {}

        data_check_string = "\n".join(
            f"{key}={parsed_data[key]}"
            for key in sorted(parsed_data)
        )

        secret_key = hmac.new(
            b"WebAppData",
            BOT_TOKEN.encode(),
            hashlib.sha256
        ).digest()

        calculated_hash = hmac.new(
            secret_key,
            data_check_string.encode(),
            hashlib.sha256
        ).hexdigest()

        if not hmac.compare_digest(calculated_hash, hash_val):
            return {}

        return json.loads(parsed_data.get("user", "{}"))
    except (ValueError, TypeError, json.JSONDecodeError):
        return {}


def create_access_token(data: dict) -> str:
    to_encode = data.copy()
    to_encode.update({
        "exp": datetime.now(timezone.utc) + timedelta(days=7)
    })
    return jwt.encode(to_encode, JWT_SECRET, algorithm=ALGORITHM)


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db_session: AsyncSession = Depends(get_db)
) -> models.User:
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[ALGORITHM])
        user_id = payload.get("sub")

        if user_id is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid authentication credentials"
            )

        user = await crud.get_user_by_telegram_id(db_session, int(user_id))

        if user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found"
            )

        return user
    except (jwt.PyJWTError, ValueError, TypeError):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid authentication credentials"
        )


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    polling_task = asyncio.create_task(dp.start_polling(bot))
    try:
        yield
    finally:
        polling_task.cancel()
        try:
            await polling_task
        except asyncio.CancelledError:
            pass


app = FastAPI(lifespan=lifespan)


def make_presigned_url(key: str, expires: int = 604800) -> str:
    return s3_client.generate_presigned_url(
        "get_object",
        Params={"Bucket": R2_BUCKET_NAME, "Key": key},
        ExpiresIn=expires
    )


def delete_storage_object(key: str | None) -> None:
    if not key or key.startswith("http://") or key.startswith("https://"):
        return

    s3_client.delete_object(
        Bucket=R2_BUCKET_NAME,
        Key=key
    )


async def get_owned_folder(
    db_session: AsyncSession,
    folder_id: int,
    user_id: int
) -> models.Folder:
    folder = await crud.get_folder_by_id(db_session, folder_id, user_id)

    if folder is None:
        raise HTTPException(status_code=404, detail="Folder not found")

    return folder


async def get_owned_parent(
    db_session: AsyncSession,
    parent_id: int | None,
    user_id: int
) -> models.Folder | None:
    if parent_id is None:
        return None

    parent = await crud.get_folder_by_id(db_session, parent_id, user_id)

    if parent is None:
        raise HTTPException(status_code=404, detail="Parent folder not found")

    return parent


async def collect_folder_tree(
    db_session: AsyncSession,
    folder_id: int,
    user_id: int
) -> tuple[list[models.Folder], list[models.File]]:
    folders_result = await db_session.execute(
        select(models.Folder).where(models.Folder.user_id == user_id)
    )
    all_folders = list(folders_result.scalars().all())

    files_result = await db_session.execute(
        select(models.File).where(models.File.user_id == user_id)
    )
    all_files = list(files_result.scalars().all())

    folders_by_parent = {}

    for folder in all_folders:
        folders_by_parent.setdefault(folder.parent_id, []).append(folder)

    folder_ids = set()
    pending = [folder_id]

    while pending:
        current_id = pending.pop()

        if current_id in folder_ids:
            continue

        folder_ids.add(current_id)

        for child in folders_by_parent.get(current_id, []):
            pending.append(child.id)

    selected_folders = [
        folder for folder in all_folders
        if folder.id in folder_ids
    ]

    selected_files = [
        file for file in all_files
        if file.folder_id in folder_ids
    ]

    return selected_folders, selected_files


@app.get("/")
async def serve_frontend():
    return FileResponse("frontend/index.html")


@app.post("/auth", response_model=schemas.Token)
async def auth_telegram(
    auth_data: schemas.TelegramAuth,
    db_session: AsyncSession = Depends(get_db)
):
    user_data = validate_telegram_data(auth_data.init_data)

    if not user_data or not user_data.get("id"):
        raise HTTPException(
            status_code=401,
            detail="Invalid Telegram data"
        )

    user = await crud.get_or_create_user(
        db_session,
        telegram_id=user_data.get("id"),
        first_name=user_data.get("first_name") or "User",
        username=user_data.get("username")
    )

    access_token = create_access_token({
        "sub": str(user.telegram_id)
    })

    return {
        "access_token": access_token,
        "token_type": "bearer"
    }


@app.get("/users/me")
async def get_me(
    current_user: models.User = Depends(get_current_user)
):
    return {
        "id": current_user.id,
        "telegram_id": current_user.telegram_id,
        "first_name": current_user.first_name,
        "username": current_user.username
    }


@app.get("/storage")
@app.get("/storage/usage")
async def get_storage_usage(
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    result = await db_session.execute(
        select(func.coalesce(func.sum(models.File.size_bytes), 0)).where(
            models.File.user_id == current_user.id
        )
    )

    used_bytes = int(result.scalar_one() or 0)

    return {
        "used_bytes": used_bytes,
        "total_bytes": STORAGE_LIMIT_BYTES,
        "available_bytes": max(0, STORAGE_LIMIT_BYTES - used_bytes),
        "used_gb": round(used_bytes / (1024 ** 3), 3),
        "total_gb": 10,
        "available_gb": round(
            max(0, STORAGE_LIMIT_BYTES - used_bytes) / (1024 ** 3),
            3
        ),
        "usage_percent": round(
            min(100, used_bytes / STORAGE_LIMIT_BYTES * 100),
            2
        )
    }


@app.post("/folders", response_model=schemas.FolderResponse)
async def create_folder(
    name: str = Form(...),
    parent_id: int | None = Form(None),
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    name = name.strip()

    if not name:
        raise HTTPException(status_code=422, detail="Folder name is required")

    await get_owned_parent(db_session, parent_id, current_user.id)

    folder_data = schemas.FolderCreate(
        name=name,
        parent_id=parent_id
    )

    folder = await crud.create_folder(
        db_session,
        current_user.id,
        folder_data
    )

    return {
        "id": folder.id,
        "name": folder.name,
        "cover_url": None,
        "parent_id": folder.parent_id,
        "created_at": folder.created_at
    }


@app.get("/folders", response_model=list[schemas.FolderResponse])
async def get_folders(
    parent_id: int | None = None,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    await get_owned_parent(db_session, parent_id, current_user.id)

    folders = await crud.get_user_folders(
        db_session,
        current_user.id,
        parent_id
    )

    return [
        {
            "id": folder.id,
            "name": folder.name,
            "cover_url": (
                make_presigned_url(folder.cover_url)
                if folder.cover_url else None
            ),
            "parent_id": folder.parent_id,
            "created_at": folder.created_at
        }
        for folder in folders
    ]


@app.patch("/folders/{folder_id}")
@app.put("/folders/{folder_id}")
async def update_folder(
    folder_id: int,
    name: str | None = Form(None),
    parent_id: int | None = Form(None),
    cover_file_id: int | None = Form(None),
    cover: UploadFile | None = File(None),
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    folder = await get_owned_folder(
        db_session,
        folder_id,
        current_user.id
    )

    if name is not None:
        cleaned_name = name.strip()

        if not cleaned_name:
            raise HTTPException(
                status_code=422,
                detail="Folder name is required"
            )

        folder.name = cleaned_name

    if parent_id is not None:
        if parent_id == folder_id:
            raise HTTPException(
                status_code=400,
                detail="A folder cannot be its own parent"
            )

        await get_owned_parent(
            db_session,
            parent_id,
            current_user.id
        )

        descendants, _ = await collect_folder_tree(
            db_session,
            folder_id,
            current_user.id
        )

        if any(item.id == parent_id for item in descendants):
            raise HTTPException(
                status_code=400,
                detail="A folder cannot be moved into its own descendant"
            )

        folder.parent_id = parent_id

    new_cover_key = None

    if cover_file_id is not None:
        cover_file = await crud.get_file_by_id(
            db_session,
            cover_file_id,
            current_user.id
        )

        if not cover_file:
            raise HTTPException(
                status_code=404,
                detail="Cover file not found"
            )

        new_cover_key = cover_file.storage_path

    elif cover is not None:
        extension = os.path.splitext(cover.filename or "")[1]
        new_cover_key = (
            f"user_{current_user.telegram_id}/covers/{uuid.uuid4()}{extension}"
        )

        try:
            s3_client.upload_fileobj(
                cover.file,
                R2_BUCKET_NAME,
                new_cover_key,
                ExtraArgs={
                    "ContentType": cover.content_type or "image/jpeg"
                }
            )
        except Exception as error:
            raise HTTPException(
                status_code=500,
                detail=f"Cover upload failed: {str(error)}"
            )

    if cover_file_id is not None or cover is not None:
        old_cover_key = folder.cover_url

        if old_cover_key and old_cover_key != new_cover_key:
            try:
                delete_storage_object(old_cover_key)
            except Exception:
                pass

        folder.cover_url = new_cover_key

    await db_session.commit()
    await db_session.refresh(folder)

    return {
        "id": folder.id,
        "name": folder.name,
        "cover_url": (
            make_presigned_url(folder.cover_url)
            if folder.cover_url else None
        ),
        "parent_id": folder.parent_id,
        "created_at": folder.created_at
    }


@app.delete("/folders/{folder_id}/cover")
async def remove_folder_cover(
    folder_id: int,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    folder = await get_owned_folder(
        db_session,
        folder_id,
        current_user.id
    )

    old_cover_key = folder.cover_url
    folder.cover_url = None

    await db_session.commit()

    if old_cover_key:
        try:
            delete_storage_object(old_cover_key)
        except Exception:
            pass

    return {"status": "cover_removed"}


@app.post("/files", response_model=schemas.FileResponse)
async def upload_file(
    file: UploadFile = File(...),
    folder_id: int | None = Form(None),
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    if folder_id is not None:
        await get_owned_folder(
            db_session,
            folder_id,
            current_user.id
        )

    file.file.seek(0, os.SEEK_END)
    file_size = file.file.tell()
    file.file.seek(0)

    usage_result = await db_session.execute(
        select(func.coalesce(func.sum(models.File.size_bytes), 0)).where(
            models.File.user_id == current_user.id
        )
    )

    used_bytes = int(usage_result.scalar_one() or 0)

    if used_bytes + file_size > STORAGE_LIMIT_BYTES:
        raise HTTPException(
            status_code=413,
            detail="Storage limit of 10 GB exceeded"
        )

    extension = os.path.splitext(file.filename or "")[1]

    if folder_id is not None:
        file_key = (
            f"user_{current_user.telegram_id}/folder_{folder_id}/"
            f"{uuid.uuid4()}{extension}"
        )
    else:
        file_key = (
            f"user_{current_user.telegram_id}/root/"
            f"{uuid.uuid4()}{extension}"
        )

    try:
        s3_client.upload_fileobj(
            file.file,
            R2_BUCKET_NAME,
            file_key,
            ExtraArgs={
                "ContentType": file.content_type or "application/octet-stream"
            }
        )
    except Exception as error:
        raise HTTPException(
            status_code=500,
            detail=f"File upload failed: {str(error)}"
        )

    try:
        db_file = await crud.create_file(
            db_session,
            user_id=current_user.id,
            name=file.filename or "file",
            storage_path=file_key,
            size_bytes=file_size,
            mime_type=file.content_type,
            folder_id=folder_id
        )
    except Exception:
        try:
            delete_storage_object(file_key)
        except Exception:
            pass
        raise

    return {
        "id": db_file.id,
        "name": db_file.name,
        "size_bytes": db_file.size_bytes,
        "mime_type": db_file.mime_type,
        "folder_id": db_file.folder_id,
        "created_at": db_file.created_at
    }


@app.get("/files")
async def get_files(
    folder_id: int | None = None,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    if folder_id is not None:
        await get_owned_folder(
            db_session,
            folder_id,
            current_user.id
        )

    files = await crud.get_user_files(
        db_session,
        user_id=current_user.id,
        folder_id=folder_id
    )

    return [
        {
            "id": file.id,
            "name": file.name,
            "storage_path": (
                make_presigned_url(file.storage_path)
                if file.storage_path and not file.storage_path.startswith(
                    ("http://", "https://")
                )
                else file.storage_path
            ),
            "size_bytes": file.size_bytes,
            "mime_type": file.mime_type,
            "folder_id": file.folder_id,
            "created_at": file.created_at
        }
        for file in files
    ]


@app.get("/files/{file_id}/download")
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
            detail="File not found"
        )

    url = s3_client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": R2_BUCKET_NAME,
            "Key": db_file.storage_path,
            "ResponseContentDisposition": (
                "attachment; filename*=UTF-8''"
                + __import__("urllib.parse", fromlist=["quote"]).quote(
                    db_file.name
                )
            )
        },
        ExpiresIn=3600
    )

    return RedirectResponse(url=url, status_code=307)


@app.delete("/files/{file_id}")
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
            detail="File not found"
        )

    storage_key = db_file.storage_path

    try:
        delete_storage_object(storage_key)
    except Exception as error:
        raise HTTPException(
            status_code=502,
            detail=f"Could not delete file from object storage: {str(error)}"
        )

    deleted = await crud.delete_file(
        db_session,
        file_id,
        current_user.id
    )

    if not deleted:
        raise HTTPException(
            status_code=404,
            detail="File not found"
        )

    return {"status": "deleted"}


@app.delete("/folders/{folder_id}")
async def delete_folder(
    folder_id: int,
    current_user: models.User = Depends(get_current_user),
    db_session: AsyncSession = Depends(get_db)
):
    folder = await crud.get_folder_by_id(
        db_session,
        folder_id,
        current_user.id
    )

    if not folder:
        raise HTTPException(
            status_code=404,
            detail="Folder not found"
        )

    folders, files = await collect_folder_tree(
        db_session,
        folder_id,
        current_user.id
    )

    storage_keys = set()

    for file in files:
        if file.storage_path:
            storage_keys.add(file.storage_path)

    for item in folders:
        if item.cover_url:
            storage_keys.add(item.cover_url)

    failures = []

    for key in storage_keys:
        try:
            delete_storage_object(key)
        except Exception as error:
            failures.append(str(error))

    if failures:
        raise HTTPException(
            status_code=502,
            detail={
                "message": "Could not delete all objects from storage",
                "errors": failures
            }
        )

    success = await crud.delete_folder(
        db_session,
        folder_id,
        current_user.id
    )

    if not success:
        raise HTTPException(
            status_code=404,
            detail="Folder not found"
        )

    return {
        "status": "deleted",
        "folders_deleted": len(folders),
        "files_deleted": len(files)
    }


app.mount(
    "/",
    StaticFiles(directory="frontend", html=True),
    name="frontend"
)
