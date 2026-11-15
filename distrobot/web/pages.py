"""Server-rendered pages (Jinja2)."""

from __future__ import annotations

import calendar
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response
from starlette.routing import Route
from starlette.templating import Jinja2Templates

from ..adapters import list_adapters
from ..auth import DEFAULT_PASSWORD, DEFAULT_USERNAME, get_auth_config, safe_next
from ..db import get_db
from ..db import repo
from ..jobs.runner import dry_run_mode_from_env
from ..models import JOB_STATUSES, PLATFORM_IDS, is_platform_id, now_utc, to_api, ts_ms
from ..platforms.rules import PLATFORM_RULES
from ..platforms.tiktok import TIKTOK_LINKS, TIKTOK_PRIVACY_LABELS
from ..services.posts import get_post_summary, is_draft, list_post_summaries, platform_statuses, summary_api
from . import fmt
from .common import app_url

templates = Jinja2Templates(directory=str(Path(__file__).parent / "templates"))

#: Presentation-only platform metadata.
PLATFORM_META: dict[str, dict[str, str]] = {
    "youtube": {"short": "YT", "cls": "pf-youtube"},
    "tiktok": {"short": "TT", "cls": "pf-tiktok"},
    "instagram": {"short": "IG", "cls": "pf-instagram"},
    "x": {"short": "X", "cls": "pf-x"},
    "facebook": {"short": "FB", "cls": "pf-facebook"},
    "linkedin": {"short": "in", "cls": "pf-linkedin"},
    "vimeo": {"short": "V", "cls": "pf-vimeo"},
}

POST_TONE = {"draft": "neutral", "scheduled": "violet", "publishing": "blue", "published": "green", "partial": "amber", "failed": "red"}
JOB_TONE = {"queued": "neutral", "uploading": "blue", "published": "green", "failed": "red"}


def _ctx(request: Request, **extra: Any) -> dict[str, Any]:
    tz = fmt.viewer_tz(request.cookies.get("tz"))
    cfg = get_auth_config()
    session = request.scope.get("state", {}).get("session")
    return {
        "request": request,
        "path": request.url.path,
        "session": session,
        "auth_cfg": cfg,
        "rules": PLATFORM_RULES,
        "platform_ids": PLATFORM_IDS,
        "pmeta": PLATFORM_META,
        "dt": lambda v: fmt.format_datetime(v, tz),
        "rel": fmt.relative_time,
        "fbytes": fmt.format_bytes,
        "fdur": fmt.format_duration,
        **extra,
    }


def render(request: Request, name: str, status: int = 200, **extra: Any) -> HTMLResponse:
    return templates.TemplateResponse(request, name, _ctx(request, **extra), status_code=status)


async def home(request: Request) -> Response:
    """Home is the dashboard (it links to Compose and shows an empty state for new users)."""
    return RedirectResponse("/dashboard", status_code=307)


async def login(request: Request) -> Response:
    """Plain HTML form → POST /api/session, so login works without JavaScript."""
    q = request.query_params
    return render(
        request,
        "login.html",
        error=q.get("error"),
        next=safe_next(q.get("next")),
        default_username=DEFAULT_USERNAME,
        default_password=DEFAULT_PASSWORD,
    )


async def compose(request: Request) -> Response:
    db = get_db()
    draft_id = request.query_params.get("draft") or None
    draft = None
    locked = None
    missing = None
    if draft_id:
        s = get_post_summary(db, draft_id)
        if not s:
            missing = "Not found"
        elif not is_draft(s):
            locked = s["post"]
        else:
            draft = summary_api(s)
    mode = dry_run_mode_from_env()
    rules_api = {p: to_api(r) for p, r in PLATFORM_RULES.items()}
    boot = {
        "draft": draft,
        "dryRunMode": mode,
        "statuses": {s["platform"]: s for s in platform_statuses(db, list_adapters(), mode, app_url(request))},
        "rules": rules_api,
        "platformIds": list(PLATFORM_IDS),
        "meta": PLATFORM_META,
        "tiktok": {"privacyLabels": TIKTOK_PRIVACY_LABELS, "links": TIKTOK_LINKS},
    }
    return render(request, "compose.html", draft_id=draft_id, locked=locked, missing=missing, boot=boot, dry_run_mode=mode)


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------


def _post_date(s: dict[str, Any]) -> str:
    """When a post is (or was) going live: its schedule, else first publish time, else creation time."""
    p = s["post"]
    if p.scheduled_at:
        return p.scheduled_at
    finished = sorted(j.finished_at for _t, j in s["targets"] if j and j.finished_at)
    return finished[0] if finished else p.created_at


def _is_upcoming(s: dict[str, Any], now_ms: float) -> bool:
    p = s["post"]
    at = ts_ms(p.scheduled_at)
    return at is not None and at > now_ms and any(j and j.status in ("queued", "uploading", "published") for _t, j in s["targets"])


def _is_active(s: dict[str, Any], now_ms: float) -> bool:
    """In flight = uploading, or queued and due within a few seconds."""
    for _t, j in s["targets"]:
        if j and (j.status == "uploading" or (j.status == "queued" and (ts_ms(j.next_run_at) or 0) <= now_ms + 5000)):
            return True
    return False


