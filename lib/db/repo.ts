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
  resultUrl: str(r.result_url),
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

export type NewMedia = Omit<Media, "id" | "createdAt" | "checksum"> & { checksum?: string | null };

export function createMedia(db: DB, input: NewMedia): Media {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO media (id, original_filename, storage_path, mime_type, size_bytes, duration_sec, width, height, checksum, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
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
  scheduledAt?: string | null;
}

export function createPost(db: DB, input: PostInput = {}): Post {
  const id = randomUUID();
  const ts = now();
  db.prepare(
    `INSERT INTO posts (id, title, caption, hashtags, media_id, status, scheduled_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
  ).run(id, input.title ?? "", input.caption ?? "", json(input.hashtags ?? []), nul(input.mediaId), nul(input.scheduledAt), ts, ts);
  return getPost(db, id)!;
}

export const getPost = (db: DB, id: string) => one(db, toPost, "SELECT * FROM posts WHERE id = ?", id);
export const listPosts = (db: DB) => many(db, toPost, "SELECT * FROM posts ORDER BY created_at DESC");

export function updatePost(db: DB, id: string, input: PostInput): Post {
  const existing = getPost(db, id);
  if (!existing) throw new Error(`Post ${id} not found`);
  const merged = { ...existing, ...input };
  db.prepare(
    `UPDATE posts SET title = ?, caption = ?, hashtags = ?, media_id = ?, scheduled_at = ?, updated_at = ? WHERE id = ?`,
  ).run(merged.title, merged.caption, json(merged.hashtags), nul(merged.mediaId), nul(merged.scheduledAt), now(), id);
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

export const getAccount = (db: DB, id: string) => one(db, toAccount, "SELECT * FROM connected_accounts WHERE id = ?", id);
export const listAccounts = (db: DB, platform?: PlatformId) =>
  platform
    ? many(db, toAccount, "SELECT * FROM connected_accounts WHERE platform = ? ORDER BY created_at", platform)
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
export function enqueuePublish(db: DB, postId: string, opts: { dryRun?: boolean; maxAttempts?: number; runAt?: string } = {}): PublishJob[] {
  return transaction(db, () => {
    const ts = now();
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
      ).run(id, postId, t.id, t.platform, opts.maxAttempts ?? 3, opts.dryRun ? 1 : 0, opts.runAt ?? ts, ts, ts);
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
      `UPDATE publish_jobs SET status = 'uploading', attempts = attempts + 1, started_at = ?, error = NULL, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
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

export function markJobPublished(db: DB, id: string, result: { url: string | null; externalId?: string | null }) {
  return setStatus(db, id, "published", {
    result_url: result.url,
    external_id: result.externalId ?? null,
    error: null,
    finished_at: now(),
  });
}

/** Record a failure; re-queues with backoff if retryable and attempts remain. */
export function markJobFailed(db: DB, id: string, error: string, opts: { retryable?: boolean } = {}) {
  const job = getJob(db, id);
  if (!job) throw new Error(`Job ${id} not found`);
  if (opts.retryable !== false && job.attempts < job.maxAttempts) {
    const next = new Date(Date.now() + retryDelayMs(job.attempts)).toISOString();
    return setStatus(db, id, "queued", { error, next_run_at: next });
  }
  return setStatus(db, id, "failed", { error, finished_at: now() });
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
      `SELECT status FROM publish_jobs j WHERE post_id = ? AND created_at = (
         SELECT MAX(created_at) FROM publish_jobs WHERE target_id = j.target_id)`,
    )
    .all(postId) as Array<{ status: JobStatus }>;
  const status = derivePostStatus(
    rows.map((r) => r.status),
    post.status,
  );
  if (status !== post.status) {
    db.prepare("UPDATE posts SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), postId);
  }
  return getPost(db, postId);
}
