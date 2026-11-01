# Creator Publisher

Upload one video, tailor it per platform, and publish (or schedule) it to **YouTube, TikTok, Instagram Reels, X, Facebook Pages, LinkedIn and Vimeo** from one place.

> **Status: MVP.** YouTube has a real end-to-end implementation; the other six adapters follow each platform's documented API but have only been tested against mocked HTTP. With no credentials configured, everything runs in **dry-run** mode. See [What is real vs. simulated](#what-is-real-vs-simulated).

## Quick start

```bash
npm install
npm run dev            # http://localhost:3000
```

Requires **Node ≥ 22.13** (uses the built-in `node:sqlite`; no native modules to compile). Tested on Node 24.

No configuration is needed to try it: every platform runs in dry-run mode. To publish for real, copy `.env.example` to `.env`, fill in a platform's OAuth credentials, restart, and connect the account on **Accounts**.

```bash
npm test               # unit + integration tests (vitest)
npm run build && npm start   # production build
npm run smoke          # end-to-end dry-run flow against a running server (BASE=http://localhost:3000)
```

Data lives in `./data/` (SQLite DB + uploaded files), which is git-ignored.

## Using it

| Page | What it does |
| --- | --- |
| **Compose** `/compose` | Upload a video (duration and dimensions are detected in the browser) and an optional thumbnail. Set title, description, hashtags, visibility and an optional schedule. Pick platforms, override title/description/hashtags per platform, see live per-platform validation with one-click fixes, and preview each platform side by side. |
| **Dashboard** `/dashboard` (home) | Upcoming scheduled posts, publication history with per-platform status chips (progress, attempts, errors, retry button, link to the published post), and a month calendar. Refreshes automatically while jobs are in flight. "Run worker now" processes due jobs immediately. |
| **Accounts** `/accounts` | Per platform: configured or not (and which env vars are missing), dry-run badge, OAuth **Connect**, connected accounts with **Disconnect**. |
| `/dry-run/<jobId>` | What a simulated job would have sent (final title, caption with hashtags, tags, visibility, schedule, warnings). |

## Architecture

```
Browser (React client components)
  │  POST /api/media (raw body, streamed)      POST /api/posts      GET /api/posts, /api/accounts
  ▼
Next.js route handlers (app/api/*) ── lib/services/posts.ts (compose, read models)
  │
  ├─ lib/platforms/   rules per platform + validation engine (shared with the browser)
  ├─ lib/db/          SQLite (node:sqlite): migrations, repository, savepoint transactions
  ├─ lib/storage/     local file storage under ./data/uploads
  ├─ lib/jobs/        job state machine · runner · in-process worker
  └─ lib/adapters/    PlatformAdapter interface · BaseAdapter · one adapter per platform
```

**Data model:** `posts` hold the default title, caption, hashtags, video, thumbnail, visibility and schedule. Each post has one `post_targets` row per platform, with nullable title/caption/hashtag overrides plus settings. `publish_jobs` records status (`queued → uploading → published | failed`), attempts and max attempts, progress, the adapter's resume checkpoint, result URL, what was sent, and the error. Also: `media` (videos and images), `connected_accounts` (OAuth tokens) and `oauth_states` (CSRF state + PKCE verifier).

**Publishing pipeline**

1. `POST /api/posts` re-validates every target on the server. Any error blocks publishing; drafts skip strict validation. It then stores the post and its targets and enqueues one job per platform. Each job is due at `scheduledAt`, except YouTube, which uploads immediately with `publishAt` and lets YouTube flip it public at the scheduled time.
2. **Worker** (`lib/jobs/worker.ts`) is a process-wide singleton. It starts at server boot (`instrumentation.ts`) and lazily from API routes. Every `WORKER_INTERVAL_MS` it claims due jobs atomically and runs up to `WORKER_CONCURRENCY` at once. Jobs left `uploading` by a restart are re-queued at startup.
3. **Runner** (`lib/jobs/runner.ts`) does the following for each job:
   - resolves the target's content, account, file and thumbnail;
   - decides between dry-run and a real publish;
   - refreshes tokens that are close to expiry, and refreshes once more and retries if the platform returns 401;
   - records progress and resume checkpoints, so a retried upload continues where it stopped.
4. **Failures:** errors marked retryable (5xx, 429, network) re-queue with backoff of 30s, 60s, … up to 3 attempts. Validation, quota, 4xx and missing-account errors fail immediately. `POST /api/jobs/:id/retry` re-queues a failed job with one extra attempt. `POST /api/jobs/run` processes everything that is due and waits for it.

**Adapters** implement `PlatformAdapter`:

