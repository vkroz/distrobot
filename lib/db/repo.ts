import { randomUUID } from "node:crypto";
import type { DB } from "./index";
import { transaction } from "./index";
import { assertTransition, derivePostStatus, retryDelayMs } from "@/lib/jobs/state";
import type {
  ConnectedAccount,
  JobStatus,
  Media,
  PlatformId,
  Post,
  PostStatus,
  PostTarget,
  PublishJob,
  Visibility,
} from "@/lib/types";

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v ?? null);
const parse = <T>(v: unknown, fallback: T): T => (typeof v === "string" ? (JSON.parse(v) as T) : fallback);
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? undefined : Number(v));
/** node:sqlite rejects `undefined` bind values. */
const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

const toMedia = (r: Row): Media => ({
  id: String(r.id),
  kind: (r.kind as Media["kind"]) ?? "video",
  metadataSource: (r.metadata_source as Media["metadataSource"]) ?? null,
  originalFilename: String(r.original_filename),
  storagePath: String(r.storage_path),
  mimeType: str(r.mime_type) ?? undefined,
  sizeBytes: num(r.size_bytes),
  durationSec: num(r.duration_sec),
  width: num(r.width),
  height: num(r.height),
  checksum: str(r.checksum),
  createdAt: String(r.created_at),
});

