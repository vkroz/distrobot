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

## Layout

| Path | Purpose |
| --- | --- |
| `lib/types.ts` | Domain types (posts, targets, media, jobs, accounts) |
| `lib/db/` | SQLite connection, migrations (`schema.ts`), repository functions (`repo.ts`) |
| `lib/platforms/rules.ts` | Per-platform limits (text, hashtags, duration, size, aspect ratio) |
| `lib/platforms/validate.ts` | Validation engine → errors / warnings / suggested adaptations |
| `lib/platforms/text.ts` | Platform-aware character counting, hashtag parsing, smart truncation |
| `lib/adapters/` | `PlatformAdapter` interface, `BaseAdapter` (validation, dry-run, OAuth2), one adapter per platform |
| `lib/jobs/` | Job state machine and a single-job runner |
| `lib/storage/local.ts` | Streaming uploads to `./data/uploads` |
| `app/api/*` | `health`, `validate`, `media` (raw-body upload) |

Set `PUBLISH_DRY_RUN=true` to force every publish job into dry-run mode.
