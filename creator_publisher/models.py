"""Shared domain types and JSON helpers."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

PLATFORM_IDS: tuple[str, ...] = ("youtube", "tiktok", "instagram", "x", "facebook", "linkedin", "vimeo")
JOB_STATUSES: tuple[str, ...] = ("queued", "uploading", "published", "failed")
VISIBILITIES: tuple[str, ...] = ("public", "unlisted", "private")
POST_STATUSES: tuple[str, ...] = ("draft", "scheduled", "publishing", "published", "partial", "failed")


def is_platform_id(value: Any) -> bool:
    return isinstance(value, str) and value in PLATFORM_IDS


# ---------------------------------------------------------------------------
# Time helpers (ISO-8601 UTC with millisecond precision and "Z", sortable as text)
# ---------------------------------------------------------------------------


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


def now_iso() -> str:
    return iso(now_utc())


def parse_iso(value: str | None) -> datetime | None:
    """Parse an ISO timestamp (accepts "Z"). Naive values are treated as UTC. None if invalid."""
    if not value or not isinstance(value, str):
        return None
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def ts_ms(value: str | None) -> float | None:
    dt = parse_iso(value)
    return dt.timestamp() * 1000 if dt else None


# ---------------------------------------------------------------------------
# Entities
# ---------------------------------------------------------------------------


@dataclass
class MediaInfo:
    mime_type: str | None = None
    size_bytes: int | None = None
    duration_sec: float | None = None
    width: int | None = None
    height: int | None = None


@dataclass
class Media(MediaInfo):
    id: str = ""
    kind: str = "video"
    #: "ffprobe" = measured on the server; "client" = reported by the browser; None = unknown.
    metadata_source: str | None = None
    original_filename: str = ""
    storage_path: str = ""
    checksum: str | None = None
    created_at: str = ""


@dataclass
class Post:
    id: str
    title: str
    caption: str
    hashtags: list[str]
    media_id: str | None
    thumbnail_id: str | None
    visibility: str
    status: str
    scheduled_at: str | None
    created_at: str
    updated_at: str


@dataclass
class PostTarget:
    """Per-platform destination for a post. ``None`` overrides fall back to the post's defaults."""

    id: str
    post_id: str
    platform: str
    account_id: str | None
    enabled: bool
    title_override: str | None
    caption_override: str | None
    hashtags_override: list[str] | None
    settings: dict[str, Any]
    created_at: str
    updated_at: str


@dataclass
class PublishJob:
    id: str
    post_id: str
    target_id: str
    platform: str
    status: str
    attempts: int
    max_attempts: int
    dry_run: bool
    progress: float | None
    checkpoint: Any
    result_url: str | None
    result_payload: Any
    external_id: str | None
    error: str | None
    next_run_at: str | None
    started_at: str | None
    finished_at: str | None
    created_at: str
    updated_at: str


@dataclass
class ConnectedAccount:
    id: str
    platform: str
    external_id: str
    display_name: str
    access_token: str
    refresh_token: str | None
    expires_at: str | None
    scopes: list[str]
    metadata: dict[str, Any]
    created_at: str
    updated_at: str


@dataclass
class TargetContent:
    """Fully resolved content for one platform (post defaults + target overrides)."""

    title: str = ""
    caption: str = ""
    hashtags: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# JSON conversion: dataclass fields become camelCase; plain dict keys are left untouched
# (they hold API-shaped or user-provided data such as target settings and checkpoints).
# ---------------------------------------------------------------------------


def camel(name: str) -> str:
    head, *rest = name.split("_")
    return head + "".join(p[:1].upper() + p[1:] for p in rest)


def to_api(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {camel(f.name): to_api(getattr(value, f.name)) for f in dataclasses.fields(value)}
    if isinstance(value, dict):
        return {k: to_api(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_api(v) for v in value]
    return value
