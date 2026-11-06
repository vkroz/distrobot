"""Single-row lease in SQLite so only one process runs the publish worker against a database.

The holder renews ``heartbeat_at`` on every poll; a lease whose heartbeat is older than ``stale_ms``
is considered abandoned (crashed/killed process) and can be taken over. This guards against two
processes on the same machine/DB file. It is not a distributed lock — run a single app instance.
"""

from __future__ import annotations

import os
from collections.abc import Callable
from datetime import datetime
from typing import Any

from ..db import Database
from ..models import iso, now_utc, ts_ms


def read_lease(db: Database) -> dict[str, Any] | None:
    r = db.one("SELECT owner, acquired_at, heartbeat_at FROM worker_lease WHERE id = 1")
    return {"owner": r["owner"], "acquiredAt": r["acquired_at"], "heartbeatAt": r["heartbeat_at"]} if r else None


def is_dead_local_owner(owner: str, hostname: str, self_owner: str | None = None) -> bool:
    """Owner ids look like ``host:pid:random``. A holder on this host whose pid is gone crashed (e.g. kill -9)."""
    parts = owner.split(":")
    if len(parts) < 2 or parts[0] != hostname:
        return False
    try:
        pid = int(parts[1])
    except ValueError:
        return False
    if pid <= 0:
        return False
    # Same host + same pid but a different owner id = a previous run of this process (containers often
    # reuse pids across restarts), so that holder is certainly gone.
    if pid == os.getpid():
        return self_owner is not None and owner != self_owner
    try:
        os.kill(pid, 0)  # signal 0 = existence check
        return False
    except ProcessLookupError:
        return True
    except PermissionError:
        return False


def acquire_lease(
    db: Database,
    owner: str,
    stale_ms: int,
    now: datetime | None = None,
    is_abandoned: Callable[[str], bool] = lambda _o: False,
) -> bool:
    """Take (or keep) the lease. Returns False if another live owner holds a fresh lease."""
    now = now or now_utc()
    ts = iso(now)
    with db.transaction():
        current = read_lease(db)
        fresh = current is not None and now.timestamp() * 1000 - (ts_ms(current["heartbeatAt"]) or 0) < stale_ms
        if current and current["owner"] != owner and fresh and not is_abandoned(current["owner"]):
            return False
        if current and current["owner"] == owner:
            db.execute("UPDATE worker_lease SET heartbeat_at = ? WHERE id = 1", (ts,))
        else:
            db.execute(
                """INSERT INTO worker_lease (id, owner, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?)
                   ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at,
                     heartbeat_at = excluded.heartbeat_at""",
                (owner, ts, ts),
            )
        return True


def renew_lease(db: Database, owner: str, now: datetime | None = None) -> bool:
    """Renew our heartbeat. Returns False if we no longer own the lease."""
    cur = db.execute("UPDATE worker_lease SET heartbeat_at = ? WHERE id = 1 AND owner = ?", (iso(now or now_utc()), owner))
    return cur.rowcount > 0


def release_lease(db: Database, owner: str) -> None:
    db.execute("DELETE FROM worker_lease WHERE id = 1 AND owner = ?", (owner,))
