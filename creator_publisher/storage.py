"""Local file storage for uploads (default ./data/uploads)."""

from __future__ import annotations

import hashlib
import os
import re
import uuid
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path

_SAFE_EXT = re.compile(r"^\.[a-z0-9]{1,8}$")
#: Extensions we keep for stored files; anything else is stored without an extension.
KEEP_EXT = {".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".wmv", ".flv", ".3gp", ".jpg", ".jpeg", ".png", ".webp"}


class UploadTooLarge(Exception):
    pass


def upload_dir() -> str:
    return str(Path(os.environ.get("UPLOAD_DIR") or Path.cwd() / "data" / "uploads").resolve())


@dataclass
class StoredFile:
    #: Path relative to the upload dir (what we persist in the DB).
    storage_path: str
    size_bytes: int
    checksum: str


async def save_stream(
    chunks: AsyncIterator[bytes], original_filename: str, *, max_bytes: int | None = None, directory: str | None = None
) -> StoredFile:
    """Stream chunks to disk (never buffering the whole file), hashing as it goes."""
    base = directory or upload_dir()
    ext = os.path.splitext(original_filename)[1].lower()
    name = f"{uuid.uuid4()}{ext if _SAFE_EXT.match(ext) and ext in KEEP_EXT else ''}"
    # Shard by first two chars to keep directories small.
    rel = os.path.join(name[:2], name)
    abs_path = os.path.join(base, rel)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    digest = hashlib.sha256()
    size = 0
    try:
        with open(abs_path, "wb") as fh:
            async for chunk in chunks:
                if not chunk:
                    continue
                size += len(chunk)
                if max_bytes is not None and size > max_bytes:
                    raise UploadTooLarge(f"Upload exceeds {max_bytes} bytes")
                digest.update(chunk)
                fh.write(chunk)
    except BaseException:
        Path(abs_path).unlink(missing_ok=True)
        raise
    return StoredFile(storage_path=rel, size_bytes=size, checksum=digest.hexdigest())


def resolve_storage_path(storage_path: str, directory: str | None = None) -> str:
    """Resolve a stored relative path, refusing anything that escapes the upload dir."""
    base = os.path.realpath(directory or upload_dir())
    abs_path = os.path.realpath(os.path.join(base, storage_path))
    if not abs_path.startswith(base + os.sep):
        raise ValueError("Invalid storage path")
    return abs_path


def delete_stored_file(storage_path: str, directory: str | None = None) -> None:
    try:
        Path(resolve_storage_path(storage_path, directory)).unlink(missing_ok=True)
    except (OSError, ValueError):
        pass
