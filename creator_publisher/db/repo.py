"""Repository: row mapping and all SQL for posts, targets, media, accounts, jobs and OAuth state."""

from __future__ import annotations

import json
import sqlite3
import uuid
from collections.abc import Callable, Iterable
from datetime import datetime, timedelta
from typing import Any

from ..jobs.state import assert_transition, derive_post_status, retry_delay_ms
from ..models import ConnectedAccount, Media, Post, PostTarget, PublishJob, iso, now_iso, now_utc, ts_ms
from . import Database

_UNSET: Any = object()


def _json(v: Any) -> str:
    return json.dumps(v, ensure_ascii=False, separators=(",", ":"))


def _parse(v: Any, fallback: Any) -> Any:
    return json.loads(v) if isinstance(v, str) else fallback


def _new_id() -> str:
    return str(uuid.uuid4())


# ---------------------------------------------------------------------------
# Row mappers
# ---------------------------------------------------------------------------


def to_media(r: sqlite3.Row) -> Media:
    return Media(
        id=r["id"],
        kind=r["kind"] or "video",
        metadata_source=r["metadata_source"],
        original_filename=r["original_filename"],
        storage_path=r["storage_path"],
        mime_type=r["mime_type"],
        size_bytes=r["size_bytes"],
        duration_sec=r["duration_sec"],
        width=r["width"],
        height=r["height"],
        checksum=r["checksum"],
        created_at=r["created_at"],
    )


