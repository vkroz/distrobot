# Distrobot

Upload one video, tailor it per platform, and publish (or schedule) it to **YouTube, TikTok, Instagram Reels, X, Facebook Pages, LinkedIn and Vimeo** from one place.

> **Status: MVP.** YouTube has a real end-to-end implementation; the other six adapters follow each platform's documented API but have only been tested against mocked HTTP. With no credentials configured, everything runs in **dry-run** mode. See [What is real vs. simulated](#what-is-real-vs-simulated).

Python rebuild of the original Next.js/TypeScript app: same features, same HTTP API, same SQLite schema (an existing `data/app.db` keeps working).

## Quick start

```bash
uv sync --extra dev
uv run python -m distrobot     # http://127.0.0.1:8000  (--host, --port, --reload)
```

Requires **Python ≥ 3.11** and **[uv](https://docs.astral.sh/uv/)**. For server-side video measurement install **ffmpeg** (`ffprobe` on `PATH`); without it, browser-reported values are used.

No configuration is needed to try it: every platform runs in dry-run mode.

**Login:** by default the demo login is **`admin` / `admin`** (a warning banner is shown until you set your own). With `APP_ENV=production` you must set `APP_USERNAME`, `APP_PASSWORD` and `APP_SESSION_SECRET`, otherwise login is disabled. See [Login](#login).

To publish for real, copy `.env.example` to `.env` (loaded at startup), fill in a platform's OAuth credentials, restart, and connect the account on **Accounts**.

```bash
uv run --extra dev pytest    # unit + integration tests
scripts/smoke-dry-run.sh      # end-to-end dry-run flow against a running server
                             # (BASE=http://localhost:8000 APP_USERNAME=admin APP_PASSWORD=admin)
```

Data lives in `./data/` (SQLite DB + uploaded files), which is git-ignored.

**Run one process.** The publish worker runs inside the web server; don't start uvicorn with `--workers > 1`.

## Using it

| Page | What it does |
| --- | --- |
| **Login** `/login` | Single admin login (plain HTML form, works without JavaScript). Log out from the nav. |
| **Compose** `/compose` | Upload a video (duration and dimensions are re-measured on the server with ffprobe; browser values are the fallback) and an optional thumbnail. Set title, description, hashtags, visibility and an optional schedule. Pick platforms, override title/description/hashtags per platform, see live per-platform validation with one-click fixes, and preview each platform side by side. When TikTok is selected, the [TikTok posting panel](#tiktok-posting-ux) appears. **Save draft** at any point, even before uploading a video. |
| **Edit draft** `/compose?draft=<id>` | Reopen a draft, change anything, then save it again, **Publish**, **Schedule**, or **Delete**. Published and scheduled posts are read-only. |
| **Dashboard** `/dashboard` (home) | Upcoming scheduled posts, publication history (All / Drafts filter), per-platform status chips (progress, attempts, errors, retry button, link to the published post), and a month calendar (`?view=calendar&month=YYYY-MM`). Draft cards have **Edit**, **Publish now**, **Schedule…** and **Delete**; other posts can be deleted, which cancels their queued jobs. Refreshes automatically while jobs are in flight. "Run worker now" processes due jobs immediately. |
| **Accounts** `/accounts` | Per platform: configured or not (and which env vars are missing), dry-run badge, OAuth **Connect**, connected accounts with **Disconnect**. |
| `/dry-run/<jobId>` | What a simulated job would have sent (final title, caption with hashtags, tags, visibility, schedule, warnings). |

Times are rendered in the viewer's time zone (the browser sends it in a `tz` cookie).

## Architecture

```
Browser (server-rendered Jinja2 pages + small vanilla JS: compose.js, dashboard.js)
  │  POST /api/media (raw body, streamed)   POST /api/validate   POST /api/posts   GET /api/accounts
  ▼
Starlette app (distrobot/web/) ── AuthMiddleware (login gate + CSRF, pure ASGI so uploads stream)
  │                                     └─ services/posts.py (compose, drafts, read models)
  ├─ platforms/   rules per platform + validation engine (also serves live validation in compose)
  ├─ db/          SQLite (stdlib sqlite3): migrations, repository, savepoint transactions
  ├─ storage.py   local file storage under ./data/uploads
  ├─ media/       ffprobe metadata
  ├─ jobs/        job state machine · runner · asyncio worker · SQLite lease
  └─ adapters/    BaseAdapter (httpx) · one adapter per platform
```

| Layer | Library |
| --- | --- |
| Web/ASGI | Starlette + uvicorn |
| Templates | Jinja2, hand-written CSS (light/dark), no JS build step |
| HTTP client | httpx (async); tests use `httpx.MockTransport` |
| Text segmentation | `regex` (grapheme clusters, `\p{…}` classes for X weighting and hashtags) |
| DB | stdlib `sqlite3` |

**Data model:** `posts` hold the default title, caption, hashtags, video, thumbnail, visibility and schedule. Each post has one `post_targets` row per platform, with nullable title/caption/hashtag overrides plus settings. `publish_jobs` records status (`queued → uploading → published | failed`), attempts and max attempts, progress, the adapter's resume checkpoint, result URL, what was sent, and the error. Also: `media` (videos and images), `connected_accounts` (OAuth tokens), `oauth_states` (CSRF state + PKCE verifier), `worker_lease` and `app_settings`.

**Publishing pipeline**

1. `POST /api/posts` re-validates every target on the server. Any error blocks publishing (`422` with per-platform results); drafts skip strict validation. It then stores the post and its targets and enqueues one job per platform. Each job is due at `scheduledAt`, except YouTube, which uploads immediately with `publishAt` and lets YouTube flip it public at the scheduled time.
2. **Worker** (`jobs/worker.py`) is a process-wide singleton started in the app lifespan. Every `WORKER_INTERVAL_MS` it claims due jobs atomically and runs up to `WORKER_CONCURRENCY` at once as asyncio tasks.
3. **Runner** (`jobs/runner.py`), per job: resolves content, account, file and thumbnail; decides dry-run vs real; refreshes tokens close to expiry, and refreshes once more and retries on a 401; records progress and resume checkpoints so a retried upload continues where it stopped.
4. **Failures:** retryable errors (5xx, 429, network) re-queue with backoff of 30s, 60s, … up to 3 attempts. Validation, quota, 4xx and missing-account errors fail immediately. `POST /api/jobs/:id/retry` re-queues a failed job with one extra attempt. `POST /api/jobs/run` processes everything that is due and waits for it.

**Adapters** subclass `BaseAdapter` (`validate`, `publish` (dry-run aware), `get_auth_url`, `handle_callback`, `refresh_access_token`, `capabilities`, `credential_env_vars`) and implement `fetch_profile` and `do_publish`. HTTP failures go through `adapters/http.py`, which decides what is retryable. `tests/test_adapters.py` runs the same contract against every registered adapter.

**Validation** (`platforms/`) knows each platform's limits: title and caption length counted the way the platform counts (X counts URLs as 23 and emoji/CJK as 2), hashtag limits, duration, file size, formats, aspect-ratio range and resolution, and whether a video counts as a YouTube Short. It returns errors, warnings and suggested adaptations. Text adaptations (truncate, trim hashtags, derive a title) apply with one click as per-platform overrides; media adaptations (reframe, trim, compress, transcode) are only suggested. The compose page validates live by calling `POST /api/validate` with the per-platform overrides and settings, so the browser and the publish step use the same Python engine.

### Login

`web/middleware.py` protects every page and API. Without a valid session, pages redirect to `/login?next=…` and APIs answer `401`. Public paths are `/login`, `/api/session`, `/api/health`, `/static/*` and `/api/auth/<platform>/callback`; OAuth callbacks are protected instead by the single-use `state` created by a logged-in user.

- **Credentials:** `APP_USERNAME`/`APP_PASSWORD` from env, compared in constant time. `POST /api/session` takes JSON or a form post; `DELETE /api/session` logs out.
- **Session:** a stateless `cp_session` cookie (HttpOnly, SameSite=Lax, Secure on HTTPS, 7 days) holding a payload signed with HMAC-SHA256. The key is derived from `APP_SESSION_SECRET` *and* the password, so changing either signs everyone out. Cookies from the TypeScript version remain valid.
- **Defaults:** unset values fall back to `admin`/`admin` and a built-in secret, with an amber banner. With `APP_ENV=production` all three are required, otherwise login is disabled with a clear message.
- **Logout** revokes **every** existing session (single admin): the time is stored in the DB and older session cookies are rejected.
- **Brute force:** after 5 failed logins in 15 min, attempts are processed one at a time with a growing delay (up to 5 s each), and floods get `429`. Global rather than per-IP, because `X-Forwarded-For` can be spoofed and a per-IP lockout would let anyone lock the admin out.
- **CSRF:** POST/PUT/PATCH/DELETE requests whose `Origin` (or `Sec-Fetch-Site`) is another origin get `403`. Allowed origins are the request `Host`, `X-Forwarded-Host`, and `APP_URL`, so **behind a reverse proxy that rewrites `Host`, set `APP_URL`**.
- **Open redirects:** `next` / `returnTo` targets are normalized like a browser would and must stay on this origin.
- **Limits:** one user, no roles. The server binds to `127.0.0.1` by default; set real credentials before using `--host 0.0.0.0`, and put it behind HTTPS if you expose it.

### TikTok posting UX

TikTok's [content sharing guidelines](https://developers.tiktok.com/doc/content-sharing-guidelines) require a specific posting screen for audited apps. When TikTok is selected, compose shows:

- **Creator info** from `creator_info/query` (`GET /api/tiktok/creator-info`): avatar, nickname, @username and maximum video length. It's a labelled **mock** when TikTok is in dry-run or no account is connected; if TikTok refuses (e.g. the creator can't post right now), TikTok publishing is blocked.
- **"Who can view this video"**, with **no default**: only the creator's allowed privacy options are offered.
- **Allow Comment / Duet / Stitch**: all off by default, and greyed out when the creator has disabled them.
- **Disclose video content**: "Your brand" leads to a *Promotional content* label, "Branded content" to *Paid partnership*. Branded content can't be "Only me".
- **The required declaration** next to the publish button: "By posting, you agree to TikTok's [Music Usage Confirmation]" (plus the [Branded Content Policy] for branded content).

These choices are stored in the TikTok target's `settings` and checked by the shared validation engine (`distrobot/platforms/tiktok.py`) in the browser, at compose/publish time on the server, and again in the adapter against fresh `creator_info` before uploading. The adapter sends them as `privacy_level`, `disable_comment/duet/stitch` and `brand_organic_toggle`/`brand_content_toggle`. It never picks a privacy level for the user.

### Media probing

After upload, videos are measured on the server with **ffprobe**: duration, plus display width/height corrected for phone rotation metadata. The binary is `FFPROBE_PATH`, else `ffprobe` on `PATH`. If none runs or the file can't be parsed, the browser-reported values are used, field by field. `media.metadataSource` records `ffprobe` or `client`, and compose shows which one applied. Validation always uses the stored values.

ffprobe runs with `-protocol_whitelist file` and a container whitelist (mp4/mov/webm/mkv/…), so an uploaded HLS playlist or concat list can't make the server fetch URLs or open other local files. Only known media extensions are kept for stored files, and `/api/media/<id>` serves files only as `video/*` or JPEG/PNG/WebP, with `nosniff`, a sandbox CSP and Range support (seeking, Safari).

### Restart safety (single instance)

The worker runs **inside the server process**. Run **one app instance** per database.

- **Lease:** on start, the worker takes a single-row lease in SQLite (`worker_lease`) and renews it on every poll. A second process using the same database stays in **standby**: it claims no jobs and leaves the other process's uploads alone. It takes over only when the holder is gone: immediately if the holder was on the same host and its pid no longer exists, otherwise once the heartbeat is older than max(60 s, 6 × interval). Shutdown releases the lease.
- **Recovery:** when the lease is acquired, jobs left `uploading` by a crashed process are re-queued only when that can't post twice (dry-run jobs, and real jobs whose adapter saved a resume checkpoint). Others are marked `failed` with "It may already have been posted on the platform: check there first, then retry manually".
- **Caveat:** a small window remains in which a checkpointed adapter has already created the post but not yet recorded it (e.g. X between creating the post and the DB update); a retry could post twice there.
- **`/api/health`** (public) reports `worker.running`, `worker.holdsLease` and `worker.busy`. In standby, `POST /api/jobs/run` returns `409`; with `WORKER_DISABLED=true` it takes the lease just for that run.
- **Disk cleanup:** uploads that no post references are deleted after 24 h by the lease holder.
- **Not distributed:** multiple hosts need a real queue.

## What is real vs. simulated

| Area | Status |
| --- | --- |
| Compose UI, per-platform overrides, live validation, one-click text fixes | **Real** |
| Drafts: create, edit, delete, publish now / schedule later | **Real** |
| App login (single admin, signed session cookie, auth middleware) | **Real**; single user, no lockout. Demo `admin`/`admin` only in development. |
| TikTok posting UX (creator info, privacy without default, interaction toggles, commercial disclosure, consent text) | **Real UI + validation**. Creator info is **mocked** unless a TikTok account is connected and TikTok isn't in dry-run. Not reviewed by TikTok's audit. |
| Server-side video metadata (ffprobe) | **Real**, with browser values as the fallback |
| Restart recovery + single-process worker lease | **Real** (SQLite lease; not a distributed lock) |
| Platform rules / limits | Checked against official docs in 2026-11, with source URLs in `distrobot/platforms/rules.py`. Where a platform documents **no** limit (Facebook video title/description, LinkedIn video title, Vimeo description), the app uses a soft warning or doesn't enforce one rather than inventing a hard cap; see [Limits we couldn't verify](#limits-we-couldnt-verify). |
| Uploads to local disk, SQLite persistence | **Real** |
| Job queue, worker, scheduling, retries/backoff, resume checkpoints, token refresh | **Real** (single process) |
| Dry-run publishing | **Simulated**: validation runs, upload progress is faked, the result links to `/dry-run/<jobId>` |
| OAuth connect/callback/disconnect | **Real flow** (state + PKCE stored in DB). Only exercised against mocked token endpoints. |
| **YouTube** adapter | **Real implementation** (resumable chunked upload with resume, snippet/status, `publishAt`, thumbnail, refresh). Tested against a simulated YouTube server; **not yet run against the live API**. |
| TikTok, Instagram, X, Facebook, LinkedIn, Vimeo adapters | **API-shaped implementations** of each documented flow, with resume support. Tested **only with mocked HTTP**; endpoint and field details may need adjusting against the live APIs. Run in dry-run when unconfigured. |
| Media processing (reframe/trim/compress/transcode) | **Not implemented**: suggestions only |
| Token encryption at rest | **Not implemented**: OAuth tokens (incl. Facebook Page tokens) are stored in plaintext in SQLite |
| Multi-user / roles | **Not implemented**: one admin account |
| Platform-specific settings UI for the other platforms (YouTube category, made-for-kids, Facebook Page choice) | Backend supports `target.settings`; **no UI yet** |

## Platforms: APIs and approval requirements

Approval programs change often, so check each provider's current docs before relying on these. Register `$APP_URL/api/auth/<platform>/callback` as the redirect URI.

| Platform | API used | Scopes | App review / restrictions |
| --- | --- | --- | --- |
| **YouTube** | [YouTube Data API v3](https://developers.google.com/youtube/v3/docs/videos/insert): `videos.insert` (resumable), `thumbnails.set` | `youtube.upload`, `youtube.readonly` | OAuth consent screen verification for public use (while "Testing", only listed test users can connect). Videos uploaded by **unaudited API projects are locked to private** until the project passes the YouTube API Services audit. Default quota is 10,000 units/day and uploads are expensive. Custom thumbnails require a verified channel. |
| **TikTok** | [Content Posting API](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post): creator_info → video/init (FILE_UPLOAD) → chunk PUT → status/fetch | `user.info.basic`, `video.upload`, `video.publish` | App must be approved for Content Posting. **Unaudited clients can only post privately (SELF_ONLY)** with limited users. TikTok's audit requires a specific posting UX; it is implemented (see [TikTok posting UX](#tiktok-posting-ux)) but has not been through TikTok's review. |
| **Instagram** | [Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/content-publishing): REELS container (resumable) → rupload → status → media_publish | `instagram_business_basic`, `instagram_business_content_publish` | Requires an Instagram **Business or Creator** account. Publishing for accounts other than your own needs Meta **App Review (Advanced Access)** and business verification. Rate-limited publishing (posts per 24h). |
| **Facebook Pages** | [Graph API video upload](https://developers.facebook.com/docs/video-api/guides/publishing): `/{page-id}/videos` start/transfer/finish with a Page token | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `publish_video` | Page permissions need **App Review + Business Verification** for Advanced Access. Only Pages the user manages; personal profiles are not supported by the API. Uses the older chunked flow, while Meta now promotes a newer resumable-upload flow. |
| **X** | [Media upload v2](https://docs.x.com/x-api/media/upload-media) (initialize/append/finalize/status) + `POST /2/tweets` | `tweet.read`, `tweet.write`, `users.read`, `media.write`, `offline.access` | OAuth 2.0 with PKCE. Posting and media upload are subject to your **API access tier**; the free tier has very tight write limits. Long posts and long videos need a Premium account (handled via account metadata). |
| **LinkedIn** | [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api) (initializeUpload → part PUTs → finalizeUpload) + [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) | `openid`, `profile`, `w_member_social` | "Share on LinkedIn" + "Sign In with LinkedIn (OpenID Connect)" products are self-serve for **member** posting. Posting as an **organization** requires the Community Management API (approval). Versioned API (`LINKEDIN_API_VERSION`). |
| **Vimeo** | [Upload API (tus)](https://developer.vimeo.com/api/upload/videos): `POST /me/videos` → tus PATCH → tags | `public`, `private`, `upload`, `edit` | Apps must **request upload access**. Storage/weekly quotas and some privacy options depend on the user's plan. |

### Limits we couldn't verify

Checked against official docs in 2026-11 (source URLs are in comments in `distrobot/platforms/rules.py`):

| Limit | Status | What the app does |
| --- | --- | --- |
| X post 280 (weighted), TikTok caption 2200 (UTF-16), LinkedIn post text 3000, Vimeo 20 tags / 32 chars per tag, LinkedIn video 75 KB–500 MB | Documented | Enforced as errors (LinkedIn's file cap was corrected from 5 GB to the documented 500 MB) |
| Vimeo title 128 | Only shown as a character counter in Vimeo's Help Center UI | Enforced |
| Facebook video title | **Not documented** by Meta | Soft warning above 100 chars (the common third-party convention) |
| Facebook description 63,206 | Widely cited, **not in Meta's docs** | Enforced, marked as community-sourced |
| LinkedIn video title | **Not documented** | Soft warning above 200 chars |
| Vimeo description | **Not documented** | Not enforced |

## Configuration

All env vars are documented in [`.env.example`](.env.example) (a test fails if code reads an undocumented variable). `.env` is loaded at startup; real environment variables win.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_URL` | request origin | Base URL for OAuth redirect URIs; allowed CSRF origin |
| `APP_ENV` | unset | `production` makes login credentials and secret mandatory |
| `APP_USERNAME` / `APP_PASSWORD` | `admin` / `admin` (not in production) | The single admin login |
| `APP_SESSION_SECRET` | built-in (not in production; ≥ 16 chars) | HMAC key for session cookies |
| `FFPROBE_PATH` | `ffprobe` on `PATH` | ffprobe binary for server-side video metadata |
| `DATABASE_PATH` | `./data/app.db` | SQLite file |
| `UPLOAD_DIR` | `./data/uploads` | Uploaded files |
| `DRY_RUN` | unset (auto) | `true` = simulate all; `false` = always real; unset = simulate platforms without credentials |
| `DRY_RUN_DELAY_MS` | `1500` | Simulated upload time |
| `WORKER_INTERVAL_MS` / `WORKER_CONCURRENCY` / `WORKER_DISABLED` | `5000` / `2` / `false` | In-process worker |
| `YOUTUBE_CLIENT_ID` / `_SECRET` … `VIMEO_CLIENT_ID` / `_SECRET` | — | Per-platform OAuth clients (see `.env.example`) |
| `FACEBOOK_GRAPH_VERSION` / `INSTAGRAM_GRAPH_VERSION` / `LINKEDIN_API_VERSION` | `v23.0` / `v23.0` / `202509` | API version pins |

## Testing

`uv run --extra dev pytest` runs everything with in-memory SQLite and mocked HTTP. No network access or credentials are needed.

| File | Covers |
| --- | --- |
| `tests/test_text_and_validation.py` | Character counting (incl. X weighting, graphemes), hashtags, truncation, platform limits, validation engine, adaptations, requirement rows, TikTok settings rules |
| `tests/test_db_and_jobs.py` | Migrations, savepoint transactions, repository, job state machine, orphan recovery, OAuth state, media GC, worker lease |
| `tests/test_pipeline.py` | Compose → enqueue → worker: dry-run end-to-end, 422 on validation errors, native vs queued scheduling, drafts lifecycle, retryable vs fatal errors, 401 → refresh → retry, standby worker, crash recovery |
| `tests/test_adapters.py` | The same contract for **every** adapter (env vars documented, auth URL, dry-run without network, validation before network, no-account, 5xx/network retryable, 401 → `auth_failed`), OAuth callback/refresh, and request sequences for YouTube (resumable upload with resume), TikTok, Instagram, X, Facebook, LinkedIn, Vimeo |
| `tests/test_http.py` | Auth config, signed sessions, safe redirects, CSRF, auth gate, form/JSON login, logout revocation, streaming upload + Range serving, posts API, `/api/validate`, OAuth start/callback, ffprobe parsing and a real ffmpeg-generated video (skipped without ffmpeg) |

`scripts/smoke-dry-run.sh` exercises a running server over HTTP: 401 without a session, login, upload (a real ffmpeg clip when available, to verify ffprobe overrides wrong browser values), draft create/edit, TikTok creator info, publish to all 7 platforms, worker run, results, 409 on editing a published post, draft delete, logout.

## Limitations / next steps

- Run the YouTube adapter against the live API and verify the other adapters one platform at a time.
- Encrypt OAuth tokens at rest.
- One app instance only: the SQLite lease prevents double-processing on one host, but multi-instance deployments need a real queue.
- ffmpeg pipeline for the suggested reframe/trim/compress/transcode adaptations (probing is done).
- Settings UI for other platforms (YouTube category/made-for-kids, Facebook Page choice); multiple users.
