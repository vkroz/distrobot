"""Display formatting for templates (times in the viewer's time zone, sizes, durations)."""

from __future__ import annotations

from datetime import datetime, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..models import now_utc, parse_iso


def viewer_tz(name: str | None) -> tzinfo:
    """Time zone from the ``tz`` cookie the browser sets (IANA name); UTC if missing/unknown."""
    if name:
        try:
            return ZoneInfo(name)
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return timezone.utc


def local(iso_value: str | None, tz: tzinfo) -> datetime | None:
    dt = parse_iso(iso_value)
    return dt.astimezone(tz) if dt else None


def format_datetime(iso_value: str | None, tz: tzinfo) -> str:
    """"Nov 6, 2026, 3:04 PM"."""
    dt = local(iso_value, tz)
    if not dt:
        return "—"
    hour = dt.hour % 12 or 12
    return f"{dt.strftime('%b')} {dt.day}, {dt.year}, {hour}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"


def format_time(dt: datetime) -> str:
    return f"{dt.hour:02d}:{dt.minute:02d}"


def relative_time(iso_value: str | None, now: datetime | None = None) -> str:
    dt = parse_iso(iso_value)
    if not dt:
        return ""
    diff = (dt - (now or now_utc())).total_seconds()
    a = abs(diff)
    for limit, unit, size in ((60, "second", 1), (3600, "minute", 60), (86400, "hour", 3600), (float("inf"), "day", 86400)):
        if a < limit:
            n = round(a / size)
            break
    if unit == "day" and n == 1:
        return "tomorrow" if diff > 0 else "yesterday"
    if n == 0 and unit == "second":
        return "now"
    label = f"{n} {unit}{'' if n == 1 else 's'}"
    return f"in {label}" if diff > 0 else f"{label} ago"


def format_bytes(n: float | None) -> str:
    if n is None:
        return "—"
    units = ["B", "KB", "MB", "GB", "TB"]
    v = float(n)
    i = 0
    while v >= 1024 and i < len(units) - 1:
        v /= 1024
        i += 1
    return f"{round(v) if v >= 10 or v.is_integer() else f'{v:.1f}'} {units[i]}"


def format_duration(sec: float | None) -> str:
    if sec is None:
        return "—"
    if sec < 60:
        v = round(sec * 10) / 10
        return f"{int(v) if v.is_integer() else v}s"
    h, m, s = int(sec // 3600), int((sec % 3600) // 60), round(sec % 60)
    return f"{h}h {m}m" if h else f"{m}m{f' {s}s' if s else ''}"
