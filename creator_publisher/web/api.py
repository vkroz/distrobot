"""JSON API routes (same paths and payloads as the original app)."""

from __future__ import annotations

import json as jsonlib
import os
import re
from typing import Any
from urllib.parse import quote

from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, RedirectResponse, Response
from starlette.routing import Route

from ..adapters import AdapterError, create_pkce_pair, create_state, get_adapter, list_adapters
from ..auth import (
    SESSION_COOKIE,
    SESSION_TTL_SEC,
    check_credentials,
    get_auth_config,
    login_throttle,
    revoke_all_sessions,
    safe_next,
    sessions_valid_after,
    sign_session,
    verify_session,
)
from ..db import get_db
from ..db import repo
from ..jobs.runner import dry_run_mode_from_env, should_dry_run, with_fresh_account
from ..jobs.worker import ensure_worker, get_worker
from ..media.probe import merge_metadata, probe_video
from ..models import PLATFORM_IDS, MediaInfo, TargetContent, is_platform_id, to_api
from ..platforms.rules import GB, MB, get_rules
from ..platforms.tiktok import MOCK_CREATOR_INFO, creator_from_api
from ..platforms.validate import requirement_rows, resolve_target_content, validate_for_platform
from ..services.posts import (
    ComposeError,
    compose_post,
    compose_result_api,
    delete_post_and_orphans,
    get_post_summary,
    list_post_summaries,
    normalize_iso,
    parse_compose_input,
    platform_statuses,
    publish_draft,
    summary_api,
    update_draft,
)
from ..storage import UploadTooLarge, delete_stored_file, resolve_storage_path, save_stream
from .common import app_url, error_json, is_https, json, parse_range, safe_return_to

MAX_VIDEO_BYTES = 10 * GB
#: YouTube's custom thumbnail limit is 2 MB; allow some headroom for other platforms.
MAX_IMAGE_BYTES = 10 * MB
IMAGE_TYPES = ("image/jpeg", "image/png", "image/webp")


async def _json_body(request: Request) -> Any:
    try:
        return jsonlib.loads(await request.body())
    except ValueError:
        raise ComposeError("Invalid JSON", 400) from None


def _compose_error(err: ComposeError) -> JSONResponse:
    return error_json(err.message, err.status, validation=to_api(err.validation) if err.validation else None)


def _kick() -> None:
    ensure_worker().kick()


# ---------------------------------------------------------------------------
# Health & session
# ---------------------------------------------------------------------------


async def health(request: Request) -> Response:
    st = get_worker().status()
    # Public endpoint: expose liveness only (no job ids / lease owner).
    return json(
        {
            "ok": True,
            "schemaVersion": get_db().schema_version(),
            "worker": {"running": st["running"], "holdsLease": st["holdsLease"], "busy": bool(st["active"])},
        }
    )


def _current_session(request: Request) -> dict[str, Any] | None:
    return verify_session(get_auth_config(), request.cookies.get(SESSION_COOKIE), None, sessions_valid_after())


async def session_get(request: Request) -> Response:
    """Current session + auth configuration warnings (public)."""
    cfg = get_auth_config()
    s = _current_session(request)
    return json(
        {
            "authenticated": bool(s),
            "username": s["u"] if s else None,
            "usingDefaultCredentials": cfg.using_default_credentials,
            "usingDefaultSecret": cfg.using_default_secret,
            "disabledReason": cfg.disabled_reason,
        }
    )


async def session_post(request: Request) -> Response:
    """Log in. JSON ``{username, password}`` (→ 200/401 JSON) or an HTML form post (→ 303 redirect)."""
    cfg = get_auth_config()
    is_form = "form" in (request.headers.get("content-type") or "")
    nxt = "/dashboard"
    try:
        if is_form:
            form = await request.form()
            username, password = str(form.get("username") or ""), str(form.get("password") or "")
            nxt = safe_next(str(form.get("next") or ""))
        else:
            b = jsonlib.loads(await request.body())
            if not isinstance(b, dict):
                raise ValueError
            username, password = str(b.get("username") or ""), str(b.get("password") or "")
    except (ValueError, UnicodeDecodeError):
        return error_json("Invalid request body", 400)

    # Brute-force protection: serialized + increasingly delayed once failures accumulate.
    ok = await login_throttle.attempt(lambda: check_credentials(cfg, username, password), count_failures=not cfg.disabled_reason)
    busy = ok is None
    if not ok:
        error = (
            "Too many login attempts right now. Please wait a moment and try again."
            if busy
            else cfg.disabled_reason or "Invalid username or password"
        )
        if is_form:
            target = f"/login?error={quote(error)}"
            if nxt != "/dashboard":
                target += f"&next={quote(nxt, safe='')}"
            return RedirectResponse(target, status_code=303)
        return error_json(error, 429 if busy else 503 if cfg.disabled_reason else 401)

    res: Response = RedirectResponse(nxt, status_code=303) if is_form else json({"ok": True, "username": cfg.username})
    res.set_cookie(SESSION_COOKIE, sign_session(cfg), max_age=SESSION_TTL_SEC, path="/", httponly=True, samesite="lax", secure=is_https(request))
    return res


