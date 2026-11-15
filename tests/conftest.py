from __future__ import annotations

import os

import pytest

from distrobot.adapters import reset_adapters
from distrobot.auth import login_throttle
from distrobot.db import Database, set_db
from distrobot.jobs.worker import set_worker

CREDENTIAL_VARS = [
    "YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET",
    "INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET", "FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET",
    "X_CLIENT_ID", "X_CLIENT_SECRET", "LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET",
    "VIMEO_CLIENT_ID", "VIMEO_CLIENT_SECRET",
]


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    for k in [*CREDENTIAL_VARS, "DRY_RUN", "APP_ENV", "APP_USERNAME", "APP_PASSWORD", "APP_SESSION_SECRET", "APP_URL", "WORKER_DISABLED"]:
        monkeypatch.delenv(k, raising=False)
    monkeypatch.setenv("UPLOAD_DIR", str(tmp_path / "uploads"))
    reset_adapters()
    login_throttle.reset()
    set_worker(None)
    yield
    reset_adapters()
    set_worker(None)


@pytest.fixture
def db():
    d = Database(":memory:")
    set_db(d)
    yield d
    set_db(None)
    d.close()


@pytest.fixture
def video_file(tmp_path):
    """A small fake video file on disk, registered as media."""
    path = tmp_path / "uploads" / "ab" / "abvideo.mp4"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(os.urandom(300 * 1024))
    return path
