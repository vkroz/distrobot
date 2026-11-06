"""HTTP helpers shared by adapters: error classification, chunk reads, polling."""

from __future__ import annotations

import asyncio
import json
import re
import time
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

import httpx

from .types import AdapterError

T = TypeVar("T")

DEFAULT_TIMEOUT = httpx.Timeout(60.0, connect=15.0)


def make_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, follow_redirects=False)


def error_from_response(platform: str, status: int, body: str) -> AdapterError:
    """Map an HTTP failure to an AdapterError with a sensible retry policy."""
    msg = f"{platform} API {status}: {body[:500]}"
    if status == 401:
        return AdapterError("auth_failed", msg, False, {"status": status})
    if status == 403 and re.search(r"quota|limitExceeded|uploadLimit|rateLimit", body, re.I):
        return AdapterError("quota_exceeded", msg, False, {"status": status})
    if status in (408, 429):
        return AdapterError("rate_limited", msg, True, {"status": status})
    if status >= 500:
        return AdapterError("upstream_error", msg, True, {"status": status})
    return AdapterError("upstream_error", msg, False, {"status": status})


async def request(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    platform: str,
    allow_statuses: tuple[int, ...] = (),
    **kwargs: Any,
) -> httpx.Response:
    """Network errors are retryable; HTTP errors are classified. ``allow_statuses`` are returned, not raised."""
    try:
        res = await client.request(method, url, **kwargs)
    except httpx.HTTPError as err:
        raise AdapterError("upstream_error", f"{platform} network error: {err}", True) from err
    if res.is_success or res.status_code in allow_statuses:
        return res
    raise error_from_response(platform, res.status_code, res.text)


async def request_json(client: httpx.AsyncClient, method: str, url: str, *, platform: str, **kwargs: Any) -> Any:
    res = await request(client, method, url, platform=platform, **kwargs)
    return json.loads(res.text) if res.text else {}


def read_file_chunk(path: str, offset: int, length: int) -> bytes:
    """Read ``length`` bytes starting at ``offset`` (short read at EOF)."""
    with open(path, "rb") as fh:
        fh.seek(offset)
        return fh.read(length)


async def sleep_ms(ms: float) -> None:
    if ms > 0:
        await asyncio.sleep(ms / 1000)


async def poll_until(
    check: Callable[[], Awaitable[T | None]], *, interval_ms: float, timeout_ms: float, platform: str
) -> T:
    """Poll ``check`` until it returns a non-None value. Raises a retryable error on timeout
    (the platform may still be processing; a retry can pick up from a checkpoint)."""
    deadline = time.monotonic() + timeout_ms / 1000
    while True:
        result = await check()
        if result is not None:
            return result
        if time.monotonic() + interval_ms / 1000 > deadline:
            raise AdapterError("upstream_error", f"{platform} processing timed out", True)
        await sleep_ms(interval_ms)


def bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}