async def session_delete(request: Request) -> Response:
    """Log out — revokes every existing session (single admin), not just this browser's cookie."""
    # Only an authenticated caller may revoke (the endpoint is public; don't let anyone log the admin out).
    if _current_session(request):
        revoke_all_sessions()
    res = json({"ok": True})
    res.delete_cookie(SESSION_COOKIE, path="/")
    return res


# ---------------------------------------------------------------------------
# Media
# ---------------------------------------------------------------------------


def _opt_num(v: str | None) -> float | None:
    try:
        n = float(v) if v is not None else None
    except ValueError:
        return None
    return n if n is not None and n > 0 and n != float("inf") else None


async def media_upload(request: Request) -> Response:
    """Raw-body upload of a video or thumbnail image, streamed to disk.

        POST /api/media?filename=clip.mp4&durationSec=12.3&width=1080&height=1920
        Content-Type: video/mp4

    Videos are re-measured with ffprobe; browser-reported values only fill fields ffprobe can't
    determine. ``media.metadataSource`` says which one was used.
    """
    q = request.query_params
    filename = q.get("filename") or "upload"
    mime = (request.headers.get("content-type") or "").split(";")[0].strip().lower() or None
    kind = "video" if mime and re.fullmatch(r"video/[a-z0-9.+-]+", mime) else "image" if mime in IMAGE_TYPES else None
    if not kind:
        return error_json(f"Expected a video or JPEG/PNG/WebP image, got {mime or 'unknown'}", 415)
    try:
        stored = await save_stream(request.stream(), filename, max_bytes=MAX_VIDEO_BYTES if kind == "video" else MAX_IMAGE_BYTES)
    except UploadTooLarge as err:
        return error_json(str(err), 400)
    if stored.size_bytes == 0:
        delete_stored_file(stored.storage_path)
        return error_json("Empty body", 400)
    # Never accept a silently truncated upload (aborted client, proxy body limits, ...).
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > 0 and int(declared) != stored.size_bytes:
        delete_stored_file(stored.storage_path)
        return error_json(f"Upload incomplete: received {stored.size_bytes} of {declared} bytes. Please try again.", 400)
    client = {"duration_sec": _opt_num(q.get("durationSec")), "width": _opt_num(q.get("width")), "height": _opt_num(q.get("height"))}
    client = {k: (int(v) if v is not None and k != "duration_sec" else v) for k, v in client.items()}
    if kind == "video":
        meta = merge_metadata(client, await probe_video(resolve_storage_path(stored.storage_path)))
    else:
        meta = {**client, "source": None}
    media = repo.create_media(
        get_db(),
        kind=kind,
        original_filename=filename,
        storage_path=stored.storage_path,
        mime_type=mime,
        size_bytes=stored.size_bytes,
        checksum=stored.checksum,
        duration_sec=meta["duration_sec"],
        width=meta["width"],
        height=meta["height"],
        metadata_source=meta["source"],
    )
    return json({"media": to_api(media)}, 201)


