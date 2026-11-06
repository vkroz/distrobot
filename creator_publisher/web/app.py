"""ASGI application: routes, auth middleware, static files, and the in-process worker lifecycle."""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Mount
from starlette.staticfiles import StaticFiles

from ..jobs.worker import get_worker, worker_disabled
from . import api, pages
from .middleware import AuthMiddleware

log = logging.getLogger("creator_publisher")


@asynccontextmanager
async def lifespan(app: Starlette) -> AsyncIterator[None]:
    # Start the publish worker at boot so scheduled jobs run without a page visit.
    worker = get_worker()
    if not worker_disabled():
        worker.start()
    try:
        yield
    finally:
        # Release the lease on shutdown so a restarted server can take over immediately.
        await worker.stop()


async def not_found(request: Request, exc: Exception) -> Response:
    if request.url.path.startswith("/api/"):
        return JSONResponse({"error": "Not found"}, status_code=404)
    return pages.render(request, "not_found.html", status=404)


def create_app(*, start_worker: bool = True) -> Starlette:
    return Starlette(
        routes=[
            *api.routes,
            *pages.routes,
            Mount("/static", StaticFiles(directory=str(Path(__file__).parent / "static")), name="static"),
        ],
        middleware=[Middleware(AuthMiddleware)],
        exception_handlers={404: not_found},
        lifespan=lifespan if start_worker else None,
    )


app = create_app()