- `validate`, `publish` (dry-run aware), `getAuthUrl`, `handleCallback`, `refreshAccessToken`;
- `capabilities` (`pkce`, `nativeScheduling`, `thumbnail`, …) and `credentialEnvVars`.

`BaseAdapter` provides rule-based validation, dry-run simulation, and the generic OAuth2 code and refresh flows. Platform classes implement `fetchProfile` and `doPublish`. HTTP failures go through `lib/adapters/http.ts`, which decides what is retryable. `tests/adapter-contract.test.ts` runs the same contract against every registered adapter.

**Validation** (`lib/platforms/`) knows each platform's limits:

- title and caption length, counted the way the platform counts (X counts URLs as 23 characters and emoji/CJK as 2);
- hashtag limits;
- duration, file size, formats, aspect-ratio range and resolution;
- whether a video counts as a YouTube Short.

It returns errors, warnings and suggested adaptations. Text adaptations (truncate, trim hashtags, derive a title) apply automatically. Media adaptations (reframe, trim, compress, transcode) are only suggested.

## What is real vs. simulated

| Area | Status |
| --- | --- |
| Compose UI, per-platform overrides, live validation, one-click text fixes | **Real** |
| Platform rules / limits | **Real data, best effort** as of 2026-10; some values are approximate (marked in `lib/platforms/rules.ts` notes) |
| Uploads to local disk, SQLite persistence | **Real** |
| Job queue, worker, scheduling, retries/backoff, resume checkpoints, token refresh | **Real** (single process) |
| Dry-run publishing | **Simulated**: validation runs, upload progress is faked, the result links to `/dry-run/<jobId>` |
| OAuth connect/callback/disconnect | **Real flow** (state + PKCE stored in DB). Only exercised against mocked token endpoints. |
| **YouTube** adapter | **Real implementation** (resumable chunked upload with resume, snippet/status, `publishAt`, thumbnail, refresh). Tested against a simulated YouTube server; **not yet run against the live API**. |
| TikTok, Instagram, X, Facebook, LinkedIn, Vimeo adapters | **API-shaped implementations** of each documented flow, with resume support. Tested **only with mocked HTTP**; endpoint and field details may need adjusting against the live APIs. Run in dry-run when unconfigured. |
| Media processing (reframe/trim/compress/transcode) | **Not implemented**: suggestions only |
| Server-side media probing | **Not implemented**: duration/dimensions are reported by the browser |
| Token encryption at rest, app login / multi-user | **Not implemented**: single-user local app; tokens are stored in plaintext in SQLite |
| Draft editing / publishing a saved draft | **Not implemented** (drafts can be saved and viewed) |
| Platform-specific settings UI (YouTube category, made-for-kids, Facebook Page choice, TikTok interaction toggles) | Backend supports `target.settings`; **no UI yet** |

## Platforms: APIs and approval requirements

Approval programs change often, so check each provider's current docs before relying on these. Register `$APP_URL/api/auth/<platform>/callback` as the redirect URI.

