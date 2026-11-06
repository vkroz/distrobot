"""Executes one claimed publish job: resolve content/account/files, dry-run vs real, token refresh."""

from __future__ import annotations

import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TypeVar

import httpx

from ..adapters import AdapterError, BaseAdapter, PublishContext, PublishRequest
from ..adapters import get_adapter as default_get_adapter
from ..adapters.types import Thumbnail
from ..db import Database
from ..db import repo
from ..models import ConnectedAccount, PostTarget, PublishJob, now_utc, parse_iso, ts_ms
from ..platforms.validate import resolve_target_content
from ..storage import resolve_storage_path

T = TypeVar("T")

#: Refresh a little before expiry to avoid failing mid-upload.
REFRESH_MARGIN_MS = 5 * 60_000


def dry_run_mode_from_env(env: dict[str, str] | None = None) -> str:
    """on: everything simulated. off: always real. auto: simulated for platforms without OAuth credentials."""
    v = ((os.environ if env is None else env).get("DRY_RUN") or "").strip().lower()
    if v in ("1", "true", "yes", "on"):
        return "on"
    if v in ("0", "false", "no", "off"):
        return "off"
    return "auto"


def should_dry_run(adapter: BaseAdapter, job_dry_run: bool, mode: str) -> bool:
    if job_dry_run or mode == "on":
        return True
    if mode == "off":
        return False
    return not adapter.is_configured()


@dataclass
class RunnerOptions:
    get_adapter: Callable[[str], BaseAdapter] = default_get_adapter
    #: None = read DRY_RUN from the environment at run time.
    dry_run_mode: str | None = None
    #: Simulated latency for dry-run uploads.
    simulated_delay_ms: int | None = None
    upload_dir: str | None = None
    #: HTTP client for adapters (tests inject one with a mock transport).
    client: httpx.AsyncClient | None = None

    def mode(self) -> str:
        return self.dry_run_mode or dry_run_mode_from_env()


def _resolve_account(db: Database, target: PostTarget) -> ConnectedAccount | None:
    if target.account_id:
        return repo.get_account(db, target.account_id)
    accounts = repo.list_accounts(db, target.platform)
    return accounts[0] if accounts else None


async def refresh_account(
    db: Database, adapter: BaseAdapter, account: ConnectedAccount, client: httpx.AsyncClient | None = None
) -> ConnectedAccount:
    t = await adapter.refresh_access_token(account, client)
    return repo.update_account_tokens(db, account.id, access_token=t.access_token, refresh_token=t.refresh_token, expires_at=t.expires_at)


def needs_refresh(account: ConnectedAccount) -> bool:
    exp = ts_ms(account.expires_at)
    return bool(account.refresh_token) and exp is not None and exp - now_utc().timestamp() * 1000 < REFRESH_MARGIN_MS


async def execute_job(db: Database, job: PublishJob, opts: RunnerOptions | None = None) -> PublishJob:
    """Execute an already-claimed (``uploading``) job to completion. Never raises (except cancellation)."""
    opts = opts or RunnerOptions()
    try:
        target = repo.get_target(db, job.target_id)
        post = repo.get_post(db, job.post_id)
        if not target or not post:
            raise AdapterError("validation_failed", "Post or target was deleted")
        media = repo.get_media(db, post.media_id) if post.media_id else None
        if not media:
            raise AdapterError("validation_failed", "Post has no video attached")
        thumb = repo.get_media(db, post.thumbnail_id) if post.thumbnail_id else None

        adapter = opts.get_adapter(job.platform)
        dry_run = should_dry_run(adapter, job.dry_run, opts.mode())
        account = None if dry_run else _resolve_account(db, target)
        if account and needs_refresh(account):
            account = await refresh_account(db, adapter, account, opts.client)

        when = parse_iso(post.scheduled_at)
        scheduled_at = post.scheduled_at if adapter.capabilities.native_scheduling and when and when > now_utc() else None
        req = PublishRequest(
            job_id=job.id,
            content=resolve_target_content(post, target),
            media=media,
            media_path=resolve_storage_path(media.storage_path, opts.upload_dir),
            thumbnail=Thumbnail(
                path=resolve_storage_path(thumb.storage_path, opts.upload_dir),
                mime_type=thumb.mime_type or "image/jpeg",
                size_bytes=thumb.size_bytes or 0,
            )
            if thumb
            else None,
            visibility=post.visibility,
            scheduled_at=scheduled_at,
            settings=target.settings,
            checkpoint=job.checkpoint,
        )

        last_progress = [0.0]

        def on_progress(_phase: str, fraction: float | None) -> None:
            # Throttle DB writes.
            if fraction is None or (time.monotonic() - last_progress[0] < 0.25 and fraction < 1):
                return
            last_progress[0] = time.monotonic()
            repo.update_job_progress(db, job.id, fraction)

        def make_ctx(acct: ConnectedAccount | None) -> PublishContext:
            return PublishContext(
                account=acct,
                dry_run=dry_run,
                simulated_delay_ms=opts.simulated_delay_ms,
                on_progress=on_progress,
                save_checkpoint=lambda data: repo.save_job_checkpoint(db, job.id, data),
                client=opts.client,
            )

        try:
            result = await adapter.publish(req, make_ctx(account))
        except AdapterError as err:
            # One forced refresh + retry on auth failure (token revoked early / clock skew).
            if err.code == "auth_failed" and account and account.refresh_token:
                account = await refresh_account(db, adapter, account, opts.client)
                # The first attempt may have saved a checkpoint; resume from it.
                fresh = repo.get_job(db, job.id)
                req.checkpoint = fresh.checkpoint if fresh else req.checkpoint
                result = await adapter.publish(req, make_ctx(account))
            else:
                raise
        return repo.mark_job_published(
            db,
            job.id,
            url=result.url,
            external_id=result.external_id,
            payload={**result.payload, "dryRun": result.dry_run},
            warnings=result.warnings,
        )
    except Exception as err:  # noqa: BLE001
        # Unknown errors (bugs, fs errors) are retried; adapters decide for their own errors.
        retryable = err.retryable if isinstance(err, AdapterError) else True
        return repo.mark_job_failed(db, job.id, str(err) or type(err).__name__, retryable=retryable)


async def run_next_job(db: Database, opts: RunnerOptions | None = None) -> PublishJob | None:
    """Claim and execute one due job. Returns its final state, or None if nothing was due."""
    job = repo.claim_next_job(db)
    return await execute_job(db, job, opts) if job else None


async def with_fresh_account(
    db: Database,
    adapter: BaseAdapter,
    account: ConnectedAccount,
    call: Callable[[ConnectedAccount], Awaitable[T]],
    client: httpx.AsyncClient | None = None,
) -> T:
    """Run an API call outside the job runner (e.g. compose-time lookups): refresh a token that is
    about to expire, and on ``auth_failed`` refresh once and retry."""
    current = account
    if needs_refresh(current):
        current = await refresh_account(db, adapter, current, client)
    try:
        return await call(current)
    except AdapterError as err:
        if err.code == "auth_failed" and current.refresh_token:
            current = await refresh_account(db, adapter, current, client)
            return await call(current)
        raise