const toPost = (r: Row): Post => ({
  id: String(r.id),
  title: String(r.title),
  caption: String(r.caption),
  hashtags: parse(r.hashtags, []),
  mediaId: str(r.media_id),
  thumbnailId: str(r.thumbnail_id),
  visibility: (r.visibility as Visibility) ?? "public",
  status: r.status as PostStatus,
  scheduledAt: str(r.scheduled_at),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toTarget = (r: Row): PostTarget => ({
  id: String(r.id),
  postId: String(r.post_id),
  platform: r.platform as PlatformId,
  accountId: str(r.account_id),
  enabled: Number(r.enabled) === 1,
  titleOverride: str(r.title_override),
  captionOverride: str(r.caption_override),
  hashtagsOverride: parse<string[] | null>(r.hashtags_override, null),
  settings: parse(r.settings, {}),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toJob = (r: Row): PublishJob => ({
  id: String(r.id),
  postId: String(r.post_id),
  targetId: String(r.target_id),
  platform: r.platform as PlatformId,
  status: r.status as JobStatus,
  attempts: Number(r.attempts),
  maxAttempts: Number(r.max_attempts),
  dryRun: Number(r.dry_run) === 1,
  progress: r.progress === null || r.progress === undefined ? null : Number(r.progress),
  checkpoint: parse<unknown>(r.checkpoint, null),
  resultUrl: str(r.result_url),
  resultPayload: parse<unknown>(r.result_payload, null),
  externalId: str(r.external_id),
  error: str(r.error),
  nextRunAt: str(r.next_run_at),
  startedAt: str(r.started_at),
  finishedAt: str(r.finished_at),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

const toAccount = (r: Row): ConnectedAccount => ({
  id: String(r.id),
  platform: r.platform as PlatformId,
  externalId: String(r.external_id),
  displayName: String(r.display_name),
  accessToken: String(r.access_token),
  refreshToken: str(r.refresh_token),
  expiresAt: str(r.expires_at),
  scopes: parse(r.scopes, []),
  metadata: parse(r.metadata, {}),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

function one<T>(db: DB, map: (r: Row) => T, sql: string, ...params: SqlValue[]): T | null {
  const row = db.prepare(sql).get(...params) as Row | undefined;
  return row ? map(row) : null;
}

function many<T>(db: DB, map: (r: Row) => T, sql: string, ...params: SqlValue[]): T[] {
  return (db.prepare(sql).all(...params) as Row[]).map(map);
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export type NewMedia = Omit<Media, "id" | "createdAt" | "checksum" | "kind" | "metadataSource"> & {
  checksum?: string | null;
  kind?: Media["kind"];
  metadataSource?: Media["metadataSource"];
};

export function createMedia(db: DB, input: NewMedia): Media {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media (id, kind, metadata_source, original_filename, storage_path, mime_type, size_bytes, duration_sec, width, height,
       checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.kind ?? "video",
    nul(input.metadataSource),
    input.originalFilename,
    input.storagePath,
    nul(input.mimeType),
    nul(input.sizeBytes),
    nul(input.durationSec),
    nul(input.width),
    nul(input.height),
    nul(input.checksum),
    now(),
  );
  return getMedia(db, id)!;
}

export const getMedia = (db: DB, id: string) => one(db, toMedia, "SELECT * FROM media WHERE id = ?", id);

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

export interface PostInput {
  title?: string;
  caption?: string;
  hashtags?: string[];
  mediaId?: string | null;
  thumbnailId?: string | null;
  visibility?: Visibility;
  scheduledAt?: string | null;
}

export function createPost(db: DB, input: PostInput = {}): Post {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO posts (id, title, caption, hashtags, media_id, thumbnail_id, visibility, status, scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).run(
    id,
    input.title ?? "",
    input.caption ?? "",
    json(input.hashtags ?? []),
    nul(input.mediaId),
    nul(input.thumbnailId),
    input.visibility ?? "public",
    nul(input.scheduledAt),
    ts,
    ts,
  );
  return getPost(db, id)!;
}

export const getPost = (db: DB, id: string) => one(db, toPost, "SELECT * FROM posts WHERE id = ?", id);
export const listPosts = (db: DB, limit = 100) =>
  many(db, toPost, "SELECT * FROM posts ORDER BY created_at DESC LIMIT ?", limit);

export function updatePost(db: DB, id: string, input: PostInput): Post {
  const existing = getPost(db, id);
  if (!existing) throw new Error(`Post ${id} not found`);
  const merged = { ...existing, ...input };
  db.prepare(
    `UPDATE posts SET title = ?, caption = ?, hashtags = ?, media_id = ?, thumbnail_id = ?, visibility = ?, scheduled_at = ?,
       updated_at = ? WHERE id = ?`,
  ).run(
    merged.title,
    merged.caption,
    json(merged.hashtags),
    nul(merged.mediaId),
    nul(merged.thumbnailId),
    merged.visibility,
    nul(merged.scheduledAt),
    now(),
    id,
  );
  return getPost(db, id)!;
}

export const deletePost = (db: DB, id: string) => void db.prepare("DELETE FROM posts WHERE id = ?").run(id);

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export interface TargetInput {
  accountId?: string | null;
  enabled?: boolean;
  titleOverride?: string | null;
  captionOverride?: string | null;
  hashtagsOverride?: string[] | null;
  settings?: Record<string, unknown>;
}

/** Create or update the target for (post, platform). Omitted fields keep their current value. */
export function upsertTarget(db: DB, postId: string, platform: PlatformId, input: TargetInput = {}): PostTarget {
  const existing = one(db, toTarget, "SELECT * FROM post_targets WHERE post_id = ? AND platform = ?", postId, platform);
  const ts = now();
  const m = {
    accountId: input.accountId !== undefined ? input.accountId : (existing?.accountId ?? null),
    enabled: input.enabled ?? existing?.enabled ?? true,
    titleOverride: input.titleOverride !== undefined ? input.titleOverride : (existing?.titleOverride ?? null),
    captionOverride: input.captionOverride !== undefined ? input.captionOverride : (existing?.captionOverride ?? null),
    hashtagsOverride:
      input.hashtagsOverride !== undefined ? input.hashtagsOverride : (existing?.hashtagsOverride ?? null),
    settings: input.settings ?? existing?.settings ?? {},
  };
  if (existing) {
    db.prepare(
      `UPDATE post_targets SET account_id = ?, enabled = ?, title_override = ?, caption_override = ?,
         hashtags_override = ?, settings = ?, updated_at = ? WHERE id = ?`,
    ).run(
      m.accountId,
      m.enabled ? 1 : 0,
      m.titleOverride,
      m.captionOverride,
      m.hashtagsOverride ? json(m.hashtagsOverride) : null,
      json(m.settings),
      ts,
      existing.id,
    );
    return getTarget(db, existing.id)!;
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO post_targets (id, post_id, platform, account_id, enabled, title_override, caption_override,
       hashtags_override, settings, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    postId,
    platform,
    m.accountId,
    m.enabled ? 1 : 0,
    m.titleOverride,
    m.captionOverride,
    m.hashtagsOverride ? json(m.hashtagsOverride) : null,
    json(m.settings),
    ts,
    ts,
  );
  return getTarget(db, id)!;
}

export const getTarget = (db: DB, id: string) => one(db, toTarget, "SELECT * FROM post_targets WHERE id = ?", id);
export const listTargets = (db: DB, postId: string) =>
  many(db, toTarget, "SELECT * FROM post_targets WHERE post_id = ? ORDER BY created_at", postId);

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

export type AccountInput = Omit<ConnectedAccount, "id" | "createdAt" | "updatedAt">;

/** Insert or refresh credentials for (platform, externalId). */
export function upsertAccount(db: DB, input: AccountInput): ConnectedAccount {
  const ts = now();
  db.prepare(
    `INSERT INTO connected_accounts (id, platform, external_id, display_name, access_token, refresh_token, expires_at,
       scopes, metadata, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (platform, external_id) DO UPDATE SET
       display_name = excluded.display_name, access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, connected_accounts.refresh_token),
       expires_at = excluded.expires_at, scopes = excluded.scopes, metadata = excluded.metadata,
       updated_at = excluded.updated_at`,
  ).run(
    randomUUID(),
    input.platform,
    input.externalId,
    input.displayName,
    input.accessToken,
    input.refreshToken,
    input.expiresAt,
    json(input.scopes),
    json(input.metadata),
    ts,
    ts,
  );
  return one(
    db,
    toAccount,
    "SELECT * FROM connected_accounts WHERE platform = ? AND external_id = ?",
    input.platform,
    input.externalId,
  )!;
}

export function updateAccountTokens(
  db: DB,
  id: string,
  t: { accessToken: string; refreshToken: string | null; expiresAt: string | null },
): ConnectedAccount {
  db.prepare(
    "UPDATE connected_accounts SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?",
  ).run(t.accessToken, t.refreshToken, t.expiresAt, now(), id);
  return getAccount(db, id)!;
}

export const getAccount = (db: DB, id: string) => one(db, toAccount, "SELECT * FROM connected_accounts WHERE id = ?", id);
export const listAccounts = (db: DB, platform?: PlatformId) =>
  platform
    ? many(db, toAccount, "SELECT * FROM connected_accounts WHERE platform = ? ORDER BY updated_at DESC", platform)
    : many(db, toAccount, "SELECT * FROM connected_accounts ORDER BY platform, created_at");
export const deleteAccount = (db: DB, id: string) =>
  void db.prepare("DELETE FROM connected_accounts WHERE id = ?").run(id);

// ---------------------------------------------------------------------------
// Publish jobs
// ---------------------------------------------------------------------------

export const getJob = (db: DB, id: string) => one(db, toJob, "SELECT * FROM publish_jobs WHERE id = ?", id);
export const listJobs = (db: DB, postId: string) =>
  many(db, toJob, "SELECT * FROM publish_jobs WHERE post_id = ? ORDER BY created_at", postId);

/** Create one queued job per enabled target that doesn't already have an active or published job. */
export interface EnqueueOptions {
  dryRun?: boolean;
  maxAttempts?: number;
  /** When each target's job becomes due. Defaults to the post's scheduledAt, or now. */
  runAtFor?: (target: PostTarget, post: Post) => string;
}

export function enqueuePublish(db: DB, postId: string, opts: EnqueueOptions = {}): PublishJob[] {
  return transaction(db, () => {
    const ts = now();
    const post = getPost(db, postId);
    if (!post) throw new Error(`Post ${postId} not found`);
    const runAtFor = opts.runAtFor ?? ((_t: PostTarget, p: Post) => p.scheduledAt ?? ts);
    const created: PublishJob[] = [];
    for (const t of listTargets(db, postId)) {
      if (!t.enabled) continue;
      const active = db
        .prepare(`SELECT 1 FROM publish_jobs WHERE target_id = ? AND status IN ('queued','uploading','published')`)
        .get(t.id);
      if (active) continue;
      const id = randomUUID();
      db.prepare(
        `INSERT INTO publish_jobs (id, post_id, target_id, platform, status, attempts, max_attempts, dry_run, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
      ).run(id, postId, t.id, t.platform, opts.maxAttempts ?? 3, opts.dryRun ? 1 : 0, runAtFor(t, post), ts, ts);
      created.push(getJob(db, id)!);
    }
    syncPostStatus(db, postId);
    return created;
  });
}

/** Atomically claim the next due queued job, moving it to `uploading` and counting the attempt. */
export function claimNextJob(db: DB, at: Date = new Date()): PublishJob | null {
  return transaction(db, () => {
    const job = one(
      db,
      toJob,
      `SELECT * FROM publish_jobs WHERE status = 'queued' AND (next_run_at IS NULL OR next_run_at <= ?)
       ORDER BY next_run_at, created_at LIMIT 1`,
      at.toISOString(),
    );
    if (!job) return null;
    const ts = now();
    db.prepare(
      `UPDATE publish_jobs SET status = 'uploading', attempts = attempts + 1, started_at = ?, error = NULL, progress = 0,
         updated_at = ? WHERE id = ? AND status = 'queued'`,
    ).run(ts, ts, job.id);
    return getJob(db, job.id);
  });
}

function setStatus(db: DB, id: string, to: JobStatus, fields: Partial<Record<string, SqlValue>> = {}): PublishJob {
  const job = getJob(db, id);
  if (!job) throw new Error(`Job ${id} not found`);
  assertTransition(job.status, to);
  const cols = { ...fields, status: to, updated_at: now() };
  const keys = Object.keys(cols);
  db.prepare(`UPDATE publish_jobs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
    ...keys.map((k) => cols[k as keyof typeof cols] ?? null),
    id,
  );
  syncPostStatus(db, job.postId);
  return getJob(db, id)!;
}

export function markJobPublished(
  db: DB,
  id: string,
  result: { url: string | null; externalId?: string | null; payload?: unknown; warnings?: string[] },
) {
  return setStatus(db, id, "published", {
    result_url: result.url,
    external_id: result.externalId ?? null,
    result_payload: result.payload === undefined ? null : json({ ...(result.payload as object), warnings: result.warnings ?? [] }),
    error: null,
    progress: 1,
    checkpoint: null,
    finished_at: now(),
  });
}

export function updateJobProgress(db: DB, id: string, progress: number): void {
  db.prepare("UPDATE publish_jobs SET progress = ?, updated_at = ? WHERE id = ? AND status = 'uploading'").run(
    Math.max(0, Math.min(1, progress)),
    now(),
    id,
  );
}

export function saveJobCheckpoint(db: DB, id: string, checkpoint: unknown): void {
  db.prepare("UPDATE publish_jobs SET checkpoint = ?, updated_at = ? WHERE id = ?").run(
    checkpoint === null || checkpoint === undefined ? null : json(checkpoint),
    now(),
    id,
  );
}

/** Jobs left `uploading` by a crashed/restarted process go back to the queue (or fail if out of attempts). */
/**
 * Recover jobs left `uploading` by a process that died mid-upload. Only call this while holding the
 * worker lease (otherwise you'd steal another live process's jobs).
 *  - attempts remain → re-queued immediately; adapters with resume checkpoints continue the upload
 *  - out of attempts → failed with a clear message (can be retried manually)
 */
export function requeueOrphanedJobs(db: DB, exclude: Iterable<string> = []): PublishJob[] {
  const skip = new Set(exclude);
  const orphans = many(db, toJob, "SELECT * FROM publish_jobs WHERE status = 'uploading'").filter((j) => !skip.has(j.id));
  return orphans.map((j) => {
    const canRetry = j.attempts < j.maxAttempts;
    const message = canRetry
      ? `Interrupted by a server restart during upload (attempt ${j.attempts}/${j.maxAttempts}); re-queued automatically.`
      : `Interrupted by a server restart during upload and no attempts are left (${j.attempts}/${j.maxAttempts}). ` +
        "Check the platform for a partial post, then retry manually.";
    return markJobFailed(db, j.id, message, { retryable: canRetry, delayMs: 0 });
  });
}

export const listRecentJobs = (db: DB, limit = 200) =>
  many(db, toJob, "SELECT * FROM publish_jobs ORDER BY created_at DESC LIMIT ?", limit);

/** Record a failure; re-queues with backoff if retryable and attempts remain. */
export function markJobFailed(
  db: DB,
  id: string,
  error: string,
  opts: { retryable?: boolean; delayMs?: number } = {},
) {
  const job = getJob(db, id);
  if (!job) throw new Error(`Job ${id} not found`);
  if (opts.retryable !== false && job.attempts < job.maxAttempts) {
    const next = new Date(Date.now() + (opts.delayMs ?? retryDelayMs(job.attempts))).toISOString();
    return setStatus(db, id, "queued", { error, next_run_at: next, progress: null });
  }
  return setStatus(db, id, "failed", { error, progress: null, finished_at: now() });
}

/** Manually retry a failed job: grants one more attempt. */
export function retryJob(db: DB, id: string) {
  const job = getJob(db, id);
  if (!job) throw new Error(`Job ${id} not found`);
  return setStatus(db, id, "queued", {
    max_attempts: Math.max(job.maxAttempts, job.attempts + 1),
    next_run_at: now(),
    finished_at: null,
  });
}

/** Recompute post status from its latest job per target. */
export function syncPostStatus(db: DB, postId: string): Post | null {
  const post = getPost(db, postId);
  if (!post) return null;
  const rows = db
    .prepare(
      `SELECT status, attempts, next_run_at AS nextRunAt FROM publish_jobs j WHERE post_id = ? AND rowid = (
         SELECT MAX(rowid) FROM publish_jobs WHERE target_id = j.target_id)`,
    )
    .all(postId) as Array<{ status: JobStatus; attempts: number; nextRunAt: string | null }>;
  const status = derivePostStatus(rows, post.status);
  if (status !== post.status) {
    db.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), postId);
  }
  return getPost(db, postId);
}

// ---------------------------------------------------------------------------
// OAuth state (CSRF + PKCE), single use, 15 min TTL
// ---------------------------------------------------------------------------

const OAUTH_STATE_TTL_MS = 15 * 60_000;

export function createOAuthState(
  db: DB,
  input: { state: string; platform: PlatformId; codeVerifier?: string | null; redirectUri: string; returnTo?: string | null },
): void {
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(Date.now() - OAUTH_STATE_TTL_MS).toISOString());
  db.prepare(
    "INSERT INTO oauth_states (state, platform, code_verifier, redirect_uri, return_to, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(input.state, input.platform, nul(input.codeVerifier), input.redirectUri, nul(input.returnTo), now());
}

/** Fetch and delete a state; null if unknown, expired or for another platform. */
export function consumeOAuthState(db: DB, state: string, platform: PlatformId) {
  const row = db.prepare("SELECT * FROM oauth_states WHERE state = ?").get(state) as Row | undefined;
  if (!row) return null;
  db.prepare("DELETE FROM oauth_states WHERE state = ?").run(state);
  if (row.platform !== platform) return null;
  if (Date.parse(String(row.created_at)) < Date.now() - OAUTH_STATE_TTL_MS) return null;
  return { codeVerifier: str(row.code_verifier), redirectUri: String(row.redirect_uri), returnTo: str(row.return_to) };
}
