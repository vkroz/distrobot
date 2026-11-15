from datetime import timedelta

import pytest

from distrobot.adapters import AdapterError, YouTubeAdapter, register_adapter
from distrobot.adapters.types import DoPublishResult, RefreshedTokens
from distrobot.db import repo
from distrobot.jobs.runner import RunnerOptions, dry_run_mode_from_env, execute_job
from distrobot.jobs.worker import PublishWorker
from distrobot.models import iso, now_utc
from distrobot.services.posts import (
    ComposeError,
    compose_post,
    delete_post_and_orphans,
    parse_compose_input,
    publish_draft,
    update_draft,
)

pytestmark = pytest.mark.anyio

TIKTOK_OK = {"privacyLevel": "PUBLIC_TO_EVERYONE"}


def media(db, video_file, **kw):
    return repo.create_media(
        db,
        original_filename="v.mp4",
        storage_path="ab/abvideo.mp4",
        mime_type="video/mp4",
        size_bytes=video_file.stat().st_size,
        duration_sec=kw.get("duration", 20),
        width=1080,
        height=1920,
    )


def body(media_id, platforms=("youtube", "tiktok", "instagram"), **kw):
    targets = [{"platform": p, **({"settings": TIKTOK_OK} if p == "tiktok" else {})} for p in platforms]
    return {"title": "Hello", "caption": "World #demo", "hashtags": ["x"], "mediaId": media_id, "visibility": "public", "targets": targets, **kw}


def worker(db, owner=None, **kw):
    return PublishWorker(db, RunnerOptions(simulated_delay_ms=0, **kw), concurrency=2, owner=owner)


def test_dry_run_mode_env():
    assert dry_run_mode_from_env({"DRY_RUN": "true"}) == "on"
    assert dry_run_mode_from_env({"DRY_RUN": "0"}) == "off"
    assert dry_run_mode_from_env({}) == "auto"


async def test_dry_run_end_to_end(db, video_file):
    m = media(db, video_file)
    res = compose_post(db, parse_compose_input(body(m.id)))
    assert len(res.jobs) == 3 and res.post.status == "publishing"
    done = await worker(db).run_due()
    assert sorted(j.status for j in done) == ["published"] * 3
    assert all(j.result_url == f"/dry-run/{j.id}" and j.result_payload["dryRun"] for j in done)
    assert repo.get_post(db, res.post.id).status == "published"


async def test_validation_blocks_publish(db, video_file):
    m = media(db, video_file)
    with pytest.raises(ComposeError) as e:
        compose_post(db, parse_compose_input(body(m.id, ("tiktok",), caption="x") | {"targets": [{"platform": "tiktok"}]}))
    assert e.value.status == 422 and "TikTok" in e.value.message
    with pytest.raises(ComposeError) as e:
        parse_compose_input({"action": "publish", "targets": []})
    assert e.value.status == 400


async def test_scheduling_native_vs_queued(db, video_file):
    m = media(db, video_file)
    when = iso(now_utc() + timedelta(hours=2))
    res = compose_post(db, parse_compose_input(body(m.id, ("youtube", "instagram"), scheduledAt=when)))
    by = {j.platform: j for j in res.jobs}
    assert by["instagram"].next_run_at == when
    assert by["youtube"].next_run_at < when  # YouTube uploads now with publishAt
    done = await worker(db).run_due()
    assert [j.platform for j in done] == ["youtube"]
    assert done[0].result_payload["scheduledAt"] == when
    assert repo.get_post(db, res.post.id).status == "scheduled"
    with pytest.raises(ComposeError, match="past"):
        compose_post(db, parse_compose_input(body(m.id, scheduledAt=iso(now_utc() - timedelta(hours=1)))))


async def test_drafts(db, video_file):
    d = compose_post(db, parse_compose_input({"title": "Idea", "action": "draft"}))
    assert d.post.status == "draft" and d.jobs == []
    m = media(db, video_file)
    d = update_draft(db, d.post.id, parse_compose_input(body(m.id, ("youtube", "vimeo"), action="draft")))
    assert [t.platform for t in d.targets] == ["youtube", "vimeo"]
    d = update_draft(db, d.post.id, parse_compose_input(body(m.id, ("youtube",), action="draft")))
    assert [t.platform for t in repo.list_targets(db, d.post.id)] == ["youtube"]
    pub = publish_draft(db, d.post.id, scheduled_at=None)
    assert len(pub.jobs) == 1
    with pytest.raises(ComposeError) as e:
        update_draft(db, d.post.id, parse_compose_input(body(m.id, action="draft")))
    assert e.value.status == 409
    assert delete_post_and_orphans(db, d.post.id) == ["ab/abvideo.mp4"]


class FlakyYouTube(YouTubeAdapter):
    """Configured adapter whose real upload is scripted."""

    def __init__(self, script):
        super().__init__()
        self.script = list(script)
        self.calls = []
        self.refreshed = 0

    def is_configured(self):
        return True

    async def do_publish(self, req, ctx, validation):
        self.calls.append(ctx.account.access_token)
        step = self.script.pop(0)
        if isinstance(step, Exception):
            raise step
        return DoPublishResult(url="https://youtu.be/1", external_id="1")

    async def refresh_access_token(self, account, client=None):
        self.refreshed += 1
        return RefreshedTokens("fresh", account.refresh_token, iso(now_utc() + timedelta(hours=1)))


async def run_one(db, video_file, adapter):
    register_adapter(adapter)
    m = media(db, video_file)
    repo.upsert_account(db, platform="youtube", external_id="c", display_name="Chan", access_token="old", refresh_token="r")
    res = compose_post(db, parse_compose_input(body(m.id, ("youtube",))))
    job = repo.claim_next_job(db)
    return res, await execute_job(db, job, RunnerOptions(dry_run_mode="auto", simulated_delay_ms=0))


async def test_retryable_error_requeues(db, video_file):
    _, job = await run_one(db, video_file, FlakyYouTube([AdapterError("upstream_error", "503", True)]))
    assert job.status == "queued" and job.error == "503"


async def test_non_retryable_error_fails(db, video_file):
    _, job = await run_one(db, video_file, FlakyYouTube([AdapterError("quota_exceeded", "quota", False)]))
    assert job.status == "failed"


async def test_auth_failure_refreshes_once(db, video_file):
    a = FlakyYouTube([AdapterError("auth_failed", "401"), None])
    _, job = await run_one(db, video_file, a)
    assert job.status == "published" and a.calls == ["old", "fresh"] and a.refreshed == 1
    assert repo.list_accounts(db, "youtube")[0].access_token == "fresh"


async def test_standby_worker_claims_nothing(db, video_file):
    m = media(db, video_file)
    compose_post(db, parse_compose_input(body(m.id, ("youtube",))))
    # Holder on another host: a live process we must not steal from.
    holder, standby = worker(db, owner="otherhost:1:a"), worker(db)
    holder.heartbeat()
    holder._lease_mode = True
    standby._lease_mode = True
    standby.heartbeat()
    assert holder.holds_lease and not standby.holds_lease
    assert await standby.run_due_exclusive() is None
    assert len(await holder.run_due_exclusive()) == 1


async def test_recovery_on_lease_acquire(db, video_file):
    m = media(db, video_file)
    compose_post(db, parse_compose_input(body(m.id, ("youtube",), dryRun=True)))
    job = repo.claim_next_job(db)  # a "crashed" process left it uploading
    w = worker(db)
    w.heartbeat()
    assert [j.id for j in w.last_recovered] == [job.id]
    assert repo.get_job(db, job.id).status == "queued"  # dry-run → safe to auto-retry
