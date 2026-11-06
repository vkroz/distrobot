"""Compose (drafts, publish, schedule, delete) and read models for the API and pages."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from ..adapters import BaseAdapter
from ..adapters import get_adapter as default_get_adapter
from ..db import Database
from ..db import repo
from ..jobs.runner import dry_run_mode_from_env, should_dry_run
from ..models import (
    VISIBILITIES,
    ConnectedAccount,
    Post,
    PostTarget,
    PublishJob,
    is_platform_id,
    iso,
    now_utc,
    parse_iso,
    to_api,
)
from ..platforms.rules import get_rules
from ..platforms.validate import ValidationResult, resolve_target_content


@dataclass
class ComposeTargetInput:
    platform: str
    account_id: str | None = None
    title_override: str | None = None
    caption_override: str | None = None
    hashtags_override: list[str] | None = None
    settings: dict[str, Any] = field(default_factory=dict)


@dataclass
class ComposeInput:
    title: str
    caption: str
    hashtags: list[str]
    #: Required to publish; drafts may be saved before the video is uploaded.
    media_id: str | None
    visibility: str
    targets: list[ComposeTargetInput]
    #: "draft" saves only; "publish" validates strictly and enqueues jobs.
    action: str
    thumbnail_id: str | None = None
    #: ISO timestamp; None = publish now.
    scheduled_at: str | None = None
    #: Force dry-run for this post's jobs.
    dry_run: bool = False


class ComposeError(Exception):
    def __init__(self, message: str, status: int, validation: list[ValidationResult] | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.validation = validation


def _str(v: Any, max_len: int = 100_000) -> str:
    return v[:max_len] if isinstance(v, str) else ""


def _opt_str(v: Any) -> str | None:
    return v if isinstance(v, str) else None


def _str_list(v: Any) -> list[str]:
    return [x for x in v if isinstance(x, str)] if isinstance(v, list) else []


def normalize_iso(value: Any) -> str | None:
    """Parse a client timestamp into canonical ISO-UTC; raises ValueError if invalid."""
    dt = parse_iso(str(value))
    if dt is None:
        raise ValueError("invalid date")
    return iso(dt)


def parse_compose_input(body: Any) -> ComposeInput:
    """Parse untrusted JSON into ComposeInput (raises ComposeError 400)."""
    if not isinstance(body, dict):
        raise ComposeError("Body must be a JSON object", 400)
    action = "draft" if body.get("action") == "draft" else "publish"
    media_id = body.get("mediaId")
    if action == "publish" and (not isinstance(media_id, str) or not media_id):
        raise ComposeError("mediaId is required", 400)
    visibility = body.get("visibility") if body.get("visibility") in VISIBILITIES else "public"
    scheduled_at = None
    if body.get("scheduledAt"):
        try:
            scheduled_at = normalize_iso(body["scheduledAt"])
        except ValueError:
            raise ComposeError("scheduledAt is not a valid date", 400) from None
    raw_targets = body.get("targets") if isinstance(body.get("targets"), list) else []
    if action == "publish" and not raw_targets:
        raise ComposeError("Select at least one platform", 400)
    seen: set[str] = set()
    targets = []
    for raw in raw_targets:
        t = raw if isinstance(raw, dict) else {}
        platform = t.get("platform")
        if not is_platform_id(platform):
            raise ComposeError(f"Unknown platform: {platform}", 400)
        if platform in seen:
            raise ComposeError(f"Duplicate platform: {platform}", 400)
        seen.add(platform)
        targets.append(
            ComposeTargetInput(
                platform=platform,
                account_id=_opt_str(t.get("accountId")),
                title_override=_opt_str(t.get("titleOverride")),
                caption_override=_opt_str(t.get("captionOverride")),
                hashtags_override=_str_list(t["hashtagsOverride"]) if isinstance(t.get("hashtagsOverride"), list) else None,
                settings=t["settings"] if isinstance(t.get("settings"), dict) else {},
            )
        )
    return ComposeInput(
        title=_str(body.get("title"), 1000),
        caption=_str(body.get("caption")),
        hashtags=_str_list(body.get("hashtags")),
        media_id=media_id if isinstance(media_id, str) and media_id else None,
        thumbnail_id=_opt_str(body.get("thumbnailId")),
        visibility=visibility,
        scheduled_at=scheduled_at,
        targets=targets,
        action=action,
        dry_run=body.get("dryRun") is True,
    )


@dataclass
class ComposeResult:
    post: Post
    targets: list[PostTarget]
    jobs: list[PublishJob]
    validation: list[ValidationResult]


GetAdapter = Callable[[str], BaseAdapter]


def compose_post(db: Database, inp: ComposeInput, *, get_adapter: GetAdapter = default_get_adapter, now: datetime | None = None) -> ComposeResult:
    """Create a post (draft or published/scheduled)."""
    return _save_post(db, None, inp, get_adapter, now)


def update_draft(
    db: Database, pid: str, inp: ComposeInput, *, get_adapter: GetAdapter = default_get_adapter, now: datetime | None = None
) -> ComposeResult:
    """Update a draft; with action "publish" it is validated and enqueued (now or at scheduled_at)."""
    return _save_post(db, pid, inp, get_adapter, now)


_KEEP = object()


def publish_draft(
    db: Database,
    pid: str,
    *,
    scheduled_at: Any = _KEEP,
    dry_run: bool = False,
    get_adapter: GetAdapter = default_get_adapter,
    now: datetime | None = None,
) -> ComposeResult:
    """Publish an existing draft as-is, now or at ``scheduled_at`` (overrides the draft's own schedule when given)."""
    summary = get_post_summary(db, pid)
    if not summary:
        raise ComposeError("Post not found", 404)
    post = summary["post"]
    inp = ComposeInput(
        title=post.title,
        caption=post.caption,
        hashtags=post.hashtags,
        media_id=post.media_id,
        thumbnail_id=post.thumbnail_id,
        visibility=post.visibility,
        scheduled_at=post.scheduled_at if scheduled_at is _KEEP else scheduled_at,
        targets=[
            ComposeTargetInput(
                platform=t.platform,
                account_id=t.account_id,
                title_override=t.title_override,
                caption_override=t.caption_override,
                hashtags_override=t.hashtags_override,
                settings=t.settings,
            )
            for t, _job in summary["targets"]
        ],
        action="publish",
        dry_run=dry_run,
    )
    return _save_post(db, pid, inp, get_adapter, now)


def delete_post_and_orphans(db: Database, pid: str) -> list[str]:
    """Delete a post (and its targets/jobs). Refused while a job is uploading. Media no longer referenced
    by any post is removed from the DB; returns their storage paths for file cleanup."""
    post = repo.get_post(db, pid)
    if not post:
        raise ComposeError("Post not found", 404)
    if any(j.status == "uploading" for j in repo.list_jobs(db, pid)):
        raise ComposeError("This post is uploading right now; wait for it to finish", 409)
    paths: list[str] = []
    with db.transaction():
        repo.delete_post(db, pid)
        for mid in (post.media_id, post.thumbnail_id):
            if not mid:
                continue
            used = db.one("SELECT 1 FROM posts WHERE media_id = ? OR thumbnail_id = ? LIMIT 1", (mid, mid))
            media = repo.get_media(db, mid)
            if not used and media:
                db.execute("DELETE FROM media WHERE id = ?", (mid,))
                paths.append(media.storage_path)
    return paths


def _save_post(db: Database, existing_id: str | None, inp: ComposeInput, get_adapter: GetAdapter, now: datetime | None) -> ComposeResult:
    now = now or now_utc()
    if existing_id:
        existing = repo.get_post(db, existing_id)
        if not existing:
            raise ComposeError("Post not found", 404)
        if existing.status != "draft" or repo.list_jobs(db, existing_id):
            raise ComposeError("Only drafts can be edited; this post has already been published or scheduled", 409)

    media = repo.get_media(db, inp.media_id) if inp.media_id else None
    if inp.media_id and (not media or media.kind != "video"):
        raise ComposeError("Video not found; upload it first", 400)
    if inp.action == "publish" and not media:
        raise ComposeError("Upload a video before publishing", 400)
    if inp.action == "publish" and not inp.targets:
        raise ComposeError("Select at least one platform", 400)
    if inp.thumbnail_id:
        thumb = repo.get_media(db, inp.thumbnail_id)
        if not thumb or thumb.kind != "image":
            raise ComposeError("Thumbnail not found", 400)
    when = parse_iso(inp.scheduled_at)
    if inp.action == "publish" and when and when.timestamp() < now.timestamp() - 60:
        raise ComposeError("Scheduled time is in the past", 400)

    def account_for(t: ComposeTargetInput) -> ConnectedAccount | None:
        accounts = repo.list_accounts(db, t.platform)
        if t.account_id:
            return next((a for a in accounts if a.id == t.account_id), None)
        return accounts[0] if accounts else None

    validation = [
        get_adapter(t.platform).validate(
            resolve_target_content(
                {"title": inp.title, "caption": inp.caption, "hashtags": inp.hashtags},
                {"title_override": t.title_override, "caption_override": t.caption_override, "hashtags_override": t.hashtags_override},
            ),
            media,
            account_for(t),
            t.settings or {},
        )
        for t in inp.targets
    ]
    if inp.action == "publish" and any(not v.ok for v in validation):
        bad = ", ".join(get_rules(v.platform).display_name for v in validation if not v.ok)
        raise ComposeError(f"Fix errors for {bad} before publishing", 422, validation)

    with db.transaction():
        fields = {
            "title": inp.title,
            "caption": inp.caption,
            "hashtags": inp.hashtags,
            "media_id": inp.media_id,
            "thumbnail_id": inp.thumbnail_id,
            "visibility": inp.visibility,
            "scheduled_at": inp.scheduled_at,
        }
        post = repo.update_post(db, existing_id, **fields) if existing_id else repo.create_post(db, **fields)
        # Targets mirror the input exactly: drop platforms that were deselected.
        keep = {t.platform for t in inp.targets}
        for t in repo.list_targets(db, post.id):
            if t.platform not in keep:
                db.execute("DELETE FROM post_targets WHERE id = ?", (t.id,))
        targets = []
        for t in inp.targets:
            acct = account_for(t)
            targets.append(
                repo.upsert_target(
                    db,
                    post.id,
                    t.platform,
                    account_id=acct.id if acct else None,
                    enabled=True,
                    title_override=t.title_override,
                    caption_override=t.caption_override,
                    hashtags_override=t.hashtags_override,
                    settings=t.settings or {},
                )
            )
        jobs: list[PublishJob] = []
        if inp.action == "publish":
            now_s = iso(now)
            jobs = repo.enqueue_publish(
                db,
                post.id,
                dry_run=inp.dry_run,
                run_at_for=lambda tgt, p: p.scheduled_at
                if p.scheduled_at and not get_adapter(tgt.platform).capabilities.native_scheduling
                else now_s,
            )
        return ComposeResult(repo.get_post(db, post.id), targets, jobs, validation)


def compose_result_api(r: ComposeResult) -> dict[str, Any]:
    return {"post": to_api(r.post), "targets": to_api(r.targets), "jobs": to_api(r.jobs), "validation": to_api(r.validation)}


# ---------------------------------------------------------------------------
# Read models
# ---------------------------------------------------------------------------


def get_post_summary(db: Database, pid: str) -> dict[str, Any] | None:
    """{"post": Post, "media": Media|None, "thumbnail": Media|None, "targets": [(PostTarget, latest job|None)]}"""
    post = repo.get_post(db, pid)
    if not post:
        return None
    jobs = repo.list_jobs(db, pid)
    targets = []
    for t in repo.list_targets(db, pid):
        mine = [j for j in jobs if j.target_id == t.id]
        targets.append((t, mine[-1] if mine else None))
    return {
        "post": post,
        "media": repo.get_media(db, post.media_id) if post.media_id else None,
        "thumbnail": repo.get_media(db, post.thumbnail_id) if post.thumbnail_id else None,
        "targets": targets,
    }


def summary_api(s: dict[str, Any]) -> dict[str, Any]:
    """PostSummary JSON: post fields + media, thumbnail, targets[{...target, job}]."""
    return {
        **to_api(s["post"]),
        "media": to_api(s["media"]),
        "thumbnail": to_api(s["thumbnail"]),
        "targets": [{**to_api(t), "job": to_api(j)} for t, j in s["targets"]],
    }


def list_post_summaries(db: Database, limit: int = 200) -> list[dict[str, Any]]:
    return [s for p in repo.list_posts(db, limit) if (s := get_post_summary(db, p.id))]


def public_account(a: ConnectedAccount) -> dict[str, Any]:
    """Account without secrets, safe to send to the browser."""
    return {
        "id": a.id,
        "platform": a.platform,
        "externalId": a.external_id,
        "displayName": a.display_name,
        "expiresAt": a.expires_at,
        "scopes": a.scopes,
        "createdAt": a.created_at,
    }


def platform_statuses(db: Database, adapters: list[BaseAdapter], mode: str | None = None, base_url: str = "http://localhost:8000") -> list[dict[str, Any]]:
    mode = mode or dry_run_mode_from_env()
    return [
        {
            "platform": a.platform,
            "displayName": a.display_name,
            #: OAuth client credentials present.
            "configured": a.is_configured(),
            #: Jobs for this platform would currently run as dry-run.
            "dryRun": should_dry_run(a, False, mode),
            "capabilities": to_api(a.capabilities),
            #: Env vars to set to enable real publishing.
            "envVars": a.credential_env_vars,
            #: OAuth redirect URI to register with the provider.
            "redirectUri": f"{base_url}/api/auth/{a.platform}/callback",
            "accounts": [public_account(x) for x in repo.list_accounts(db, a.platform)],
        }
        for a in adapters
    ]


def is_draft(summary: dict[str, Any]) -> bool:
    return summary["post"].status == "draft" and all(j is None for _t, j in summary["targets"])