async def media_get(request: Request) -> Response:
    """Serve an uploaded file (thumbnails / video previews), with single-range support for seeking/Safari."""
    media = repo.get_media(get_db(), request.path_params["id"])
    if not media:
        return error_json("Not found", 404)
    path = resolve_storage_path(media.storage_path)
    if not os.path.exists(path):
        return error_json("File missing", 404)
    size = os.path.getsize(path)
    # Only ever serve as video/image; never let a stored file be interpreted as HTML/SVG/script.
    mime = media.mime_type if media.mime_type and re.fullmatch(r"video/[\w.+-]+|image/(jpeg|png|webp)", media.mime_type) else None
    ctype = mime or "application/octet-stream"
    headers = {
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Content-Disposition": "inline" if mime else "attachment",
    }
    rng = parse_range(request.headers.get("range"), size)
    if rng == "invalid":
        return Response(status_code=416, headers={**headers, "Content-Range": f"bytes */{size}"}, media_type=ctype)
    if rng:
        start, end = rng
        with open(path, "rb") as fh:
            fh.seek(start)
            data = fh.read(end - start + 1)
        return Response(data, status_code=206, media_type=ctype, headers={**headers, "Content-Range": f"bytes {start}-{end}/{size}"})
    # No Range: stream the whole file (FileResponse would re-parse Range; we already handled it).
    return FileResponse(path, media_type=ctype, headers=headers, stat_result=os.stat(path))


# ---------------------------------------------------------------------------
# Posts
# ---------------------------------------------------------------------------


async def posts_list(request: Request) -> Response:
    """Recent posts with targets and their latest job."""
    ensure_worker()
    return json({"posts": [summary_api(s) for s in list_post_summaries(get_db())]})


async def posts_create(request: Request) -> Response:
    try:
        result = compose_post(get_db(), parse_compose_input(await _json_body(request)))
    except ComposeError as err:
        return _compose_error(err)
    if result.jobs:
        _kick()
    return json(compose_result_api(result), 201)


async def post_get(request: Request) -> Response:
    s = get_post_summary(get_db(), request.path_params["id"])
    return json({"post": summary_api(s)}) if s else error_json("Not found", 404)


async def post_update(request: Request) -> Response:
    """Update a draft (same body as POST /api/posts). action "publish" validates and enqueues it."""
    try:
        result = update_draft(get_db(), request.path_params["id"], parse_compose_input(await _json_body(request)))
    except ComposeError as err:
        return _compose_error(err)
    if result.jobs:
        _kick()
    return json(compose_result_api(result))


async def post_delete(request: Request) -> Response:
    """Delete a post (drafts, scheduled or finished). Cancels queued jobs; refused while uploading."""
    try:
        paths = delete_post_and_orphans(get_db(), request.path_params["id"])
    except ComposeError as err:
        return _compose_error(err)
    for p in paths:
        delete_stored_file(p)
    return json({"ok": True})


async def post_publish(request: Request) -> Response:
    """Publish a saved draft as-is. Body (optional): ``{"scheduledAt": "<ISO>" | null}`` — omit to keep
    the draft's schedule, null = now."""
    try:
        body = jsonlib.loads(await request.body() or b"{}")
    except ValueError:
        body = {}
    body = body if isinstance(body, dict) else {}
    kwargs: dict[str, Any] = {}
    if "scheduledAt" in body and body["scheduledAt"] is None:
        kwargs["scheduled_at"] = None
    elif isinstance(body.get("scheduledAt"), str):
        try:
            kwargs["scheduled_at"] = normalize_iso(body["scheduledAt"])
        except ValueError:
            return error_json("scheduledAt is not a valid date", 400)
    try:
        result = publish_draft(get_db(), request.path_params["id"], dry_run=body.get("dryRun") is True, **kwargs)
    except ComposeError as err:
        return _compose_error(err)
    if result.jobs:
        _kick()
    return json(compose_result_api(result))


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


async def job_retry(request: Request) -> Response:
    """Re-queue a failed job immediately (grants one more attempt)."""
    db = get_db()
    job = repo.get_job(db, request.path_params["id"])
    if not job:
        return error_json("Not found", 404)
    if job.status != "failed":
        return error_json(f"Only failed jobs can be retried (job is {job.status})", 409)
    updated = repo.retry_job(db, job.id)
    _kick()
    return json({"job": to_api(updated)})


async def jobs_run(request: Request) -> Response:
    """Manual worker tick: process all due jobs and wait for them to finish."""
    processed = await ensure_worker().run_due_exclusive()
    if processed is None:
        return json({"processed": [], "error": "Another process holds the worker lease; it will process the jobs."}, 409)
    return json({"processed": to_api(processed)})


# ---------------------------------------------------------------------------
# Accounts & OAuth
# ---------------------------------------------------------------------------


