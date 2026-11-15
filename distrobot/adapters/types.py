"""Adapter interface types."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import httpx

from ..models import ConnectedAccount, Media, TargetContent


@dataclass
class Thumbnail:
    path: str
    mime_type: str
    size_bytes: int


@dataclass
class PublishRequest:
    job_id: str
    content: TargetContent
    media: Media
    #: Absolute path to the video file on local disk.
    media_path: str
    visibility: str
    #: Platform-specific target settings (privacy, category, page id, ...).
    settings: dict[str, Any] = field(default_factory=dict)
    thumbnail: Thumbnail | None = None
    #: ISO time the post should go live. Only set for adapters with ``capabilities.native_scheduling``.
    scheduled_at: str | None = None
    #: Resume state saved by a previous attempt via ``ctx.save_checkpoint``.
    checkpoint: Any = None


@dataclass
class PublishContext:
    account: ConnectedAccount | None
    #: Validate and simulate only — never calls the platform API.
    dry_run: bool
    #: Simulated latency for dry-run publishes (ms).
    simulated_delay_ms: int | None = None
    #: Called with (phase, fraction|None); phase is "uploading" or "processing".
    on_progress: Callable[[str, float | None], None] | None = None
    #: Persist resume state (e.g. an upload session URL) so a retry can continue.
    save_checkpoint: Callable[[Any], None] | None = None
    #: HTTP client (tests inject one with a mock transport).
    client: httpx.AsyncClient | None = None

    def progress(self, phase: str, fraction: float | None = None) -> None:
        if self.on_progress:
            self.on_progress(phase, fraction)

    def checkpoint(self, data: Any) -> None:
        if self.save_checkpoint:
            self.save_checkpoint(data)


@dataclass
class PublishResult:
    url: str | None
    external_id: str | None
    dry_run: bool
    #: What was (or would have been) sent.
    payload: dict[str, Any]
    warnings: list[str]


@dataclass
class DoPublishResult:
    """What a concrete adapter's real upload returns (BaseAdapter adds payload/warnings/dry_run)."""

    url: str | None
    external_id: str | None
    warnings: list[str] = field(default_factory=list)
    #: Extra platform-specific fields to record (e.g. YouTube publishAt).
    extra: dict[str, Any] = field(default_factory=dict)


@dataclass
class Capabilities:
    pkce: bool
    refresh_tokens: bool
    #: Has a real (non-dry-run) publish implementation.
    publish: bool
    #: Platform schedules natively (upload now, goes live at ``scheduled_at``).
    native_scheduling: bool
    #: Supports setting a custom thumbnail.
    thumbnail: bool


@dataclass
class AccountCredentials:
    """Credentials + identity returned by OAuth; persisted as a ConnectedAccount."""

    platform: str
    external_id: str
    display_name: str
    access_token: str
    refresh_token: str | None
    expires_at: str | None
    scopes: list[str]
    metadata: dict[str, Any]


@dataclass
class RefreshedTokens:
    access_token: str
    refresh_token: str | None
    expires_at: str | None


ERROR_CODES = (
    "not_configured",
    "not_implemented",
    "no_account",
    "validation_failed",
    "auth_failed",
    "rate_limited",
    "quota_exceeded",
    "upstream_error",
    "aborted",
)


class AdapterError(Exception):
    def __init__(self, code: str, message: str, retryable: bool = False, details: Any = None):
        super().__init__(message)
        self.code = code
        self.message = message
        #: Whether the job runner should retry automatically.
        self.retryable = retryable
        self.details = details