def _target_view(target: Any, job: Any, now_ms: float) -> dict[str, Any]:
    payload = job.result_payload if job and isinstance(job.result_payload, dict) else {}
    waiting = bool(job and job.status == "queued" and (ts_ms(job.next_run_at) or 0) > now_ms)
    sched = payload.get("scheduledAt")
    goes_live = sched if job and job.status == "published" and sched and (ts_ms(sched) or 0) > now_ms else None
    if job:
        label = "scheduled" if waiting and job.attempts == 0 else "retrying" if waiting else job.status
        tone = "violet" if waiting and job.attempts == 0 else JOB_TONE[job.status]
    else:
        label, tone = ("draft" if target.enabled else "disabled"), "neutral"
    return {
        "target": target,
        "job": job,
        "name": PLATFORM_RULES[target.platform].display_name,
        "label": label,
        "tone": tone,
        "waiting": waiting,
        "goes_live": goes_live,
        "dry_run": bool(job and (job.dry_run or payload.get("dryRun") or (job.result_url or "").startswith("/dry-run/"))),
        "is_dry_run_link": bool(job and (job.result_url or "").startswith("/dry-run/")),
        "warnings": payload.get("warnings") or [],
        "progress": round((job.progress or 0) * 100) if job else 0,
    }


def _month_grid(month: date) -> list[date]:
    """Monday-first 6x7 grid of dates covering ``month``."""
    first = month.replace(day=1)
    start = first - timedelta(days=first.weekday())
    return [start + timedelta(days=i) for i in range(42)]


async def dashboard(request: Request) -> Response:
    q = request.query_params
    tz = fmt.viewer_tz(request.cookies.get("tz"))
    now = now_utc()
    now_ms = now.timestamp() * 1000
    summaries = list_post_summaries(get_db())
    view = "calendar" if q.get("view") == "calendar" else "list"
    filt = "drafts" if q.get("filter") == "drafts" else "all"

    counts = {s: 0 for s in JOB_STATUSES}
    for s in summaries:
        for _t, j in s["targets"]:
            if j:
                counts[j.status] += 1

    cards = []
    for s in summaries:
        draft = is_draft(s)
        if filt == "drafts" and not draft:
            continue
        p = s["post"]
        upcoming_default = p.scheduled_at if p.scheduled_at and (ts_ms(p.scheduled_at) or 0) > now_ms else None
        cards.append(
            {
                "s": s,
                "post": p,
                "draft": draft,
                "tone": POST_TONE[p.status],
                "targets": [_target_view(t, j, now_ms) for t, j in s["targets"]],
                "uploading": any(j and j.status == "uploading" for _t, j in s["targets"]),
                "pending": any(j and j.status == "queued" for _t, j in s["targets"]),
                "schedule_default": upcoming_default,
            }
        )

    upcoming = sorted((s for s in summaries if _is_upcoming(s, now_ms)), key=lambda s: ts_ms(_post_date(s)) or 0)

    # Calendar (in the viewer's time zone).
    today = now.astimezone(tz).date()
    try:
        y, m = (int(x) for x in (q.get("month") or "").split("-"))
        month = date(y, m, 1)
    except ValueError:
        month = today.replace(day=1)
    by_day: dict[date, list[dict[str, Any]]] = {}
    for s in summaries:
        d = fmt.local(_post_date(s), tz)
        if d:
            by_day.setdefault(d.date(), []).append({"s": s, "time": fmt.format_time(d), "at": d})
    for items in by_day.values():
        items.sort(key=lambda i: i["at"])
    prev_month = (month - timedelta(days=1)).replace(day=1)
    next_month = (month + timedelta(days=calendar.monthrange(month.year, month.month)[1])).replace(day=1)

    return render(
        request,
        "dashboard.html",
        cards=cards,
        counts=counts,
        upcoming=upcoming,
        view=view,
        filter=filt,
        highlight=q.get("post"),
        draft_count=sum(1 for s in summaries if is_draft(s)),
        has_posts=bool(summaries),
        active=any(_is_active(s, now_ms) for s in summaries),
        pending=any(any(j and j.status == "queued" for _t, j in s["targets"]) for s in summaries),
        month=month,
        month_label=f"{calendar.month_name[month.month]} {month.year}",
        grid=_month_grid(month),
        by_day=by_day,
        today=today,
        prev_month=f"{prev_month.year}-{prev_month.month:02d}",
        next_month=f"{next_month.year}-{next_month.month:02d}",
        local_input=lambda iso_value: (fmt.local(iso_value, tz) or datetime.now(tz)).strftime("%Y-%m-%dT%H:%M"),
        default_schedule=(now + timedelta(hours=1)).astimezone(tz).strftime("%Y-%m-%dT%H:%M"),
    )


async def accounts(request: Request) -> Response:
    q = request.query_params
    mode = dry_run_mode_from_env()
    connected = q.get("connected")
    flash = None
    if q.get("error"):
        flash = {"ok": False, "text": q["error"]}
    elif connected:
        name = PLATFORM_RULES[connected].display_name if is_platform_id(connected) else connected
        flash = {"ok": True, "text": f"Connected {name}."}
    elif q.get("disconnected"):
        flash = {"ok": True, "text": "Account disconnected."}
    return render(
        request,
        "accounts.html",
        flash=flash,
        mode=mode,
        platforms=platform_statuses(get_db(), list_adapters(), mode, app_url(request)),
        now_ms=now_utc().timestamp() * 1000,
        ts_ms=ts_ms,
    )


async def dry_run(request: Request) -> Response:
    db = get_db()
    job = repo.get_job(db, request.path_params["job_id"])
    if not job:
        return render(request, "not_found.html", status=404)
    post = repo.get_post(db, job.post_id)
    payload = job.result_payload if isinstance(job.result_payload, dict) else None
    return render(request, "dry_run.html", job=job, post=post, payload=payload, r=PLATFORM_RULES[job.platform])


routes = [
    Route("/", home),
    Route("/login", login),
    Route("/compose", compose),
    Route("/dashboard", dashboard),
    Route("/accounts", accounts),
    Route("/dry-run/{job_id}", dry_run),
]