async def accounts_list(request: Request) -> Response:
    """Per-platform configuration status and connected accounts (no secrets)."""
    mode = dry_run_mode_from_env()
    return json({"dryRunMode": mode, "platforms": platform_statuses(get_db(), list_adapters(), mode, app_url(request))})


async def account_delete(request: Request) -> Response:
    db = get_db()
    if not repo.get_account(db, request.path_params["id"]):
        return error_json("Not found", 404)
    repo.delete_account(db, request.path_params["id"])
    return json({"ok": True})


def _with_param(path: str, key: str, value: str) -> str:
    return f"{path}{'&' if '?' in path else '?'}{key}={quote(value, safe='')}"


async def auth_start(request: Request) -> Response:
    """Begin OAuth: store state (+PKCE verifier) and redirect to the provider."""
    platform = request.path_params["platform"]
    if not is_platform_id(platform):
        return error_json("Unknown platform", 404)
    adapter = get_adapter(platform)
    return_to = safe_return_to(request.query_params.get("returnTo"))
    redirect_uri = f"{app_url(request)}/api/auth/{platform}/callback"
    state = create_state()
    verifier, challenge = create_pkce_pair() if adapter.capabilities.pkce else (None, None)
    try:
        url = adapter.get_auth_url(state=state, redirect_uri=redirect_uri, code_challenge=challenge)
    except AdapterError as err:
        return RedirectResponse(_with_param(return_to, "error", err.message), status_code=303)
    repo.create_oauth_state(get_db(), state=state, platform=platform, code_verifier=verifier, redirect_uri=redirect_uri, return_to=return_to)
    return RedirectResponse(url, status_code=303)


async def auth_callback(request: Request) -> Response:
    """OAuth redirect target: verify state, exchange the code, store the account."""
    platform = request.path_params["platform"]
    if not is_platform_id(platform):
        return error_json("Unknown platform", 404)
    q = request.query_params
    db = get_db()
    saved = repo.consume_oauth_state(db, q["state"], platform) if q.get("state") else None
    back = safe_return_to(saved["return_to"] if saved else None)

    def fail(msg: str) -> Response:
        return RedirectResponse(_with_param(back, "error", msg), status_code=303)

    if not saved:
        return fail("Authorization expired or invalid state. Please try again.")
    provider_error = q.get("error_description") or q.get("error")
    if provider_error:
        return fail(provider_error)
    code = q.get("code")
    if not code:
        return fail("Missing authorization code")
    try:
        creds = await get_adapter(platform).handle_callback(code=code, redirect_uri=saved["redirect_uri"], code_verifier=saved["code_verifier"])
    except Exception as err:  # noqa: BLE001 — any failure goes back to the accounts page
        return fail(str(err) or "Authorization failed")
    repo.upsert_account(
        db,
        platform=creds.platform,
        external_id=creds.external_id,
        display_name=creds.display_name,
        access_token=creds.access_token,
        refresh_token=creds.refresh_token,
        expires_at=creds.expires_at,
        scopes=creds.scopes,
        metadata=creds.metadata,
    )
    return RedirectResponse(_with_param(back, "connected", platform), status_code=303)


async def tiktok_creator_info(request: Request) -> Response:
    """Creator info for the TikTok posting screen. Real ``creator_info/query`` when a TikTok account is
    connected and TikTok isn't in dry-run; otherwise a clearly-labelled mock."""
    adapter = get_adapter("tiktok")
    if should_dry_run(adapter, False, dry_run_mode_from_env()):
        return json({"source": "mock", "reason": "TikTok runs in dry-run mode", "creator": to_api(MOCK_CREATOR_INFO)})
    db = get_db()
    accounts = repo.list_accounts(db, "tiktok")
    if not accounts:
        return json({"source": "mock", "reason": "No TikTok account connected", "creator": to_api(MOCK_CREATOR_INFO)})
    account = accounts[0]
    try:
        # TikTok access tokens are short-lived (~24 h): refresh like the job runner does.
        creator = await with_fresh_account(db, adapter, account, lambda a: adapter.query_creator_info(a))  # type: ignore[attr-defined]
    except Exception as err:  # noqa: BLE001
        # TikTok also uses this call to signal the creator can't post right now (e.g. daily cap).
        msg = err.message if isinstance(err, AdapterError) else "Could not reach TikTok"
        return json({"source": "error", "error": msg, "creator": None}, 502)
    return json({"source": "api", "account": {"id": account.id, "displayName": account.display_name}, "creator": to_api(creator)})


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def _media_info(raw: Any) -> MediaInfo | None:
    if not isinstance(raw, dict):
        return None

    def num(k: str) -> Any:
        v = raw.get(k)
        return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None

    return MediaInfo(
        mime_type=raw.get("mimeType") if isinstance(raw.get("mimeType"), str) else None,
        size_bytes=num("sizeBytes"),
        duration_sec=num("durationSec"),
        width=num("width"),
        height=num("height"),
    )


