"""Small helpers shared by route handlers."""

from __future__ import annotations

import os
import re
from typing import Any

from starlette.requests import Request
from starlette.responses import JSONResponse

from ..auth import safe_next


def json(data: Any, status: int = 200) -> JSONResponse:
    return JSONResponse(data, status_code=status)


def error_json(message: str, status: int, **extra: Any) -> JSONResponse:
    return JSONResponse({"error": message, **extra}, status_code=status)


def app_url(request: Request | None = None) -> str:
    """Base URL used for OAuth redirect URIs."""
    if os.environ.get("APP_URL"):
        return os.environ["APP_URL"].rstrip("/")
    if request is not None:
        return f"{request.url.scheme}://{request.url.netloc}"
    return "http://localhost:8000"


def safe_return_to(v: str | None, fallback: str = "/accounts") -> str:
    """Only allow same-origin relative redirects (see safe_next)."""
    return safe_next(v, fallback)


def is_https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"


def parse_range(header: str | None, size: int) -> tuple[int, int] | None | str:
    """Parse a single ``Range: bytes=a-b``. None if absent/unsupported, "invalid" if unsatisfiable."""
    if not header:
        return None
    m = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not m or (m.group(1) == "" and m.group(2) == ""):
        return None  # multi-range or garbage → full response
    if m.group(1) == "":
        n = int(m.group(2))  # suffix range: last N bytes
        if n == 0:
            return "invalid"
        start, end = max(0, size - n), size - 1
    else:
        start = int(m.group(1))
        end = size - 1 if m.group(2) == "" else min(int(m.group(2)), size - 1)
    if start >= size or start > end:
        return "invalid"
    return start, end
