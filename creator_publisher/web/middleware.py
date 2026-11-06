"""Login protection for every page and API route, plus the CSRF origin check.

Implemented as plain ASGI middleware so request bodies (video uploads) stream through untouched.
Public: /login, /api/session, /api/health, OAuth callbacks, /static/*.
"""

from __future__ import annotations

from urllib.parse import quote

from starlette.datastructures import Headers
from starlette.responses import JSONResponse, RedirectResponse
from starlette.types import ASGIApp, Receive, Scope, Send

from ..auth import SESSION_COOKIE, get_auth_config, is_cross_origin_write, is_public_path, sessions_valid_after, verify_session


class AuthMiddleware:
    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        path: str = scope["path"]
        server = scope.get("server") or ("", None)
        request_host = headers.get("host") or (f"{server[0]}:{server[1]}" if server[1] else str(server[0]))

        # CSRF: reject state-changing requests from other origins (incl. login/logout).
        if is_cross_origin_write(scope["method"], headers, request_host):
            await JSONResponse({"error": "Cross-origin request blocked"}, status_code=403)(scope, receive, send)
            return
        if is_public_path(path):
            await self.app(scope, receive, send)
            return

        token = _cookie(headers.get("cookie"), SESSION_COOKIE)
        session = verify_session(get_auth_config(), token, None, sessions_valid_after())
        if session:
            scope.setdefault("state", {})["session"] = session
            await self.app(scope, receive, send)
            return

        if path.startswith("/api/"):
            response = JSONResponse({"error": "Unauthorized: log in first (POST /api/session)"}, status_code=401)
        else:
            target = "/login"
            if path != "/":
                qs = scope.get("query_string", b"").decode("latin-1")
                target += "?next=" + quote(path + (f"?{qs}" if qs else ""), safe="")
            response = RedirectResponse(target, status_code=307)
        await response(scope, receive, send)


def _cookie(header: str | None, name: str) -> str | None:
    from urllib.parse import unquote

    for part in (header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == name:
            return unquote(v)
    return None