async def validate(request: Request) -> Response:
    """Validate content for platforms.

    Simple form: ``{content: {title, caption, hashtags}, media?, platforms?}`` → ``{results}``.
    Compose form: ``{content, media?, targets: [{platform, titleOverride?, captionOverride?,
    hashtagsOverride?, settings?}], tiktokCreator?}`` → results with per-target overrides and settings
    applied, plus ``requirements`` rows for the UI.
    """
    try:
        body = jsonlib.loads(await request.body())
        if not isinstance(body, dict):
            raise ValueError
    except ValueError:
        return error_json("Invalid JSON", 400)
    raw = body.get("content") if isinstance(body.get("content"), dict) else {}
    base = {
        "title": str(raw.get("title") or ""),
        "caption": str(raw.get("caption") or ""),
        "hashtags": [str(t) for t in raw["hashtags"]] if isinstance(raw.get("hashtags"), list) else [],
    }
    media = _media_info(body.get("media"))

    if isinstance(body.get("targets"), list):
        creator = creator_from_api(body.get("tiktokCreator"))
        results = []
        for t in body["targets"]:
            if not isinstance(t, dict) or not is_platform_id(t.get("platform")):
                return error_json(f"Unknown platform: {t.get('platform') if isinstance(t, dict) else t}", 400)
            p = t["platform"]
            overrides = {
                "title_override": t.get("titleOverride") if isinstance(t.get("titleOverride"), str) else None,
                "caption_override": t.get("captionOverride") if isinstance(t.get("captionOverride"), str) else None,
                "hashtags_override": [str(x) for x in t["hashtagsOverride"]] if isinstance(t.get("hashtagsOverride"), list) else None,
            }
            settings = t.get("settings") if isinstance(t.get("settings"), dict) else {}
            r = validate_for_platform(
                p,
                resolve_target_content(base, overrides),
                media,
                settings=settings if p == "tiktok" else None,
                tiktok_creator=creator if p == "tiktok" else None,
            )
            results.append({**to_api(r), "requirements": requirement_rows(get_rules(p), r, media)})
        return json({"results": results})

    platforms = body.get("platforms") if isinstance(body.get("platforms"), list) else list(PLATFORM_IDS)
    invalid = [str(p) for p in platforms if not is_platform_id(p)]
    if invalid:
        return error_json(f"Unknown platforms: {', '.join(invalid)}", 400)
    content = TargetContent(**base)
    return json({"results": [to_api(validate_for_platform(p, content, media)) for p in platforms]})


routes = [
    Route("/api/health", health),
    Route("/api/session", session_get, methods=["GET"]),
    Route("/api/session", session_post, methods=["POST"]),
    Route("/api/session", session_delete, methods=["DELETE"]),
    Route("/api/media", media_upload, methods=["POST"]),
    Route("/api/media/{id}", media_get, methods=["GET"]),
    Route("/api/posts", posts_list, methods=["GET"]),
    Route("/api/posts", posts_create, methods=["POST"]),
    Route("/api/posts/{id}", post_get, methods=["GET"]),
    Route("/api/posts/{id}", post_update, methods=["PUT"]),
    Route("/api/posts/{id}", post_delete, methods=["DELETE"]),
    Route("/api/posts/{id}/publish", post_publish, methods=["POST"]),
    Route("/api/jobs/run", jobs_run, methods=["POST"]),
    Route("/api/jobs/{id}/retry", job_retry, methods=["POST"]),
    Route("/api/accounts", accounts_list, methods=["GET"]),
    Route("/api/accounts/{id}", account_delete, methods=["DELETE"]),
    Route("/api/auth/{platform}/start", auth_start, methods=["GET"]),
    Route("/api/auth/{platform}/callback", auth_callback, methods=["GET"]),
    Route("/api/tiktok/creator-info", tiktok_creator_info, methods=["GET"]),
    Route("/api/validate", validate, methods=["POST"]),
]