| Platform | API used | Scopes | App review / restrictions |
| --- | --- | --- | --- |
| **YouTube** | [YouTube Data API v3](https://developers.google.com/youtube/v3/docs/videos/insert): `videos.insert` (resumable), `thumbnails.set` | `youtube.upload`, `youtube.readonly` | OAuth consent screen verification for public use (while "Testing", only listed test users can connect). Videos uploaded by **unaudited API projects are locked to private** until the project passes the YouTube API Services audit. Default quota is 10,000 units/day and uploads are expensive. Custom thumbnails require a verified channel. |
| **TikTok** | [Content Posting API](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post): creator_info → video/init (FILE_UPLOAD) → chunk PUT → status/fetch | `user.info.basic`, `video.upload`, `video.publish` | App must be approved for Content Posting. **Unaudited clients can only post privately (SELF_ONLY)** with limited users. TikTok's audit also requires specific UX (creator info, privacy choice with no default, interaction toggles, consent text) that the compose UI doesn't implement yet. |
| **Instagram** | [Instagram API with Instagram Login](https://developers.facebook.com/docs/instagram-platform/content-publishing): REELS container (resumable) → rupload → status → media_publish | `instagram_business_basic`, `instagram_business_content_publish` | Requires an Instagram **Business or Creator** account. Publishing for accounts other than your own needs Meta **App Review (Advanced Access)** and business verification. Rate-limited publishing (posts per 24h). |
| **Facebook Pages** | [Graph API video upload](https://developers.facebook.com/docs/video-api/guides/publishing): `/{page-id}/videos` start/transfer/finish with a Page token | `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `publish_video` | Page permissions need **App Review + Business Verification** for Advanced Access. Only Pages the user manages; personal profiles are not supported by the API. Uses the older chunked flow, while Meta now promotes a newer resumable-upload flow. |
| **X** | [Media upload v2](https://docs.x.com/x-api/media/upload-media) (initialize/append/finalize/status) + `POST /2/tweets` | `tweet.read`, `tweet.write`, `users.read`, `media.write`, `offline.access` | OAuth 2.0 with PKCE. Posting and media upload are subject to your **API access tier**; the free tier has very tight write limits. Long posts and long videos need a Premium account (handled via account metadata). |
| **LinkedIn** | [Videos API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api) (initializeUpload → part PUTs → finalizeUpload) + [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api) | `openid`, `profile`, `w_member_social` | "Share on LinkedIn" + "Sign In with LinkedIn (OpenID Connect)" products are self-serve for **member** posting. Posting as an **organization** requires the Community Management API (approval). Versioned API (`LINKEDIN_API_VERSION`). |
| **Vimeo** | [Upload API (tus)](https://developer.vimeo.com/api/upload/videos): `POST /me/videos` → tus PATCH → tags | `public`, `private`, `upload`, `edit` | Apps must **request upload access**. Storage/weekly quotas and some privacy options depend on the user's plan. |

## Configuration

All env vars are documented in [`.env.example`](.env.example) (a test fails if code reads an undocumented variable).

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_URL` | request origin | Base URL for OAuth redirect URIs |
| `DATABASE_PATH` | `./data/app.db` | SQLite file |
| `UPLOAD_DIR` | `./data/uploads` | Uploaded files |
| `DRY_RUN` | unset (auto) | `true` = simulate all; `false` = always real; unset = simulate platforms without credentials |
| `DRY_RUN_DELAY_MS` | `1500` | Simulated upload time |
| `WORKER_INTERVAL_MS` / `WORKER_CONCURRENCY` / `WORKER_DISABLED` | `5000` / `2` / `false` | In-process worker |
| `YOUTUBE_CLIENT_ID` / `_SECRET` | — | YouTube OAuth client |
| `TIKTOK_CLIENT_KEY` / `_SECRET` | — | TikTok app |
| `INSTAGRAM_APP_ID` / `_SECRET` | — | Instagram app |
| `FACEBOOK_APP_ID` / `_SECRET` | — | Facebook app |
| `X_CLIENT_ID` / `_SECRET` | — | X OAuth 2.0 client |
| `LINKEDIN_CLIENT_ID` / `_SECRET` | — | LinkedIn app |
| `VIMEO_CLIENT_ID` / `_SECRET` | — | Vimeo app |
| `FACEBOOK_GRAPH_VERSION` / `INSTAGRAM_GRAPH_VERSION` / `LINKEDIN_API_VERSION` | `v23.0` / `v23.0` / `202509` | API version pins |

## Testing

`npm test` runs everything with Vitest, using in-memory SQLite and mocked HTTP. No network access or credentials are needed.

| File | Covers |
| --- | --- |
| `tests/rules.test.ts`, `validate.test.ts`, `text.test.ts` | Platform limits, validation engine, adaptations, character counting/truncation |
| `tests/db.test.ts` | Schema, repository, job state transitions, OAuth state |
| `tests/pipeline.test.ts` | Compose → enqueue → worker: dry-run end-to-end, scheduling (incl. YouTube native), concurrency, auto-retry/backoff, manual retry, checkpoints, orphan recovery, dry-run modes, token refresh |
| `tests/adapter-contract.test.ts` | The same contract for **every** adapter: identity, env vars documented, configured detection, auth URL, dry-run without network, validation before network, no-account, retryable 5xx/network errors, 401 → `auth_failed`, callback/refresh failures |
| `tests/youtube.test.ts` | YouTube resumable upload against a fake server: chunking, resume after 5xx, expired session, `publishAt`, Shorts URL, thumbnail, quota/auth errors, token refresh |
| `tests/platform-adapters.test.ts` | Request sequences for TikTok, Instagram, X, Facebook, LinkedIn, Vimeo against mocked APIs |
| `tests/adapters.test.ts`, `storage.test.ts` | Registry/OAuth helpers, local storage |

`npm run smoke` (`scripts/smoke-dry-run.sh`) exercises a running server over HTTP: upload → post to all 7 platforms → run worker → assert all published.

## Limitations / next steps

- Run the YouTube adapter against the live API and verify the other adapters one platform at a time.
- Encrypt tokens at rest; add app authentication before exposing this beyond localhost.
- One app instance only: the worker has no cross-process lease. Move to a real queue for multi-instance deployments.
- Media pipeline (ffprobe/ffmpeg) for server-side probing and the suggested reframe/trim/compress adaptations.
- Draft editing, platform-specific settings UI, and TikTok's required posting UX.
