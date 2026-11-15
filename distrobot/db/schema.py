"""Ordered migrations. Each runs once; applied versions are tracked in ``schema_migrations``.
Append new entries — never edit applied ones. (Same schema as the original TypeScript app, so an
existing ``data/app.db`` keeps working.)"""

MIGRATIONS: list[tuple[int, str, list[str]]] = [
    (
        1,
        "initial",
        [
            """CREATE TABLE connected_accounts (
                id            TEXT PRIMARY KEY,
                platform      TEXT NOT NULL,
                external_id   TEXT NOT NULL,
                display_name  TEXT NOT NULL,
                access_token  TEXT NOT NULL,
                refresh_token TEXT,
                expires_at    TEXT,
                scopes        TEXT NOT NULL DEFAULT '[]',
                metadata      TEXT NOT NULL DEFAULT '{}',
                created_at    TEXT NOT NULL,
                updated_at    TEXT NOT NULL,
                UNIQUE (platform, external_id)
            )""",
            """CREATE TABLE media (
                id                TEXT PRIMARY KEY,
                original_filename TEXT NOT NULL,
                storage_path      TEXT NOT NULL,
                mime_type         TEXT,
                size_bytes        INTEGER,
                duration_sec      REAL,
                width             INTEGER,
                height            INTEGER,
                checksum          TEXT,
                created_at        TEXT NOT NULL
            )""",
            """CREATE TABLE posts (
                id           TEXT PRIMARY KEY,
                title        TEXT NOT NULL DEFAULT '',
                caption      TEXT NOT NULL DEFAULT '',
                hashtags     TEXT NOT NULL DEFAULT '[]',
                media_id     TEXT REFERENCES media(id) ON DELETE SET NULL,
                status       TEXT NOT NULL DEFAULT 'draft'
                             CHECK (status IN ('draft','scheduled','publishing','published','partial','failed')),
                scheduled_at TEXT,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            )""",
            """CREATE TABLE post_targets (
                id                TEXT PRIMARY KEY,
                post_id           TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                platform          TEXT NOT NULL,
                account_id        TEXT REFERENCES connected_accounts(id) ON DELETE SET NULL,
                enabled           INTEGER NOT NULL DEFAULT 1,
                title_override    TEXT,
                caption_override  TEXT,
                hashtags_override TEXT,
                settings          TEXT NOT NULL DEFAULT '{}',
                created_at        TEXT NOT NULL,
                updated_at        TEXT NOT NULL,
                UNIQUE (post_id, platform)
            )""",
            "CREATE INDEX idx_post_targets_post ON post_targets(post_id)",
            """CREATE TABLE publish_jobs (
                id           TEXT PRIMARY KEY,
                post_id      TEXT NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
                target_id    TEXT NOT NULL REFERENCES post_targets(id) ON DELETE CASCADE,
                platform     TEXT NOT NULL,
                status       TEXT NOT NULL DEFAULT 'queued'
                             CHECK (status IN ('queued','uploading','published','failed')),
                attempts     INTEGER NOT NULL DEFAULT 0,
                max_attempts INTEGER NOT NULL DEFAULT 3,
                dry_run      INTEGER NOT NULL DEFAULT 0,
                result_url   TEXT,
                external_id  TEXT,
                error        TEXT,
                next_run_at  TEXT,
                started_at   TEXT,
                finished_at  TEXT,
                created_at   TEXT NOT NULL,
                updated_at   TEXT NOT NULL
            )""",
            "CREATE INDEX idx_publish_jobs_status ON publish_jobs(status, next_run_at)",
            "CREATE INDEX idx_publish_jobs_post ON publish_jobs(post_id)",
        ],
    ),
    (
        2,
        "compose_and_pipeline",
        [
            "ALTER TABLE media ADD COLUMN kind TEXT NOT NULL DEFAULT 'video' CHECK (kind IN ('video','image'))",
            "ALTER TABLE posts ADD COLUMN thumbnail_id TEXT REFERENCES media(id) ON DELETE SET NULL",
            """ALTER TABLE posts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
               CHECK (visibility IN ('public','unlisted','private'))""",
            # 0..1 upload progress, adapter resume state (e.g. resumable session URI), and what was sent.
            "ALTER TABLE publish_jobs ADD COLUMN progress REAL",
            "ALTER TABLE publish_jobs ADD COLUMN checkpoint TEXT",
            "ALTER TABLE publish_jobs ADD COLUMN result_payload TEXT",
            # Pending OAuth authorizations (CSRF state + PKCE verifier).
            """CREATE TABLE oauth_states (
                state         TEXT PRIMARY KEY,
                platform      TEXT NOT NULL,
                code_verifier TEXT,
                redirect_uri  TEXT NOT NULL,
                return_to     TEXT,
                created_at    TEXT NOT NULL
            )""",
        ],
    ),
    (
        3,
        "probe_and_worker_lease",
        [
            # Where duration/width/height came from: 'ffprobe' (server-measured) or 'client' (browser-reported).
            "ALTER TABLE media ADD COLUMN metadata_source TEXT CHECK (metadata_source IN ('ffprobe','client'))",
            # Single-row lease so only one process runs the publish worker against this database.
            """CREATE TABLE worker_lease (
                id           INTEGER PRIMARY KEY CHECK (id = 1),
                owner        TEXT NOT NULL,
                acquired_at  TEXT NOT NULL,
                heartbeat_at TEXT NOT NULL
            )""",
        ],
    ),
    (
        4,
        "app_settings",
        [
            # Small key/value store (e.g. sessions_valid_after for logout revocation).
            "CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
        ],
    ),
]
