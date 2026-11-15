"""Run the server: ``python -m distrobot [--host 127.0.0.1] [--port 8000] [--reload]``."""

from __future__ import annotations

import argparse
import logging

import uvicorn

from .config import load_dotenv


def main() -> None:
    parser = argparse.ArgumentParser(prog="distrobot", description="Distrobot web server")
    parser.add_argument("--host", default="127.0.0.1", help="bind address (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--reload", action="store_true", help="auto-reload on code changes (development)")
    args = parser.parse_args()
    load_dotenv()
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    # One process only: the publish worker runs inside the server (see jobs/worker.py).
    uvicorn.run("distrobot.web.app:app", host=args.host, port=args.port, reload=args.reload, workers=1)


if __name__ == "__main__":
    main()
