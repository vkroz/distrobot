"""HTTP-level tests: login/session, CSRF, auth gate, uploads, media serving, posts API, ffprobe."""

import shutil
import subprocess
import time

import pytest
from starlette.testclient import TestClient

from distrobot.auth import (
    check_credentials,
    get_auth_config,
    is_cross_origin_write,
    is_public_path,
    safe_next,
    sign_session,
    verify_session,
)
from distrobot.media.probe import ffprobe_args, merge_metadata, parse_ffprobe_output, probe_video
from distrobot.web.app import create_app
from distrobot.web.common import parse_range


@pytest.fixture
def client(db, monkeypatch):
    monkeypatch.setenv("WORKER_DISABLED", "true")
    monkeypatch.setenv("DRY_RUN_DELAY_MS", "0")
    with TestClient(create_app(start_worker=False), base_url="http://testserver", follow_redirects=False) as c:
        yield c


@pytest.fixture
def authed(client):
    r = client.post("/api/session", json={"username": "admin", "password": "admin"})
    assert r.status_code == 200
    return client


# --- auth units --------------------------------------------------------------


def test_auth_config(monkeypatch):
    cfg = get_auth_config({})
    assert cfg.username == "admin" and cfg.using_default_credentials and cfg.disabled_reason is None
    assert "APP_USERNAME" in get_auth_config({"APP_ENV": "production"}).disabled_reason
    assert "APP_SESSION_SECRET" in get_auth_config({"APP_ENV": "production", "APP_USERNAME": "u", "APP_PASSWORD": "p"}).disabled_reason
    assert "16" in get_auth_config({"APP_SESSION_SECRET": "short"}).disabled_reason
    assert check_credentials(cfg, "admin", "admin") and not check_credentials(cfg, "admin", "x")


def test_sessions():
    cfg = get_auth_config({})
    now = time.time() * 1000
    tok = sign_session(cfg, now)
    assert verify_session(cfg, tok, now)["u"] == "admin"
    assert verify_session(cfg, tok, now + 8 * 86400_000) is None  # expired
    assert verify_session(cfg, tok[:-2] + "xx", now) is None  # tampered
    assert verify_session(get_auth_config({"APP_USERNAME": "admin", "APP_PASSWORD": "new"}), tok, now) is None  # password rotated
    assert verify_session(cfg, tok, now, valid_after_ms=now + 1) is None  # revoked by logout


def test_redirect_and_csrf_helpers():
    assert safe_next("/compose?draft=1") == "/compose?draft=1"
    for bad in ("//evil.example", "/\t/evil.example", "/\\evil.example", "https://evil.example", None, "x"):
        assert safe_next(bad) == "/dashboard"
    assert is_public_path("/api/auth/youtube/callback") and not is_public_path("/api/auth/youtube/start")
    h = {"origin": "http://evil.test", "host": "app.test"}
    assert is_cross_origin_write("POST", h, "app.test", {})
    assert not is_cross_origin_write("GET", h, "app.test", {})
    assert not is_cross_origin_write("POST", {"origin": "http://app.test", "host": "app.test"}, "app.test", {})
    assert not is_cross_origin_write("POST", {"origin": "https://pub.example", "host": "internal"}, "internal", {"APP_URL": "https://pub.example"})
    assert is_cross_origin_write("DELETE", {"sec-fetch-site": "same-site"}, "app.test", {})
    assert not is_cross_origin_write("POST", {}, "app.test", {})  # curl
    assert parse_range("bytes=0-9", 100) == (0, 9) and parse_range("bytes=-10", 100) == (90, 99)
    assert parse_range("bytes=200-", 100) == "invalid" and parse_range("bytes=0-1,5-6", 100) is None


# --- HTTP --------------------------------------------------------------------


def test_auth_gate(client):
    assert client.get("/api/health").json()["ok"] is True
    assert client.get("/api/posts").status_code == 401
    r = client.get("/compose?draft=1")
    assert r.status_code == 307 and r.headers["location"] == "/login?next=%2Fcompose%3Fdraft%3D1"
    assert client.get("/login").status_code == 200


