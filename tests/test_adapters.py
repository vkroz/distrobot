"""Adapter contract (every platform) + upload request sequences against mocked HTTP."""

import json
import re
from pathlib import Path

import httpx
import pytest

from distrobot.adapters import (
    AdapterError,
    PublishContext,
    PublishRequest,
    get_adapter,
    list_adapters,
)
from distrobot.adapters.platforms.facebook import FacebookAdapter
from distrobot.adapters.platforms.instagram import InstagramAdapter
from distrobot.adapters.platforms.linkedin import LinkedInAdapter
from distrobot.adapters.platforms.tiktok import TikTokAdapter, tiktok_chunks
from distrobot.adapters.platforms.vimeo import VimeoAdapter
from distrobot.adapters.platforms.x import XAdapter
from distrobot.adapters.platforms.youtube import YouTubeAdapter, fit_tags, next_offset_from_range
from distrobot.models import PLATFORM_IDS, ConnectedAccount, Media, TargetContent

pytestmark = pytest.mark.anyio

ROOT = Path(__file__).resolve().parents[1]
SETTINGS = {"tiktok": {"privacyLevel": "PUBLIC_TO_EVERYONE"}}


def account(platform, **metadata):
    return ConnectedAccount("acc", platform, "ext1", "@me", "tok", "ref", None, [], metadata, "", "")


def configure(monkeypatch, adapter):
    for var in adapter.credential_env_vars:
        monkeypatch.setenv(var, f"{var.lower()}-value")


def request_for(platform, path, size, **kw):
    media = Media(mime_type="video/mp4", size_bytes=size, duration_sec=20, width=1920, height=1080, id="m", original_filename="v.mp4")
    return PublishRequest(
        job_id="job1",
        content=TargetContent("Title", "Caption #tag", ["extra"]),
        media=media,
        media_path=str(path),
        visibility="public",
        settings=SETTINGS.get(platform, {}),
        **kw,
    )


@pytest.fixture
def video(tmp_path):
    p = tmp_path / "v.mp4"
    p.write_bytes(bytes(range(256)) * 4000)  # 1,024,000 bytes (> LinkedIn's 75 KB minimum)
    return p


def ctx(handler, platform, checkpoints=None, **kw):
    saved = checkpoints if checkpoints is not None else []
    return PublishContext(
        account=account(platform, **kw.pop("metadata", {})),
        dry_run=False,
        save_checkpoint=saved.append,
        client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
        **kw,
    )


# ---------------------------------------------------------------------------
# Contract: same expectations for every adapter
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("platform", PLATFORM_IDS)
async def test_contract(platform, monkeypatch, video):
    a = get_adapter(platform)
    assert a.platform == platform and a.display_name
    env_example = (ROOT / ".env.example").read_text()
    assert all(v in env_example for v in a.credential_env_vars)
    assert not a.is_configured()
    with pytest.raises(AdapterError) as e:
        a.get_auth_url(state="s", redirect_uri="http://cb")
    assert e.value.code == "not_configured"

    configure(monkeypatch, a)
    assert a.is_configured()
    url = a.get_auth_url(state="s", redirect_uri="http://cb", code_challenge="c" if a.capabilities.pkce else None)
    assert "state=s" in url and "redirect_uri=http%3A%2F%2Fcb" in url

    def no_network(_req):
        raise AssertionError("dry-run must not call the network")

    req = request_for(platform, video, video.stat().st_size)
    res = await a.publish(req, PublishContext(account=None, dry_run=True, simulated_delay_ms=0, client=httpx.AsyncClient(transport=httpx.MockTransport(no_network))))
    assert res.dry_run and res.url == "/dry-run/job1"

    # Validation runs before any network call.
    bad = request_for(platform, video, video.stat().st_size)
    bad.media.mime_type = "application/zip"  # unsupported everywhere
    with pytest.raises(AdapterError) as e:
        await a.publish(bad, PublishContext(account=account(platform), dry_run=False, client=httpx.AsyncClient(transport=httpx.MockTransport(no_network))))
    assert e.value.code == "validation_failed"

    with pytest.raises(AdapterError) as e:
        await a.publish(req, PublishContext(account=None, dry_run=False))
    assert e.value.code == "no_account"

    for status, code, retryable in ((503, "upstream_error", True), (401, "auth_failed", False)):
        with pytest.raises(AdapterError) as e:
            await a.publish(req, ctx(lambda r, s=status: httpx.Response(s, text="nope"), platform, metadata={"pages": [{"id": "p", "name": "P", "accessToken": "pt"}]}))
        assert (e.value.code, e.value.retryable) == (code, retryable)

    def boom(_req):
        raise httpx.ConnectError("down")

    with pytest.raises(AdapterError) as e:
        await a.publish(req, ctx(boom, platform, metadata={"pages": [{"id": "p", "name": "P", "accessToken": "pt"}]}))
    assert e.value.retryable


