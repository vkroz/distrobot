"""Single-admin login: credentials from env, stateless HMAC-signed session cookie.

    APP_USERNAME / APP_PASSWORD   — the one admin account
    APP_SESSION_SECRET            — HMAC key for session cookies (≥ 16 chars)

Development: unset values fall back to admin / admin and a fixed dev secret (a warning is shown).
Production (APP_ENV=production): all three are required, otherwise login is disabled.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any
from urllib.parse import unquote, urlsplit

from .db import Database, get_db

SESSION_COOKIE = "cp_session"
SESSION_TTL_SEC = 7 * 24 * 60 * 60
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "admin"
_DEV_SECRET = "dev-only-insecure-session-secret-change-me"
MIN_SECRET_LENGTH = 16


@dataclass
class AuthConfig:
    username: str
    password: str
    secret: str
    #: Default demo credentials are in use (dev only).
    using_default_credentials: bool
    using_default_secret: bool
    #: When set, login is impossible (misconfigured production).
    disabled_reason: str | None


def is_production(env: Mapping[str, str] | None = None) -> bool:
    env = os.environ if env is None else env
    return (env.get("APP_ENV") or "").lower() == "production"


def get_auth_config(env: Mapping[str, str] | None = None) -> AuthConfig:
    env = os.environ if env is None else env
    prod = is_production(env)
    has_creds = bool(env.get("APP_USERNAME")) and bool(env.get("APP_PASSWORD"))
    secret = env.get("APP_SESSION_SECRET") or ""
    disabled = None
    if prod and not has_creds:
        disabled = "Login is disabled: set APP_USERNAME and APP_PASSWORD."
    elif prod and not secret:
        disabled = "Login is disabled: set APP_SESSION_SECRET."
    elif secret and len(secret) < MIN_SECRET_LENGTH:
        disabled = f"Login is disabled: APP_SESSION_SECRET must be at least {MIN_SECRET_LENGTH} characters."
    return AuthConfig(
        username=env["APP_USERNAME"] if has_creds else DEFAULT_USERNAME,
        password=env["APP_PASSWORD"] if has_creds else DEFAULT_PASSWORD,
        secret=secret or _DEV_SECRET,
        using_default_credentials=not has_creds,
        using_default_secret=not secret,
        disabled_reason=disabled,
    )


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _hmac(cfg: AuthConfig, data: str) -> bytes:
    """The key also depends on the password, so changing the password invalidates existing sessions."""
    key = hashlib.sha256(f"{cfg.secret}\0{cfg.password}".encode()).digest()
    return hmac.new(key, data.encode(), hashlib.sha256).digest()


def sign_session(cfg: AuthConfig, now_ms: float | None = None) -> str:
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    iat = int(now_ms // 1000)
    payload = _b64url(json.dumps({"u": cfg.username, "iat": iat, "exp": iat + SESSION_TTL_SEC, "t": int(now_ms)}).encode())
    return f"{payload}.{_b64url(_hmac(cfg, payload))}"


def verify_session(cfg: AuthConfig, token: str | None, now_ms: float | None = None, valid_after_ms: float = 0) -> dict[str, Any] | None:
    """Returns the session payload, or None. Sessions issued before ``valid_after_ms`` are revoked (logout)."""
    if not token or cfg.disabled_reason:
        return None
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    payload, _, sig = token.partition(".")
    if not payload or not sig:
        return None
    try:
        given = _b64url_decode(sig)
    except ValueError:
        return None
    if not hmac.compare_digest(given, _hmac(cfg, payload)):
        return None
    try:
        s = json.loads(_b64url_decode(payload))
    except ValueError:
        return None
    if not isinstance(s, dict) or s.get("u") != cfg.username or not isinstance(s.get("exp"), (int, float)):
        return None
    if s["exp"] * 1000 <= now_ms:
        return None
    issued = s.get("t") if isinstance(s.get("t"), (int, float)) else s.get("iat", 0) * 1000
    if issued < valid_after_ms:
        return None
    return s


def check_credentials(cfg: AuthConfig, username: str, password: str) -> bool:
    """Constant-time credential check."""
    if cfg.disabled_reason:
        return False

    def digest(v: str) -> bytes:
        return hashlib.sha256(v.encode()).digest()

    user_ok = hmac.compare_digest(digest(username), digest(cfg.username))
    pass_ok = hmac.compare_digest(digest(password), digest(cfg.password))
    return user_ok and pass_ok


def is_public_path(path: str) -> bool:
    """Paths reachable without a session."""
    return (
        path in ("/login", "/api/session", "/api/health")
        or path.startswith("/static/")
        # OAuth providers redirect here; protected by the single-use `state` created by a logged-in user.
        or re.fullmatch(r"/api/auth/[a-z]+/callback", path) is not None
    )


def safe_next(nxt: str | None, fallback: str = "/dashboard") -> str:
    """Only allow same-origin relative redirect targets (after login / OAuth).

    Normalizes the value the way a browser would — it strips tabs/newlines and treats "\\" as "/", so
    "/\\t/evil.example" becomes "//evil.example" — and accepts it only if it stays on our origin.
    """
    if not nxt or not nxt.startswith("/"):
        return fallback
    cleaned = re.sub(r"[\t\n\r]", "", nxt).replace("\\", "/")
    if cleaned.startswith("//"):
        return fallback
    parts = urlsplit(cleaned)
    if parts.scheme or parts.netloc:
        return fallback
    return cleaned


_STATE_CHANGING = {"POST", "PUT", "PATCH", "DELETE"}


def is_cross_origin_write(method: str, headers: Mapping[str, str], request_host: str, env: Mapping[str, str] | None = None) -> bool:
    """CSRF guard for cookie-authenticated, state-changing requests.

    SameSite=Lax stops cross-*site* requests from carrying the session cookie, but not same-site ones
    (another port on localhost, a sibling subdomain). Browsers send ``Origin`` on cross-origin
    POST/PUT/PATCH/DELETE requests (and ``Sec-Fetch-Site``), so it must be our own origin.
    Non-browser clients (curl, scripts) send neither header and are allowed.
    """
    env = os.environ if env is None else env
    if method.upper() not in _STATE_CHANGING:
        return False
    origin = headers.get("origin")
    if origin:
        try:
            origin_host = urlsplit(origin).netloc
        except ValueError:
            return True
        if not origin_host:
            return True  # "null" (sandboxed/file) or garbage
        allowed = {request_host}
        host = headers.get("x-forwarded-host") or headers.get("host")
        if host:
            allowed.add(host.split(",")[0].strip())
        if env.get("APP_URL"):
            try:
                allowed.add(urlsplit(env["APP_URL"]).netloc)
            except ValueError:
                pass
        return origin_host not in allowed
    return headers.get("sec-fetch-site") in ("cross-site", "same-site")


def session_from_cookie_header(cookie_header: str | None, cfg: AuthConfig | None = None, valid_after_ms: float = 0) -> dict[str, Any] | None:
    m = re.search(rf"(?:^|;\s*){SESSION_COOKIE}=([^;]+)", cookie_header or "")
    token = unquote(m.group(1)) if m else None
    return verify_session(cfg or get_auth_config(), token, None, valid_after_ms)


# ---------------------------------------------------------------------------
# Session revocation: logout records the time and older sessions are rejected (single admin → all devices).
# ---------------------------------------------------------------------------

_REVOKE_KEY = "sessions_valid_after"


def sessions_valid_after(db: Database | None = None) -> float:
    try:
        row = (db or get_db()).one("SELECT value FROM app_settings WHERE key = ?", (_REVOKE_KEY,))
        return float(row["value"]) if row else 0
    except Exception:  # noqa: BLE001
        return 0


def revoke_all_sessions(db: Database | None = None, now_ms: float | None = None) -> None:
    (db or get_db()).execute(
        "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        (_REVOKE_KEY, str(int(time.time() * 1000 if now_ms is None else now_ms))),
    )


# ---------------------------------------------------------------------------
# Login throttling — global, not per-IP: client IPs / X-Forwarded-For are spoofable, and a per-IP
# lockout would let anyone lock the admin out. Once failures pile up, attempts are serialized with a
# growing delay, and excess concurrent attempts are rejected fast (429). In-memory (single instance).
# ---------------------------------------------------------------------------


class LoginThrottle:
    def __init__(self, window_ms: int = 15 * 60_000, free_failures: int = 5, max_delay_ms: int = 5_000, max_pending: int = 20):
        self.window_ms = window_ms
        #: Failures within the window before slowing down.
        self.free_failures = free_failures
        self.max_delay_ms = max_delay_ms
        #: Max login attempts waiting in line.
        self.max_pending = max_pending
        self.reset()

    def reset(self) -> None:
        self.failures: list[float] = []
        self.pending = 0
        self._lock: asyncio.Lock | None = None

    def delay_ms(self, now_ms: float | None = None) -> float:
        """Delay applied to the next attempt, given recent failures."""
        now_ms = time.time() * 1000 if now_ms is None else now_ms
        self.failures = [t for t in self.failures if now_ms - t < self.window_ms]
        excess = len(self.failures) - self.free_failures
        return 0 if excess < 0 else min(self.max_delay_ms, 250 * 2**excess)

    async def attempt(self, check: Callable[[], bool], count_failures: bool = True) -> bool | None:
        """Run ``check()`` (→ success) in a throttled slot. None if too many attempts are queued."""
        if self.pending >= self.max_pending:
            return None
        if self._lock is None:
            self._lock = asyncio.Lock()
        self.pending += 1
        try:
            async with self._lock:
                delay = self.delay_ms()
                if delay:
                    await asyncio.sleep(delay / 1000)
                ok = bool(check())
                if not ok and count_failures:
                    self.failures.append(time.time() * 1000)
                    self.failures = self.failures[-1000:]
                return ok
        finally:
            self.pending -= 1


login_throttle = LoginThrottle()
