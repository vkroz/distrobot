"""Publish job lifecycle.

    queued → uploading → published
                      ↘ failed  (terminal unless manually retried)
                      ↘ queued  (automatic retry with backoff while attempts < max_attempts)
    failed → queued (manual retry)
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from ..models import now_utc, ts_ms

TRANSITIONS: dict[str, tuple[str, ...]] = {
    "queued": ("uploading",),
    "uploading": ("published", "failed", "queued"),
    "failed": ("queued",),
    "published": (),
}


def can_transition(frm: str, to: str) -> bool:
    return to in TRANSITIONS[frm]


def assert_transition(frm: str, to: str) -> None:
    if not can_transition(frm, to):
        raise ValueError(f"Invalid job transition {frm} → {to}")


def retry_delay_ms(attempts: int) -> int:
    """Exponential backoff: 30s, 60s, 120s, ... capped at 30 min."""
    return min(30_000 * 2 ** max(0, attempts - 1), 30 * 60_000)


def derive_post_status(jobs: list[Any], current: str = "draft", now: datetime | None = None) -> str:
    """Derive the overall post status from its latest job per target.

    ``jobs`` items are statuses (str) or dicts with ``status``, ``attempts``, ``next_run_at``.
    Queued jobs that have never run and are due in the future count as "scheduled".
    """
    now_ms = (now or now_utc()).timestamp() * 1000
    items = [{"status": j} if isinstance(j, str) else j for j in jobs]
    if not items:
        return "scheduled" if current == "scheduled" else "draft"
    active = [j for j in items if j["status"] in ("queued", "uploading")]
    if active:

        def scheduled(j: dict) -> bool:
            due = ts_ms(j.get("next_run_at"))
            return j["status"] == "queued" and not j.get("attempts") and due is not None and due > now_ms

        return "scheduled" if all(scheduled(j) for j in active) else "publishing"
    published = sum(1 for j in items if j["status"] == "published")
    if published == len(items):
        return "published"
    if published == 0:
        return "failed"
    return "partial"