async def test_oauth_callback_and_refresh(monkeypatch):
    a = get_adapter("youtube")
    configure(monkeypatch, a)

    def handler(r: httpx.Request):
        if "oauth2.googleapis.com/token" in str(r.url):
            form = dict(x.split("=") for x in r.content.decode().split("&"))
            if form["grant_type"] == "refresh_token":
                return httpx.Response(200, json={"access_token": "new", "expires_in": 3600})
            assert form["code"] == "abc" and form["client_secret"] == "youtube_client_secret-value"
            return httpx.Response(200, json={"access_token": "at", "refresh_token": "rt", "expires_in": 3600, "scope": "a b"})
        return httpx.Response(200, json={"items": [{"id": "UC1", "snippet": {"title": "My Channel"}}]})

    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    creds = await a.handle_callback(code="abc", redirect_uri="http://cb", client=client)
    assert (creds.external_id, creds.display_name, creds.refresh_token, creds.scopes) == ("UC1", "My Channel", "rt", ["a", "b"])
    t = await a.refresh_access_token(account("youtube"), client)
    assert t.access_token == "new" and t.refresh_token == "ref"  # Google omits it on refresh: keep the old one

    bad = httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(400, text="invalid_grant")))
    with pytest.raises(AdapterError) as e:
        await a.refresh_access_token(account("youtube"), bad)
    assert e.value.code == "auth_failed"


async def test_x_requires_pkce(monkeypatch):
    a = get_adapter("x")
    configure(monkeypatch, a)
    with pytest.raises(AdapterError):
        a.get_auth_url(state="s", redirect_uri="http://cb")
    assert "code_challenge_method=S256" in a.get_auth_url(state="s", redirect_uri="http://cb", code_challenge="c")


# ---------------------------------------------------------------------------
# Platform request sequences
# ---------------------------------------------------------------------------


def test_helpers():
    assert next_offset_from_range("bytes=0-524287") == 524288 and next_offset_from_range(None) == 0
    assert fit_tags(["a" * 300, "b" * 300]) == ["a" * 300]
    assert tiktok_chunks(3) == (3, 1) and tiktok_chunks(25 * 1024 * 1024) == (10 * 1024 * 1024, 2)


async def test_youtube_resumable_upload_with_resume(video):
    size = video.stat().st_size
    received = bytearray()
    state = {"fail_once": True}

    def handler(r: httpx.Request):
        if r.method == "POST" and "uploadType=resumable" in str(r.url):
            meta = json.loads(r.content)
            assert meta["snippet"]["title"] == "Title" and meta["snippet"]["tags"] == ["extra"]
            return httpx.Response(200, headers={"Location": "https://upload.test/session"})
        if r.method == "PUT" and str(r.url) == "https://upload.test/session":
            rng = r.headers["content-range"]
            if rng == f"bytes */{size}":
                return httpx.Response(308, headers={"Range": f"bytes=0-{len(received) - 1}"})
            start = int(re.match(r"bytes (\d+)-", rng).group(1))
            if start == 262144 and state.pop("fail_once", False):
                return httpx.Response(503, text="backend error")
            assert start == len(received)
            received.extend(r.content)
            if len(received) < size:
                return httpx.Response(308, headers={"Range": f"bytes=0-{len(received) - 1}"})
            return httpx.Response(200, json={"id": "vid1"})
        if "thumbnails/set" in str(r.url):
            return httpx.Response(403, text="forbidden")
        raise AssertionError(f"unexpected {r.method} {r.url}")

    a = YouTubeAdapter(chunk_size=256 * 1024)
    cps: list = []
    req = request_for("youtube", video, size)
    with pytest.raises(AdapterError) as e:
        await a.publish(req, ctx(handler, "youtube", cps))
    assert e.value.retryable and cps[-1] == {"sessionUri": "https://upload.test/session", "totalBytes": size}
    req.checkpoint = cps[-1]  # retry resumes from the saved session
    thumb = video.parent / "t.jpg"
    thumb.write_bytes(b"jpg")
    from distrobot.adapters.types import Thumbnail

    req.thumbnail = Thumbnail(str(thumb), "image/jpeg", 3)
    res = await a.publish(req, ctx(handler, "youtube", cps))
    assert bytes(received) == video.read_bytes()
    assert res.url == "https://www.youtube.com/watch?v=vid1"
    assert any("thumbnail failed" in w for w in res.warnings)