def test_login_flow(client):
    r = client.post("/api/session", data={"username": "admin", "password": "bad", "next": "/accounts"})
    assert r.status_code == 303 and r.headers["location"].startswith("/login?error=")
    r = client.post("/api/session", data={"username": "admin", "password": "admin", "next": "//evil.example"})
    assert r.status_code == 303 and r.headers["location"] == "/dashboard"
    assert "httponly" in r.headers["set-cookie"].lower()
    assert client.get("/api/session").json()["authenticated"] is True
    assert client.get("/dashboard").status_code == 200
    client.delete("/api/session")
    assert client.get("/api/posts").status_code == 401


def test_logout_revokes_all_sessions(client):
    client.post("/api/session", json={"username": "admin", "password": "admin"})
    stolen = client.cookies.get("cp_session")
    time.sleep(0.002)
    client.delete("/api/session")
    client.cookies.set("cp_session", stolen)
    assert client.get("/api/posts").status_code == 401


def test_csrf_blocked(authed):
    r = authed.post("/api/posts", json={"action": "draft"}, headers={"Origin": "http://evil.test"})
    assert r.status_code == 403
    assert authed.post("/api/posts", json={"action": "draft"}, headers={"Origin": "http://testserver"}).status_code == 201


def test_upload_and_serve(authed, tmp_path):
    data = bytes(range(256)) * 10
    r = authed.post("/api/media?filename=x.mp4&durationSec=12&width=1080&height=1920", content=data, headers={"Content-Type": "video/mp4"})
    assert r.status_code == 201
    m = r.json()["media"]
    assert m["sizeBytes"] == len(data) and m["metadataSource"] == "client" and m["width"] == 1080  # not a real video → browser values
    r = authed.get(f"/api/media/{m['id']}", headers={"Range": "bytes=10-19"})
    assert r.status_code == 206 and r.content == data[10:20] and r.headers["content-range"] == f"bytes 10-19/{len(data)}"
    r = authed.get(f"/api/media/{m['id']}")
    assert r.content == data and r.headers["x-content-type-options"] == "nosniff" and "sandbox" in r.headers["content-security-policy"]
    assert authed.get(f"/api/media/{m['id']}", headers={"Range": "bytes=99999-"}).status_code == 416
    assert authed.post("/api/media?filename=x.svg", content=b"<svg/>", headers={"Content-Type": "image/svg+xml"}).status_code == 415
    assert authed.post("/api/media?filename=x.html", content=b"<p>", headers={"Content-Type": "video/mp4", "Content-Length": "999"}).status_code in (400,)


def test_posts_api(authed):
    up = authed.post("/api/media?filename=x.mp4&durationSec=20&width=1080&height=1920", content=b"0" * 2048, headers={"Content-Type": "video/mp4"})
    mid = up.json()["media"]["id"]
    r = authed.post("/api/posts", json={"title": "T", "caption": "C", "mediaId": mid, "action": "draft", "targets": [{"platform": "youtube"}]})
    assert r.status_code == 201
    pid = r.json()["post"]["id"]
    assert authed.get(f"/api/posts/{pid}").json()["post"]["targets"][0]["job"] is None
    assert authed.get(f"/compose?draft={pid}").status_code == 200
    r = authed.post(f"/api/posts/{pid}/publish", json={"scheduledAt": None, "dryRun": True})
    assert r.status_code == 200 and len(r.json()["jobs"]) == 1
    assert authed.post("/api/jobs/run").status_code == 200  # publish already kicked the worker; this waits for the rest
    for _ in range(50):
        job = authed.get(f"/api/posts/{pid}").json()["post"]["targets"][0]["job"]
        if job["status"] == "published":
            break
        time.sleep(0.02)
    assert job["status"] == "published"
    assert authed.get(job["resultUrl"]).status_code == 200  # dry-run page
    assert authed.put(f"/api/posts/{pid}", json={"title": "x", "action": "draft"}).status_code == 409
    assert authed.post(f"/api/jobs/{job['id']}/retry").status_code == 409
    v = authed.post("/api/posts", json={"mediaId": mid, "targets": [{"platform": "tiktok"}]})
    assert v.status_code == 422 and v.json()["validation"][0]["platform"] == "tiktok"
    assert authed.post("/api/posts", content=b"{nope", headers={"Content-Type": "application/json"}).status_code == 400
    assert authed.delete(f"/api/posts/{pid}").status_code == 200
    assert authed.get(f"/api/posts/{pid}").status_code == 404
    for page in ("/dashboard", "/dashboard?view=calendar", "/accounts", "/compose"):
        assert authed.get(page).status_code == 200, page


