"""In-process publish worker. Polls for due jobs and runs up to ``concurrency`` at once.

Restart safety: ``start()`` takes a SQLite lease (see lease.py). Only the lease holder claims jobs and
recovers jobs orphaned in ``uploading`` by a crashed process. A second process on the same DB stays in
standby and takes over if the holder's heartbeat goes stale. Still: run one app instance.
"""

from __future__ import annotations

import asyncio
import logging
import os
import socket
import time
import uuid
from typing import Any

from ..db import Database, get_db
from ..db import repo
from ..models import PublishJob, now_utc
from ..storage import delete_stored_file
from .lease import acquire_lease, is_dead_local_owner, read_lease, release_lease, renew_lease
from .runner import RunnerOptions, execute_job, should_dry_run

log = logging.getLogger("creator_publisher.worker")

HOUR_MS = 60 * 60_000


def _env_int(name: str, fallback: int) -> int:
    try:
        n = int(os.environ.get(name, ""))
    except ValueError:
        return fallback
    return n if n >= 0 else fallback


class PublishWorker:
    def __init__(
        self,
        db: Database,
        opts: RunnerOptions | None = None,
        *,
        concurrency: int = 2,
        interval_ms: int = 5000,
        lease_stale_ms: int | None = None,
        owner: str | None = None,
        orphan_media_max_age_ms: int = 24 * HOUR_MS,
    ):
        self.db = db
        self.opts = opts or RunnerOptions()
        self.concurrency = max(1, concurrency)
        self.interval_ms = interval_ms
        self.hostname = socket.gethostname()
        self.owner = owner or f"{self.hostname}:{os.getpid()}:{uuid.uuid4().hex[:8]}"
        #: A lease whose heartbeat is older than this is considered abandoned.
        self.lease_stale_ms = lease_stale_ms if lease_stale_ms is not None else max(60_000, interval_ms * 6)
        #: Uploads not referenced by any post are deleted after this long (0 disables).
        self.orphan_media_max_age_ms = orphan_media_max_age_ms
        self.in_flight: dict[str, asyncio.Task[PublishJob]] = {}
        self._loop_task: asyncio.Task[None] | None = None
        #: True once start() was called: from then on jobs are only claimed while holding the lease.
        self._lease_mode = False
        self.holds_lease = False
        self._last_gc = 0.0
        self._last_standby_log = 0.0
        #: Jobs recovered from a previous process on the last lease acquisition.
        self.last_recovered: list[PublishJob] = []

    @property
    def running(self) -> bool:
        return self._loop_task is not None

    @property
    def active_job_ids(self) -> list[str]:
        return list(self.in_flight)

    @property
    def active(self) -> bool:
        """Whether this process may claim jobs (always true for workers that were never started, e.g. tests)."""
        return not self._lease_mode or self.holds_lease

    def status(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "holdsLease": self.holds_lease,
            "owner": self.owner,
            "lease": read_lease(self.db),
            "active": self.active_job_ids,
        }

    def start(self) -> None:
        """Start polling. Must be called from within a running event loop."""
        if self._loop_task:
            return
        self._lease_mode = True
        self.heartbeat()
        self._loop_task = asyncio.get_running_loop().create_task(self._loop())
        self.kick()

    async def _loop(self) -> None:
        while True:
            await asyncio.sleep(self.interval_ms / 1000)
            try:
                self.heartbeat()
                self.kick()
            except Exception:  # noqa: BLE001 — never let the poll loop die
                log.exception("worker tick failed")

    async def stop(self) -> None:
        if self._loop_task:
            self._loop_task.cancel()
            try:
                await self._loop_task
            except asyncio.CancelledError:
                pass
        self._loop_task = None
        if self.holds_lease:
            release_lease(self.db, self.owner)
        self.holds_lease = False

    def _can_auto_retry(self, job: PublishJob) -> bool:
        """A job interrupted mid-upload is only retried automatically if that can't post twice: it was a
        dry-run, or the adapter saved a resume checkpoint (it re-checks the upload session on retry)."""
        if job.checkpoint is not None:
            return True
        return should_dry_run(self.opts.get_adapter(job.platform), job.dry_run, self.opts.mode())

    def gc_orphan_media(self) -> list[str]:
        """Delete uploads nobody references (replaced/abandoned videos fill the disk otherwise)."""
        if not self.orphan_media_max_age_ms:
            return []
        self._last_gc = time.time() * 1000
        paths = repo.delete_orphan_media(self.db, self.orphan_media_max_age_ms)
        for p in paths:
            delete_stored_file(p, self.opts.upload_dir)
        return paths

    def heartbeat(self) -> None:
        """Renew our lease, or try to acquire it; on (re)acquisition recover orphaned jobs."""
        if self.holds_lease and renew_lease(self.db, self.owner):
            if time.time() * 1000 - self._last_gc > HOUR_MS:
                self.gc_orphan_media()
            return
        was_holding = self.holds_lease
        self.holds_lease = acquire_lease(
            self.db, self.owner, self.lease_stale_ms, now_utc(), lambda o: is_dead_local_owner(o, self.hostname, self.owner)
        )
        if self.holds_lease and not was_holding:
            # Anything still `uploading` belongs to a process that no longer holds the lease (crashed/restarted).
            self.last_recovered = repo.requeue_orphaned_jobs(self.db, self.in_flight.keys(), self._can_auto_retry)
            if self.last_recovered:
                log.warning("recovered %d job(s) interrupted by a previous process", len(self.last_recovered))
        elif not self.holds_lease and not was_holding and self._last_standby_log < time.time() - 60:
            self._last_standby_log = time.time()
            lease = read_lease(self.db)
            log.warning("standby: another process holds the worker lease (%s)", lease and lease["owner"])

    def kick(self) -> list[asyncio.Task[PublishJob]]:
        """Claim due jobs up to the concurrency limit and start them. Returns the started tasks."""
        if not self.active:
            return []
        started = []
        loop = asyncio.get_running_loop()
        while len(self.in_flight) < self.concurrency:
            job = repo.claim_next_job(self.db)
            if not job:
                break
            task = loop.create_task(execute_job(self.db, job, self.opts))
            self.in_flight[job.id] = task
            task.add_done_callback(lambda _t, jid=job.id: self.in_flight.pop(jid, None))
            started.append(task)
        return started

    async def run_due(self, max_rounds: int = 100) -> list[PublishJob]:
        """Process every due job (including ones that become due via immediate retries) and wait for them."""
        results: list[PublishJob] = []
        for _ in range(max_rounds):
            started = self.kick()
            if started:
                results.extend(await asyncio.gather(*started))
            elif self.in_flight:
                # Slots are busy with interval-started jobs; wait for one to free up.
                await asyncio.wait(list(self.in_flight.values()), return_when=asyncio.FIRST_COMPLETED)
            else:
                break
        return results

    async def run_due_exclusive(self) -> list[PublishJob] | None:
        """Manual tick (POST /api/jobs/run). If the background worker isn't running in this process
        (WORKER_DISABLED), take the lease just for this run. None when another process holds the lease."""
        if self._lease_mode:
            return await self.run_due() if self.active else None
        got = acquire_lease(
            self.db, self.owner, self.lease_stale_ms, now_utc(), lambda o: is_dead_local_owner(o, self.hostname, self.owner)
        )
        if not got:
            return None
        try:
            return await self.run_due()
        finally:
            release_lease(self.db, self.owner)

    async def idle(self) -> None:
        """Wait for currently running jobs (tests / graceful shutdown)."""
        while self.in_flight:
            await asyncio.gather(*self.in_flight.values(), return_exceptions=True)


_worker: PublishWorker | None = None


def get_worker() -> PublishWorker:
    """Process-wide worker singleton. Does not start polling."""
    global _worker
    if _worker is None:
        _worker = PublishWorker(
            get_db(),
            RunnerOptions(simulated_delay_ms=_env_int("DRY_RUN_DELAY_MS", 1500)),
            concurrency=_env_int("WORKER_CONCURRENCY", 2),
            interval_ms=_env_int("WORKER_INTERVAL_MS", 5000),
        )
    return _worker


def set_worker(worker: PublishWorker | None) -> None:
    """Swap the singleton (tests)."""
    global _worker
    _worker = worker


def worker_disabled() -> bool:
    return os.environ.get("WORKER_DISABLED") == "true"


def ensure_worker() -> PublishWorker:
    """Lazily start background polling (no-op when WORKER_DISABLED=true). Call from the event loop."""
    worker = get_worker()
    if not worker_disabled() and not worker.running:
        worker.start()
    return worker