async def test_tiktok_sequence(video):
    calls = []

    def handler(r: httpx.Request):
        path = r.url.path
        calls.append(path)
        if path.endswith("creator_info/query/"):
            return httpx.Response(200, json={"data": {"creator_username": "me", "privacy_level_options": ["PUBLIC_TO_EVERYONE"]}, "error": {"code": "ok"}})
        if path.endswith("video/init/"):
            body = json.loads(r.content)
            assert body["post_info"]["privacy_level"] == "PUBLIC_TO_EVERYONE" and body["post_info"]["disable_comment"] is True
            return httpx.Response(200, json={"data": {"publish_id": "p1", "upload_url": "https://up.test/u"}, "error": {"code": "ok"}})
        if r.url.host == "up.test":
            return httpx.Response(201)
        if path.endswith("status/fetch/"):
            return httpx.Response(200, json={"data": {"status": "PUBLISH_COMPLETE", "publicaly_available_post_id": [42]}, "error": {"code": "ok"}})
        raise AssertionError(path)

    res = await TikTokAdapter(poll_interval_ms=0).publish(request_for("tiktok", video, video.stat().st_size), ctx(handler, "tiktok"))
    assert res.url == "https://www.tiktok.com/@me/video/42"
    assert [c.rsplit("/", 2)[-2] for c in calls if "tiktokapis" in c or c.startswith("/v2")][:2] == ["query", "init"]


async def test_instagram_sequence(video):
    seen = []

    def handler(r: httpx.Request):
        seen.append(f"{r.method} {r.url.host}{r.url.path}")
        if r.url.path.endswith("/media") and r.method == "POST":
            return httpx.Response(200, json={"id": "c1"})
        if r.url.host == "rupload.facebook.com":
            assert r.headers["file_size"] == str(video.stat().st_size)
            return httpx.Response(200, json={"success": True})
        if r.url.path.endswith("/c1"):
            return httpx.Response(200, json={"status_code": "FINISHED"})
        if r.url.path.endswith("media_publish"):
            return httpx.Response(200, json={"id": "m1"})
        if r.url.path.endswith("/m1"):
            return httpx.Response(200, json={"permalink": "https://instagram.com/reel/m1"})
        raise AssertionError(seen[-1])

    res = await InstagramAdapter(poll_interval_ms=0).publish(request_for("instagram", video, video.stat().st_size), ctx(handler, "instagram"))
    assert res.url == "https://instagram.com/reel/m1" and res.external_id == "m1"


async def test_x_sequence(video):
    appended = []

    def handler(r: httpx.Request):
        p = r.url.path
        if p.endswith("/initialize"):
            return httpx.Response(200, json={"data": {"id": "mid"}})
        if p.endswith("/append"):
            appended.append(len(r.content))
            return httpx.Response(204)
        if p.endswith("/finalize"):
            return httpx.Response(200, json={"data": {"id": "mid", "processing_info": {"state": "pending", "check_after_secs": 0}}})
        if p.endswith("/media/upload"):
            return httpx.Response(200, json={"data": {"processing_info": {"state": "succeeded"}}})
        if p.endswith("/tweets"):
            assert json.loads(r.content)["media"]["media_ids"] == ["mid"]
            return httpx.Response(201, json={"data": {"id": "t1"}})
        raise AssertionError(p)

    res = await XAdapter(chunk_size=400_000, poll_interval_ms=0).publish(request_for("x", video, video.stat().st_size), ctx(handler, "x"))
    assert len(appended) == 3 and res.url == "https://x.com/me/status/t1"


