# Creator Publisher

Publish one video to YouTube, TikTok, Instagram Reels, X, Facebook, LinkedIn and Vimeo from one place.

```bash
npm install
cp .env.example .env   # optional: OAuth client credentials
npm run dev            # http://localhost:3000
npm test               # vitest
npm run build
```

Requires Node ≥ 22.13 (uses the built-in `node:sqlite`; no native modules). Data lives in `./data` (SQLite DB + uploads).

## How it works

1. **Compose** (`/compose`): upload a video (duration/dimensions detected in the browser), optional thumbnail, title/description/hashtags, visibility and schedule. Pick platforms, override text per platform, and fix validation issues with one click.
2. `POST /api/posts` validates every target server-side (errors block publishing), stores the post + targets and enqueues one **publish job** per platform.
3. An **in-process worker** (started at server boot via `instrumentation.ts`, and lazily from API routes) polls every `WORKER_INTERVAL_MS`, claims due jobs and runs them through the platform adapter: `queued → uploading → published | failed`. Transient errors are retried automatically with exponential backoff (30s, 60s, … up to 3 attempts); failed jobs can be retried from the dashboard. `POST /api/jobs/run` processes all due jobs immediately.
4. **Dashboard** (`/dashboard`) shows per-platform status, progress, errors and result links.

### Dry-run

`DRY_RUN=true` simulates every platform; `DRY_RUN=false` always calls real APIs; unset (default) simulates only platforms with no OAuth credentials. Dry-run jobs go through validation, show simulated upload progress (`DRY_RUN_DELAY_MS`) and link to `/dry-run/<jobId>`, which shows exactly what would have been sent.

### Connecting YouTube (real uploads)

1. In Google Cloud Console enable **YouTube Data API v3** and create an OAuth client (type *Web application*).
2. Add the redirect URI `http://localhost:3000/api/auth/youtube/callback` (or `$APP_URL/api/auth/youtube/callback`).
3. Put `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` in `.env`, restart, then **Accounts → Connect YouTube**.

Uploads use the resumable protocol (8 MiB chunks, resume after failures), set title/description/tags/category/privacy, use `publishAt` for scheduled posts, and set the custom thumbnail (JPEG/PNG ≤ 2 MB). Tokens are refreshed automatically. Note that videos uploaded by unaudited Google API projects are locked to private, and uploads consume a large share of the default daily API quota.

Other platforms use the same OAuth flow with their own `*_CLIENT_ID`/`*_SECRET` env vars; their adapters follow each platform's documented API but have not been exercised against the live APIs.

## Layout

| Path | Purpose |
| --- | --- |
| `app/compose`, `app/dashboard`, `app/accounts`, `app/dry-run` | UI |
| `app/api/posts` | Create/list posts (compose → jobs) |
| `app/api/jobs/run`, `app/api/jobs/[id]/retry` | Manual worker tick, retry a failed job |
| `app/api/media` | Raw-body upload of videos/thumbnails; `GET /api/media/[id]` serves files |
| `app/api/accounts`, `app/api/auth/[platform]/{start,callback}` | Platform status, OAuth connect/disconnect |
| `lib/services/posts.ts` | Compose service + read models |
| `lib/jobs/` | Job state machine, runner (dry-run, token refresh, checkpoints), worker |
| `lib/adapters/` | `PlatformAdapter` interface, `BaseAdapter`, HTTP helpers, one adapter per platform |
| `lib/platforms/` | Platform rules, validation engine, text utilities |
| `lib/db/` | SQLite connection, migrations, repository |
| `lib/storage/local.ts` | Streaming uploads to `./data/uploads` |
