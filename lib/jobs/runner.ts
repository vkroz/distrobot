import { getAdapter as defaultGetAdapter, AdapterError, type PlatformAdapter } from "@/lib/adapters";
import type { DB } from "@/lib/db";
import { claimNextJob, getAccount, getMedia, getPost, getTarget, markJobFailed, markJobPublished } from "@/lib/db/repo";
import { resolveTargetContent } from "@/lib/platforms/validate";
import { resolveStoragePath } from "@/lib/storage/local";
import type { PlatformId, PublishJob } from "@/lib/types";

export interface RunnerOptions {
  getAdapter?: (p: PlatformId) => PlatformAdapter;
  /** Force dry-run for every job (defaults to PUBLISH_DRY_RUN=true). */
  forceDryRun?: boolean;
  uploadDir?: string;
}

/**
 * Claim and execute one due job. Returns the job's final state, or null if nothing was due.
 * Intended to be called by a background worker loop (not wired up yet).
 */
export async function runNextJob(db: DB, opts: RunnerOptions = {}): Promise<PublishJob | null> {
  const job = claimNextJob(db);
  if (!job) return null;
  const getAdapter = opts.getAdapter ?? defaultGetAdapter;
  const forceDryRun = opts.forceDryRun ?? process.env.PUBLISH_DRY_RUN === "true";

  try {
    const target = getTarget(db, job.targetId);
    const post = getPost(db, job.postId);
    if (!target || !post) throw new AdapterError("upstream_error", "Post or target was deleted");
    const media = post.mediaId ? getMedia(db, post.mediaId) : null;
    if (!media) throw new AdapterError("validation_failed", "Post has no media attached");
    const account = target.accountId ? getAccount(db, target.accountId) : null;

    const result = await getAdapter(job.platform).publish(
      {
        jobId: job.id,
        content: resolveTargetContent(post, target),
        media,
        mediaPath: resolveStoragePath(media.storagePath, opts.uploadDir),
        settings: target.settings,
      },
      { account, dryRun: forceDryRun || job.dryRun },
    );
    return markJobPublished(db, job.id, { url: result.url, externalId: result.externalId });
  } catch (err) {
    const retryable = err instanceof AdapterError ? err.retryable : true;
    const message = err instanceof Error ? err.message : String(err);
    return markJobFailed(db, job.id, message, { retryable });
  }
}