async def test_facebook_sequence(video):
    size = video.stat().st_size
    phases = []

    def handler(r: httpx.Request):
        text = r.content.decode("latin-1")

        def field(name):
            m = re.search(rf'name="{name}"\r\n\r\n(\w+)', text)  # multipart (with a file)
            return m.group(1) if m else dict(x.split("=", 1) for x in text.split("&"))[name]  # urlencoded

        phase = field("upload_phase")
        phases.append(phase)
        if phase == "start":
            return httpx.Response(200, json={"upload_session_id": "s", "video_id": "v", "start_offset": "0", "end_offset": str(size // 2)})
        if phase == "transfer":
            start = int(field("start_offset"))
            nxt = size if start else size // 2
            return httpx.Response(200, json={"start_offset": str(nxt), "end_offset": str(nxt if start else size)})
        return httpx.Response(200, json={"success": True})

    res = await FacebookAdapter().publish(
        request_for("facebook", video, size), ctx(handler, "facebook", metadata={"pages": [{"id": "pg", "name": "Page", "accessToken": "pt"}]})
    )
    assert phases == ["start", "transfer", "transfer", "finish"] and res.url == "https://www.facebook.com/pg/videos/v"
    with pytest.raises(AdapterError, match="No Facebook Pages"):
        await FacebookAdapter().publish(request_for("facebook", video, size), ctx(handler, "facebook"))


async def test_linkedin_sequence(video):
    size = video.stat().st_size
    half = size // 2

    def handler(r: httpx.Request):
        u = str(r.url)
        if "initializeUpload" in u:
            return httpx.Response(200, json={"value": {"video": "urn:li:video:1", "uploadToken": "t", "uploadInstructions": [
                {"uploadUrl": "https://up.test/1", "firstByte": 0, "lastByte": half - 1},
                {"uploadUrl": "https://up.test/2", "firstByte": half, "lastByte": size - 1}]}})
        if u.startswith("https://up.test/"):
            return httpx.Response(200, headers={"etag": f"e{u[-1]}"})
        if "finalizeUpload" in u:
            assert json.loads(r.content)["finalizeUploadRequest"]["uploadedPartIds"] == ["e1", "e2"]
            return httpx.Response(200)
        if "/videos/" in u:
            return httpx.Response(200, json={"status": "AVAILABLE"})
        if u.endswith("/posts"):
            return httpx.Response(201, headers={"x-restli-id": "urn:li:share:9"})
        raise AssertionError(u)

    res = await LinkedInAdapter(poll_interval_ms=0).publish(request_for("linkedin", video, size), ctx(handler, "linkedin"))
    assert res.url == "https://www.linkedin.com/feed/update/urn:li:share:9"


async def test_vimeo_sequence(video):
    size = video.stat().st_size
    tags = []

    def handler(r: httpx.Request):
        if r.url.path == "/me/videos":
            return httpx.Response(200, json={"uri": "/videos/7", "link": "https://vimeo.com/7", "upload": {"upload_link": "https://tus.test/u"}})
        if r.url.host == "tus.test":
            return httpx.Response(204, headers={"upload-offset": str(int(r.headers["upload-offset"]) + len(r.content))})
        if r.url.path.endswith("/tags"):
            tags.extend(t["name"] for t in json.loads(r.content))
            return httpx.Response(200)
        raise AssertionError(str(r.url))

    res = await VimeoAdapter(chunk_size=300_000).publish(request_for("vimeo", video, size), ctx(handler, "vimeo"))
    assert res.url == "https://vimeo.com/7" and tags == ["tag", "extra"]


def test_all_adapters_registered():
    assert [a.platform for a in list_adapters()] == list(PLATFORM_IDS)
    assert get_adapter("youtube").capabilities.native_scheduling
