"""SQLite access: one shared connection, migrations, and nestable (savepoint) transactions."""

from __future__ import annotations

import os
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from ..models import now_iso
from .schema import MIGRATIONS


class Database:
    """Thin wrapper around a sqlite3 connection in autocommit mode with explicit transactions.

    All statements are serialized by a re-entrant lock, so the connection can be shared between the
    event loop and worker threads (Starlette's test client, ``asyncio.to_thread``).
    """

    def __init__(self, filename: str):
        self.filename = filename
        if filename != ":memory:":
            Path(filename).resolve().parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(filename, isolation_level=None, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self._depth = 0
        self.execute("PRAGMA foreign_keys = ON")
        if filename != ":memory:":
            self.execute("PRAGMA journal_mode = WAL")
            self.execute("PRAGMA busy_timeout = 5000")
        self.migrate()

    def execute(self, sql: str, params: tuple | list = ()) -> sqlite3.Cursor:
        with self.lock:
            return self.conn.execute(sql, params)

    def one(self, sql: str, params: tuple | list = ()) -> sqlite3.Row | None:
        with self.lock:
            return self.conn.execute(sql, params).fetchone()

    def all(self, sql: str, params: tuple | list = ()) -> list[sqlite3.Row]:
        with self.lock:
            return self.conn.execute(sql, params).fetchall()

    @contextmanager
    def transaction(self) -> Iterator[None]:
        """Run the block atomically. Nested blocks use savepoints, so inner failures roll back only their part."""
        with self.lock:
            depth = self._depth
            sp = f"sp_{depth}"
            self.conn.execute("BEGIN" if depth == 0 else f"SAVEPOINT {sp}")
            self._depth = depth + 1
            try:
                yield
            except BaseException:
                if depth == 0:
                    self.conn.execute("ROLLBACK")
                else:
                    self.conn.execute(f"ROLLBACK TO {sp}")
                    self.conn.execute(f"RELEASE {sp}")
                raise
            else:
                self.conn.execute("COMMIT" if depth == 0 else f"RELEASE {sp}")
            finally:
                self._depth = depth

    def migrate(self) -> None:
        self.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        applied = {r["version"] for r in self.all("SELECT version FROM schema_migrations")}
        for version, name, statements in MIGRATIONS:
            if version in applied:
                continue
            with self.transaction():
                for stmt in statements:
                    self.execute(stmt)
                self.execute("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)", (version, name, now_iso()))

    def schema_version(self) -> int:
        row = self.one("SELECT MAX(version) AS v FROM schema_migrations")
        return int(row["v"] or 0) if row else 0

    def close(self) -> None:
        self.conn.close()


_db: Database | None = None
_db_lock = threading.Lock()


def default_db_path() -> str:
    return os.environ.get("DATABASE_PATH") or str(Path.cwd() / "data" / "app.db")


def get_db() -> Database:
    """Process-wide database (DATABASE_PATH, default ./data/app.db)."""
    global _db
    with _db_lock:
        if _db is None:
            _db = Database(default_db_path())
        return _db


def set_db(db: Database | None) -> None:
    """Swap the process-wide database (tests)."""
    global _db
    with _db_lock:
        _db = db


def row_get(row: sqlite3.Row, key: str, default: Any = None) -> Any:
    return row[key] if key in row.keys() else default