def test_validate_endpoint(authed):
    r = authed.post("/api/validate", json={"content": {"title": "", "caption": "x" * 300}, "platforms": ["x", "youtube"]})
    res = {x["platform"]: x for x in r.json()["results"]}
    assert not res["x"]["ok"] and not res["youtube"]["ok"]
    r = authed.post("/api/validate", json={"content": {"caption": "hi"}, "targets": [{"platform": "x", "captionOverride": "y" * 300}, {"platform": "tiktok", "settings": {}}]})
    res = {x["platform"]: x for x in r.json()["results"]}
    assert res["x"]["errors"][0]["code"] == "caption_too_long" and res["x"]["requirements"]
    assert res["tiktok"]["errors"][0]["code"] == "tiktok_privacy_required"
    assert authed.post("/api/validate", json={"content": {}, "platforms": ["myspace"]}).status_code == 400


def test_accounts_and_oauth(authed, monkeypatch, db):
    data = authed.get("/api/accounts").json()
    assert data["dryRunMode"] == "auto" and all(p["dryRun"] for p in data["platforms"])
    r = authed.get("/api/auth/youtube/start?returnTo=/accounts")
    assert r.status_code == 303 and r.headers["location"].startswith("/accounts?error=")
    monkeypatch.setenv("YOUTUBE_CLIENT_ID", "id")
    monkeypatch.setenv("YOUTUBE_CLIENT_SECRET", "secret")
    r = authed.get("/api/auth/youtube/start?returnTo=//evil.example")
    assert r.headers["location"].startswith("https://accounts.google.com/")
    r = authed.get("/api/auth/youtube/callback?state=bogus&code=x")
    assert r.headers["location"].startswith("/accounts?error=Authorization%20expired")
    assert authed.get("/api/tiktok/creator-info").json()["source"] == "mock"


# --- ffprobe -----------------------------------------------------------------


def test_parse_ffprobe_output():
    out = {
        "streams": [
            {"codec_type": "video", "disposition": {"attached_pic": 1}, "width": 10, "height": 10},
            {"codec_type": "video", "codec_name": "h264", "width": 1920, "height": 1080, "side_data_list": [{"rotation": -90}]},
        ],
        "format": {"duration": "12.5", "format_name": "mov,mp4"},
    }
    r = parse_ffprobe_output(out)
    assert (r.width, r.height, r.duration_sec, r.codec) == (1080, 1920, 12.5, "h264")
    assert parse_ffprobe_output({"streams": [{"codec_type": "audio"}]}) is None
    assert merge_metadata({"duration_sec": 3, "width": 1}, r)["source"] == "ffprobe"
    assert merge_metadata({"duration_sec": 3}, None) == {"duration_sec": 3, "width": None, "height": None, "source": "client"}
    args = ffprobe_args("/tmp/x.mp4")
    assert "-protocol_whitelist" in args and args[-1] == "file:/tmp/x.mp4"


@pytest.mark.anyio
async def test_probe_missing_binary(tmp_path):
    f = tmp_path / "x.mp4"
    f.write_bytes(b"not a video")
    assert await probe_video(str(f), candidates=["/nonexistent/ffprobe"]) is None


@pytest.mark.anyio
@pytest.mark.skipif(not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg not installed")
async def test_probe_real_video(tmp_path):
    f = tmp_path / "v.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2", "-pix_fmt", "yuv420p", str(f)], check=True)
    r = await probe_video(str(f))
    assert (r.width, r.height) == (320, 240) and r.duration_sec == pytest.approx(2, abs=0.2)
    bad = tmp_path / "list.m3u8"
    bad.write_text("#EXTM3U\n#EXTINF:1,\nhttp://169.254.169.254/latest\n")
    assert await probe_video(str(bad)) is None  # playlists are never followed
