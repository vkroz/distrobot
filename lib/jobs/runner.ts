import { AdapterError, getAdapter as defaultGetAdapter, type PlatformAdapter } from "@/lib/adapters";
import type { DB } from "@/lib/db";
import {
  claimNextJob,
  getAccount,
  getMedia,
  getPost,
  getTarget,
  listAccounts,
  markJobFailed,
  markJobPublished,
  saveJobCheckpoint,
  updateAccountTokens,
  updateJobProgress,
} from "@/lib/db/repo";
import { resolveTargetContent } from "@/lib/platforms/validate";
import { resolveStoragePath } from "@/lib/storage/local";
import type { ConnectedAccount, PlatformId, PostTarget, PublishJob } from "@/lib/types";

/** on: everything simulated. off: always real. auto: simulated for platforms without OAuth credentials. */
export type DryRunMode = "on" | "off" | "auto";

export function dryRunModeFromEnv(env: Record<string, string | undefined> = process.env): DryRunMode {
  const v = env.DRY_RUN?.trim().toLowerCase();
  if (v && ["1", "true", "yes", "on"].includes(v)) return "on";
  if (v && ["0", "false", "no", "off"].includes(v)) return "off";
  return "auto";
}

export function shouldDryRun(adapter: PlatformAdapter, job: Pick<PublishJob, "dryRun">, mode: DryRunMode): boolean {
  if (job.dryRun || mode === "on") return true;
  if (mode === "off") return false;
  return !adapter.isConfigured();
}

export interface RunnerOptions {
  getAdapter?: (p: PlatformId) => PlatformAdapter;
  dryRunMode?: DryRunMode;
  /** Simulated latency for dry-run uploads. */
  simulatedDelayMs?: number;
  uploadDir?: string;
  fetch?: typeof fetch;
}

/** Refresh a little before expiry to avoid failing mid-upload. */
const REFRESH_MARGIN_MS = 5 * 60_000;

function resolveAccount(db: DB, target: PostTarget): ConnectedAccount | null {
  if (target.accountId) return getAccount(db, target.accountId);
  return listAccounts(db, target.platform)[0] ?? null;
}

async function refreshAccount(
  db: DB,
  adapter: PlatformAdapter,
  account: ConnectedAccount,
  fetchImpl?: typeof fetch,
): Promise<ConnectedAccount> {
  const tokens = await adapter.refreshAccessToken(account, fetchImpl);
  return updateAccountTokens(db, account.id, tokens);
}

function needsRefresh(account: ConnectedAccount): boolean {
  return !!account.refreshToken && !!account.expiresAt && Date.parse(account.expiresAt) - Date.now() < REFRESH_MARGIN_MS;
}

/** Execute an already-claimed (`uploading`) job to completion. Never throws. */
export async function executeJob(db: DB, job: PublishJob, opts: RunnerOptions = {}): Promise<PublishJob> {
  const getAdapter = opts.getAdapter ?? defaultGetAdapter;
  try {
    const target = getTarget(db, job.targetId);
    const post = getPost(db, job.postId);
    if (!target || !post) throw new AdapterError("validation_failed", "Post or target was deleted");
    const media = post.mediaId ? getMedia(db, post.mediaId) : null;
    if (!media) throw new AdapterError("validation_failed", "Post has no video attached");
    const thumb = post.thumbnailId ? getMedia(db, post.thumbnailId) : null;

    const adapter = getAdapter(job.platform);
    const dryRun = shouldDryRun(adapter, job, opts.dryRunMode ?? dryRunModeFromEnv());
    let account = dryRun ? null : resolveAccount(db, target);
    if (account && needsRefresh(account)) account = await refreshAccount(db, adapter, account, opts.fetch);

    const scheduledAt =
      adapter.capabilities.nativeScheduling && post.scheduledAt && Date.parse(post.scheduledAt) > Date.now()
        ? post.scheduledAt
        : null;
    const request = {
      jobId: job.id,
      content: resolveTargetContent(post, target),
      media,
      mediaPath: resolveStoragePath(media.storagePath, opts.uploadDir),
      thumbnail: thumb
        ? {
            path: resolveStoragePath(thumb.storagePath, opts.uploadDir),
            mimeType: thumb.mimeType ?? "image/jpeg",
            sizeBytes: thumb.sizeBytes ?? 0,
          }
        : null,
      visibility: post.visibility,
      scheduledAt,
      settings: target.settings,
      checkpoint: job.checkpoint,
    };

    let lastProgressAt = 0;
    const ctx = {
      dryRun,
      simulatedDelayMs: opts.simulatedDelayMs,
      fetch: opts.fetch,
      onProgress: (p: { fraction?: number }) => {
        // Throttle DB writes.
        if (p.fraction === undefined || (Date.now() - lastProgressAt < 250 && p.fraction < 1)) return;
        lastProgressAt = Date.now();
        updateJobProgress(db, job.id, p.fraction);
      },
      saveCheckpoint: (data: unknown) => saveJobCheckpoint(db, job.id, data),
    };

    let result;
    try {
      result = await adapter.publish(request, { ...ctx, account });
    } catch (err) {
      // One forced refresh + retry on auth failure (token revoked early / clock skew).
      if (err instanceof AdapterError && err.code === "auth_failed" && account?.refreshToken) {
        account = await refreshAccount(db, adapter, account, opts.fetch);
        result = await adapter.publish(request, { ...ctx, account });
      } else {
        throw err;
      }
    }
    return markJobPublished(db, job.id, {
      url: result.url,
      externalId: result.externalId,
      payload: { ...result.payload, dryRun: result.dryRun },
      warnings: result.warnings,
    });
  } catch (err) {
    // Unknown errors (bugs, fs errors) are retried; adapters decide for their own errors.
    const retryable = err instanceof AdapterError ? err.retryable : true;
    const message = err instanceof Error ? err.message : String(err);
    return markJobFailed(db, job.id, message, { retryable });
  }
}

/** Claim and execute one due job. Returns its final state, or null if nothing was due. */
export async function runNextJob(db: DB, opts: RunnerOptions = {}): Promise<PublishJob | null> {
  const job = claimNextJob(db);
  return job ? executeJob(db, job, opts) : null;
}