def to_post(r: sqlite3.Row) -> Post:
    return Post(
        id=r["id"],
        title=r["title"],
        caption=r["caption"],
        hashtags=_parse(r["hashtags"], []),
        media_id=r["media_id"],
        thumbnail_id=r["thumbnail_id"],
        visibility=r["visibility"] or "public",
        status=r["status"],
        scheduled_at=r["scheduled_at"],
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


def to_target(r: sqlite3.Row) -> PostTarget:
    return PostTarget(
        id=r["id"],
        post_id=r["post_id"],
        platform=r["platform"],
        account_id=r["account_id"],
        enabled=r["enabled"] == 1,
        title_override=r["title_override"],
        caption_override=r["caption_override"],
        hashtags_override=_parse(r["hashtags_override"], None),
        settings=_parse(r["settings"], {}),
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


def to_job(r: sqlite3.Row) -> PublishJob:
    return PublishJob(
        id=r["id"],
        post_id=r["post_id"],
        target_id=r["target_id"],
        platform=r["platform"],
        status=r["status"],
        attempts=r["attempts"],
        max_attempts=r["max_attempts"],
        dry_run=r["dry_run"] == 1,
        progress=r["progress"],
        checkpoint=_parse(r["checkpoint"], None),
        result_url=r["result_url"],
        result_payload=_parse(r["result_payload"], None),
        external_id=r["external_id"],
        error=r["error"],
        next_run_at=r["next_run_at"],
        started_at=r["started_at"],
        finished_at=r["finished_at"],
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


def to_account(r: sqlite3.Row) -> ConnectedAccount:
    return ConnectedAccount(
        id=r["id"],
        platform=r["platform"],
        external_id=r["external_id"],
        display_name=r["display_name"],
        access_token=r["access_token"],
        refresh_token=r["refresh_token"],
        expires_at=r["expires_at"],
        scopes=_parse(r["scopes"], []),
        metadata=_parse(r["metadata"], {}),
        created_at=r["created_at"],
        updated_at=r["updated_at"],
    )


def _one(db: Database, mapper: Callable[[sqlite3.Row], Any], sql: str, *params: Any) -> Any:
    row = db.one(sql, params)
    return mapper(row) if row else None


def _many(db: Database, mapper: Callable[[sqlite3.Row], Any], sql: str, *params: Any) -> list[Any]:
    return [mapper(r) for r in db.all(sql, params)]


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------


def create_media(
    db: Database,
    *,
    original_filename: str,
    storage_path: str,
    kind: str = "video",
    mime_type: str | None = None,
    size_bytes: int | None = None,
    duration_sec: float | None = None,
    width: int | None = None,
    height: int | None = None,
    checksum: str | None = None,
    metadata_source: str | None = None,
) -> Media:
    mid = _new_id()
    db.execute(
        """INSERT INTO media (id, kind, metadata_source, original_filename, storage_path, mime_type, size_bytes,
             duration_sec, width, height, checksum, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (mid, kind, metadata_source, original_filename, storage_path, mime_type, size_bytes, duration_sec, width, height, checksum, now_iso()),
    )
    return get_media(db, mid)


def get_media(db: Database, mid: str) -> Media | None:
    return _one(db, to_media, "SELECT * FROM media WHERE id = ?", mid)


# ---------------------------------------------------------------------------
# Posts
# ---------------------------------------------------------------------------

_POST_FIELDS = ("title", "caption", "hashtags", "media_id", "thumbnail_id", "visibility", "scheduled_at")


def create_post(db: Database, **fields: Any) -> Post:
    pid = _new_id()
    ts = now_iso()
    db.execute(
        """INSERT INTO posts (id, title, caption, hashtags, media_id, thumbnail_id, visibility, status, scheduled_at,
             created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)""",
        (
            pid,
            fields.get("title") or "",
            fields.get("caption") or "",
            _json(fields.get("hashtags") or []),
            fields.get("media_id"),
            fields.get("thumbnail_id"),
            fields.get("visibility") or "public",
            fields.get("scheduled_at"),
            ts,
            ts,
        ),
    )
    return get_post(db, pid)


def get_post(db: Database, pid: str) -> Post | None:
    return _one(db, to_post, "SELECT * FROM posts WHERE id = ?", pid)


def list_posts(db: Database, limit: int = 100) -> list[Post]:
    return _many(db, to_post, "SELECT * FROM posts ORDER BY created_at DESC, rowid DESC LIMIT ?", limit)


def update_post(db: Database, pid: str, **fields: Any) -> Post:
    existing = get_post(db, pid)
    if not existing:
        raise KeyError(f"Post {pid} not found")
    merged = {k: fields.get(k, getattr(existing, k)) for k in _POST_FIELDS}
    db.execute(
        """UPDATE posts SET title = ?, caption = ?, hashtags = ?, media_id = ?, thumbnail_id = ?, visibility = ?,
             scheduled_at = ?, updated_at = ? WHERE id = ?""",
        (
            merged["title"],
            merged["caption"],
            _json(merged["hashtags"]),
            merged["media_id"],
            merged["thumbnail_id"],
            merged["visibility"],
            merged["scheduled_at"],
            now_iso(),
            pid,
        ),
    )
    return get_post(db, pid)


def delete_post(db: Database, pid: str) -> None:
    db.execute("DELETE FROM posts WHERE id = ?", (pid,))


# ---------------------------------------------------------------------------
# Targets
# ---------------------------------------------------------------------------


def upsert_target(
    db: Database,
    post_id: str,
    platform: str,
    *,
    account_id: Any = _UNSET,
    enabled: Any = _UNSET,
    title_override: Any = _UNSET,
    caption_override: Any = _UNSET,
    hashtags_override: Any = _UNSET,
    settings: Any = _UNSET,
) -> PostTarget:
    """Create or update the target for (post, platform). Omitted fields keep their current value."""
    existing = _one(db, to_target, "SELECT * FROM post_targets WHERE post_id = ? AND platform = ?", post_id, platform)

    def pick(value: Any, attr: str, default: Any) -> Any:
        if value is not _UNSET:
            return value
        return getattr(existing, attr) if existing else default

    m = {
        "account_id": pick(account_id, "account_id", None),
        "enabled": pick(enabled, "enabled", True),
        "title_override": pick(title_override, "title_override", None),
        "caption_override": pick(caption_override, "caption_override", None),
        "hashtags_override": pick(hashtags_override, "hashtags_override", None),
        "settings": pick(settings, "settings", {}) or {},
    }
    ts = now_iso()
    values = (
        m["account_id"],
        1 if m["enabled"] else 0,
        m["title_override"],
        m["caption_override"],
        _json(m["hashtags_override"]) if m["hashtags_override"] is not None else None,
        _json(m["settings"]),
    )
    if existing:
        db.execute(
            """UPDATE post_targets SET account_id = ?, enabled = ?, title_override = ?, caption_override = ?,
                 hashtags_override = ?, settings = ?, updated_at = ? WHERE id = ?""",
            (*values, ts, existing.id),
        )
        return get_target(db, existing.id)
    tid = _new_id()
    db.execute(
        """INSERT INTO post_targets (id, post_id, platform, account_id, enabled, title_override, caption_override,
             hashtags_override, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (tid, post_id, platform, *values, ts, ts),
    )
    return get_target(db, tid)


def get_target(db: Database, tid: str) -> PostTarget | None:
    return _one(db, to_target, "SELECT * FROM post_targets WHERE id = ?", tid)


def list_targets(db: Database, post_id: str) -> list[PostTarget]:
    return _many(db, to_target, "SELECT * FROM post_targets WHERE post_id = ? ORDER BY created_at, rowid", post_id)


# ---------------------------------------------------------------------------
# Connected accounts
# ---------------------------------------------------------------------------


def upsert_account(
    db: Database,
    *,
    platform: str,
    external_id: str,
    display_name: str,
    access_token: str,
    refresh_token: str | None = None,
    expires_at: str | None = None,
    scopes: list[str] | None = None,
    metadata: dict[str, Any] | None = None,
) -> ConnectedAccount:
    """Insert or refresh credentials for (platform, external_id)."""
    ts = now_iso()
    db.execute(
        """INSERT INTO connected_accounts (id, platform, external_id, display_name, access_token, refresh_token, expires_at,
             scopes, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (platform, external_id) DO UPDATE SET
             display_name = excluded.display_name, access_token = excluded.access_token,
             refresh_token = COALESCE(excluded.refresh_token, connected_accounts.refresh_token),
             expires_at = excluded.expires_at, scopes = excluded.scopes, metadata = excluded.metadata,
             updated_at = excluded.updated_at""",
        (_new_id(), platform, external_id, display_name, access_token, refresh_token, expires_at, _json(scopes or []), _json(metadata or {}), ts, ts),
    )
    return _one(db, to_account, "SELECT * FROM connected_accounts WHERE platform = ? AND external_id = ?", platform, external_id)


def update_account_tokens(
    db: Database, aid: str, *, access_token: str, refresh_token: str | None, expires_at: str | None
) -> ConnectedAccount:
    db.execute(
        "UPDATE connected_accounts SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?",
        (access_token, refresh_token, expires_at, now_iso(), aid),
    )
    return get_account(db, aid)


def get_account(db: Database, aid: str) -> ConnectedAccount | None:
    return _one(db, to_account, "SELECT * FROM connected_accounts WHERE id = ?", aid)


def list_accounts(db: Database, platform: str | None = None) -> list[ConnectedAccount]:
    if platform:
        return _many(db, to_account, "SELECT * FROM connected_accounts WHERE platform = ? ORDER BY updated_at DESC", platform)
    return _many(db, to_account, "SELECT * FROM connected_accounts ORDER BY platform, created_at")


def delete_account(db: Database, aid: str) -> None:
    db.execute("DELETE FROM connected_accounts WHERE id = ?", (aid,))


# ---------------------------------------------------------------------------
# Publish jobs
# ---------------------------------------------------------------------------


def get_job(db: Database, jid: str) -> PublishJob | None:
    return _one(db, to_job, "SELECT * FROM publish_jobs WHERE id = ?", jid)


def list_jobs(db: Database, post_id: str) -> list[PublishJob]:
    return _many(db, to_job, "SELECT * FROM publish_jobs WHERE post_id = ? ORDER BY created_at, rowid", post_id)


def list_recent_jobs(db: Database, limit: int = 200) -> list[PublishJob]:
    return _many(db, to_job, "SELECT * FROM publish_jobs ORDER BY created_at DESC LIMIT ?", limit)


def enqueue_publish(
    db: Database,
    post_id: str,
    *,
    dry_run: bool = False,
    max_attempts: int = 3,
    run_at_for: Callable[[PostTarget, Post], str] | None = None,
) -> list[PublishJob]:
    """Create one queued job per enabled target that doesn't already have an active or published job.

    ``run_at_for`` decides when each target's job becomes due (default: the post's scheduled_at, or now).
    """
    with db.transaction():
        ts = now_iso()
        post = get_post(db, post_id)
        if not post:
            raise KeyError(f"Post {post_id} not found")
        run_at = run_at_for or (lambda _t, p: p.scheduled_at or ts)
        created: list[PublishJob] = []
        for t in list_targets(db, post_id):
            if not t.enabled:
                continue
            if db.one("SELECT 1 FROM publish_jobs WHERE target_id = ? AND status IN ('queued','uploading','published')", (t.id,)):
                continue
            jid = _new_id()
            db.execute(
                """INSERT INTO publish_jobs (id, post_id, target_id, platform, status, attempts, max_attempts, dry_run,
                     next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)""",
                (jid, post_id, t.id, t.platform, max_attempts, 1 if dry_run else 0, run_at(t, post), ts, ts),
            )
            created.append(get_job(db, jid))
        sync_post_status(db, post_id)
        return created


def claim_next_job(db: Database, at: datetime | None = None) -> PublishJob | None:
    """Atomically claim the next due queued job, moving it to ``uploading`` and counting the attempt."""
    with db.transaction():
        job = _one(
            db,
            to_job,
            """SELECT * FROM publish_jobs WHERE status = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?)
               ORDER BY next_run_at, created_at LIMIT 1""",
            iso(at or now_utc()),
        )
        if not job:
            return None
        ts = now_iso()
        db.execute(
            """UPDATE publish_jobs SET status = 'uploading', attempts = attempts + 1, started_at = ?, error = NULL,
                 progress = 0, updated_at = ? WHERE id = ? AND status = 'queued'""",
            (ts, ts, job.id),
        )
        return get_job(db, job.id)


def _set_status(db: Database, jid: str, to: str, **fields: Any) -> PublishJob:
    with db.transaction():
        job = get_job(db, jid)
        if not job:
            raise KeyError(f"Job {jid} not found")
        assert_transition(job.status, to)
        cols = {**fields, "status": to, "updated_at": now_iso()}
        keys = list(cols)
        db.execute(f"UPDATE publish_jobs SET {', '.join(f'{k} = ?' for k in keys)} WHERE id = ?", (*cols.values(), jid))
        sync_post_status(db, job.post_id)
        return get_job(db, jid)


def mark_job_published(
    db: Database,
    jid: str,
    *,
    url: str | None,
    external_id: str | None = None,
    payload: dict[str, Any] | None = None,
    warnings: list[str] | None = None,
) -> PublishJob:
    return _set_status(
        db,
        jid,
        "published",
        result_url=url,
        external_id=external_id,
        result_payload=None if payload is None else _json({**payload, "warnings": warnings or []}),
        error=None,
        progress=1,
        checkpoint=None,
        finished_at=now_iso(),
    )


def update_job_progress(db: Database, jid: str, progress: float) -> None:
    db.execute(
        "UPDATE publish_jobs SET progress = ?, updated_at = ? WHERE id = ? AND status = 'uploading'",
        (max(0.0, min(1.0, progress)), now_iso(), jid),
    )


def save_job_checkpoint(db: Database, jid: str, checkpoint: Any) -> None:
    db.execute(
        "UPDATE publish_jobs SET checkpoint = ?, updated_at = ? WHERE id = ?",
        (None if checkpoint is None else _json(checkpoint), now_iso(), jid),
    )


def mark_job_failed(db: Database, jid: str, error: str, *, retryable: bool = True, delay_ms: int | None = None) -> PublishJob:
    """Record a failure; re-queues with backoff if retryable and attempts remain."""
    job = get_job(db, jid)
    if not job:
        raise KeyError(f"Job {jid} not found")
    if retryable and job.attempts < job.max_attempts:
        delay = retry_delay_ms(job.attempts) if delay_ms is None else delay_ms
        nxt = iso(now_utc() + timedelta(milliseconds=delay))
        return _set_status(db, jid, "queued", error=error, next_run_at=nxt, progress=None)
    return _set_status(db, jid, "failed", error=error, progress=None, finished_at=now_iso())


def retry_job(db: Database, jid: str) -> PublishJob:
    """Manually retry a failed job: grants one more attempt."""
    job = get_job(db, jid)
    if not job:
        raise KeyError(f"Job {jid} not found")
    return _set_status(
        db, jid, "queued", max_attempts=max(job.max_attempts, job.attempts + 1), next_run_at=now_iso(), finished_at=None
    )


def requeue_orphaned_jobs(
    db: Database, exclude: Iterable[str] = (), can_auto_retry: Callable[[PublishJob], bool] = lambda _j: True
) -> list[PublishJob]:
    """Recover jobs left ``uploading`` by a process that died mid-upload. Only call while holding the lease.

    - safe to retry (``can_auto_retry``) and attempts remain → re-queued immediately
    - otherwise → failed with a clear message (retry manually after checking the platform)
    ``can_auto_retry`` should be False when a retry could post twice (no resume checkpoint, real upload).
    """
    skip = set(exclude)
    orphans = [j for j in _many(db, to_job, "SELECT * FROM publish_jobs WHERE status = 'uploading'") if j.id not in skip]
    out = []
    for j in orphans:
        attempts_left = j.attempts < j.max_attempts
        safe = can_auto_retry(j)
        if attempts_left and safe:
            msg = f"Interrupted by a server restart during upload (attempt {j.attempts}/{j.max_attempts}); re-queued automatically."
        elif not safe:
            msg = (
                "Interrupted by a server restart during upload. It may already have been posted on the platform: "
                "check there first, then retry manually if needed."
            )
        else:
            msg = (
                f"Interrupted by a server restart during upload and no attempts are left ({j.attempts}/{j.max_attempts}). "
                "Check the platform for a partial post, then retry manually."
            )
        out.append(mark_job_failed(db, j.id, msg, retryable=attempts_left and safe, delay_ms=0))
    return out


def delete_orphan_media(db: Database, older_than_ms: int, now: datetime | None = None) -> list[str]:
    """Delete media older than ``older_than_ms`` that no post references. Returns their storage paths."""
    cutoff = iso((now or now_utc()) - timedelta(milliseconds=older_than_ms))
    rows = db.all(
        """SELECT id, storage_path FROM media m WHERE created_at < ?
             AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.media_id = m.id OR p.thumbnail_id = m.id)""",
        (cutoff,),
    )
    with db.transaction():
        for r in rows:
            db.execute("DELETE FROM media WHERE id = ?", (r["id"],))
    return [r["storage_path"] for r in rows]


def sync_post_status(db: Database, post_id: str) -> Post | None:
    """Recompute post status from its latest job per target."""
    post = get_post(db, post_id)
    if not post:
        return None
    rows = db.all(
        """SELECT status, attempts, next_run_at FROM publish_jobs j WHERE post_id = ? AND rowid = (
             SELECT MAX(rowid) FROM publish_jobs WHERE target_id = j.target_id)""",
        (post_id,),
    )
    status = derive_post_status([dict(r) for r in rows], post.status)
    if status != post.status:
        db.execute("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?", (status, now_iso(), post_id))
    return get_post(db, post_id)


# ---------------------------------------------------------------------------
# OAuth state (CSRF + PKCE), single use, 15 min TTL
# ---------------------------------------------------------------------------

OAUTH_STATE_TTL_MS = 15 * 60_000


def create_oauth_state(
    db: Database, *, state: str, platform: str, redirect_uri: str, code_verifier: str | None = None, return_to: str | None = None
) -> None:
    db.execute("DELETE FROM oauth_states WHERE created_at < ?", (iso(now_utc() - timedelta(milliseconds=OAUTH_STATE_TTL_MS)),))
    db.execute(
        "INSERT INTO oauth_states (state, platform, code_verifier, redirect_uri, return_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        (state, platform, code_verifier, redirect_uri, return_to, now_iso()),
    )


def consume_oauth_state(db: Database, state: str, platform: str) -> dict[str, Any] | None:
    """Fetch and delete a state; None if unknown, expired or for another platform."""
    with db.transaction():
        row = db.one("SELECT * FROM oauth_states WHERE state = ?", (state,))
        if not row:
            return None
        db.execute("DELETE FROM oauth_states WHERE state = ?", (state,))
    if row["platform"] != platform:
        return None
    created = ts_ms(row["created_at"]) or 0
    if created < now_utc().timestamp() * 1000 - OAUTH_STATE_TTL_MS:
        return None
    return {"code_verifier": row["code_verifier"], "redirect_uri": row["redirect_uri"], "return_to": row["return_to"]}
