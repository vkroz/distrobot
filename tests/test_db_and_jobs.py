from datetime import timedelta

import pytest

from creator_publisher.db import Database
from creator_publisher.db import repo
from creator_publisher.jobs.lease import acquire_lease, is_dead_local_owner, read_lease, release_lease, renew_lease
from creator_publisher.jobs.state import can_transition, derive_post_status, retry_delay_ms
from creator_publisher.models import iso, now_utc


def make_post(db, platforms=("youtube",), **kw):
    m = repo.create_media(db, original_filename="v.mp4", storage_path="ab/v.mp4", mime_type="video/mp4", size_bytes=10)
    p = repo.create_post(db, title="T", caption="C", media_id=m.id, **kw)
    for pl in platforms:
        repo.upsert_target(db, p.id, pl)
    return p


def test_migrations_idempotent(tmp_path):
    path = str(tmp_path / "x.db")
    d = Database(path)
    assert d.schema_version() == 4
    d.close()
    d = Database(path)
    assert d.schema_version() == 4
    d.close()


def test_transactions_nest_with_savepoints(db):
    with db.transaction():
        repo.create_post(db, title="outer")
        with pytest.raises(RuntimeError):
            with db.transaction():
                repo.create_post(db, title="inner")
                raise RuntimeError
    assert [p.title for p in repo.list_posts(db)] == ["outer"]


def test_state_machine():
    assert can_transition("queued", "uploading") and not can_transition("published", "queued")
    assert retry_delay_ms(1) == 30_000 and retry_delay_ms(2) == 60_000 and retry_delay_ms(20) == 30 * 60_000
    future = iso(now_utc() + timedelta(hours=1))
    assert derive_post_status([]) == "draft"
    assert derive_post_status([{"status": "queued", "attempts": 0, "next_run_at": future}]) == "scheduled"
    assert derive_post_status([{"status": "queued", "attempts": 1, "next_run_at": future}]) == "publishing"
    assert derive_post_status(["published", "failed"]) == "partial"
    assert derive_post_status(["failed"]) == "failed"


def test_targets_upsert_keeps_omitted(db):
    p = make_post(db)
    repo.upsert_target(db, p.id, "youtube", title_override="X", settings={"a": 1})
    t = repo.upsert_target(db, p.id, "youtube", caption_override="Y")
    assert (t.title_override, t.caption_override, t.settings) == ("X", "Y", {"a": 1})
    t = repo.upsert_target(db, p.id, "youtube", title_override=None)
    assert t.title_override is None


def test_job_lifecycle(db):
    p = make_post(db, ("youtube", "tiktok"))
    jobs = repo.enqueue_publish(db, p.id)
    assert len(jobs) == 2 and repo.get_post(db, p.id).status == "publishing"
    assert repo.enqueue_publish(db, p.id) == []  # no duplicates while active
    j = repo.claim_next_job(db)
    assert j.status == "uploading" and j.attempts == 1
    j = repo.mark_job_failed(db, j.id, "boom")  # retryable → re-queued with backoff
    assert j.status == "queued" and j.error == "boom"
    j2 = repo.claim_next_job(db)
    repo.mark_job_published(db, j2.id, url="u", payload={"x": 1}, warnings=["w"])
    assert repo.get_job(db, j2.id).result_payload == {"x": 1, "warnings": ["w"]}
    j = repo.mark_job_failed(db, repo.claim_next_job(db, now_utc() + timedelta(hours=1)).id, "fatal", retryable=False)
    assert j.status == "failed" and repo.get_post(db, p.id).status == "partial"
    j = repo.retry_job(db, j.id)
    assert j.status == "queued" and j.max_attempts >= j.attempts + 1
    with pytest.raises(ValueError):
        repo.retry_job(db, j2.id)  # published → queued is invalid


def test_orphan_recovery(db):
    p = make_post(db, ("youtube", "tiktok", "x"))
    repo.enqueue_publish(db, p.id)
    a, b, c = (repo.claim_next_job(db) for _ in range(3))
    repo.save_job_checkpoint(db, b.id, {"k": 1})
    out = {j.id: j for j in repo.requeue_orphaned_jobs(db, exclude=[c.id], can_auto_retry=lambda j: j.checkpoint is not None)}
    assert out[b.id].status == "queued" and "re-queued automatically" in out[b.id].error
    assert out[a.id].status == "failed" and "may already have been posted" in out[a.id].error
    assert c.id not in out


def test_oauth_state_single_use(db):
    repo.create_oauth_state(db, state="s1", platform="x", redirect_uri="r", code_verifier="v")
    assert repo.consume_oauth_state(db, "s1", "youtube") is None  # wrong platform also consumes it
    repo.create_oauth_state(db, state="s2", platform="x", redirect_uri="r")
    assert repo.consume_oauth_state(db, "s2", "x")["redirect_uri"] == "r"
    assert repo.consume_oauth_state(db, "s2", "x") is None


def test_accounts_upsert_keeps_refresh_token(db):
    a = repo.upsert_account(db, platform="x", external_id="1", display_name="@a", access_token="t1", refresh_token="r1")
    b = repo.upsert_account(db, platform="x", external_id="1", display_name="@a", access_token="t2")
    assert a.id == b.id and b.access_token == "t2" and b.refresh_token == "r1"


def test_orphan_media_gc(db):
    used = make_post(db)
    stray = repo.create_media(db, original_filename="s.mp4", storage_path="cd/s.mp4")
    assert repo.delete_orphan_media(db, 0, now_utc() + timedelta(seconds=1)) == ["cd/s.mp4"]
    assert repo.get_media(db, stray.id) is None and repo.get_media(db, used.media_id)


def test_lease(db):
    assert acquire_lease(db, "h:1:a", 60_000)
    assert not acquire_lease(db, "h:2:b", 60_000)
    assert acquire_lease(db, "h:2:b", 60_000, is_abandoned=lambda o: True)
    assert not renew_lease(db, "h:1:a") and renew_lease(db, "h:2:b")
    assert acquire_lease(db, "h:3:c", 60_000, now_utc() + timedelta(minutes=5))  # stale takeover
    release_lease(db, "h:3:c")
    assert read_lease(db) is None


def test_dead_local_owner():
    import os

    assert not is_dead_local_owner(f"host:{os.getpid()}:x", "other")
    assert is_dead_local_owner(f"host:{os.getpid()}:old", "host", f"host:{os.getpid()}:new")
    assert not is_dead_local_owner(f"host:{os.getpid()}:me", "host", f"host:{os.getpid()}:me")
    assert is_dead_local_owner("host:99999999:x", "host")
