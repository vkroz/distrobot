import type { JobStatus, PostStatus } from "@/lib/types";

/**
 * Publish job lifecycle:
 *   queued → uploading → published
 *                     ↘ failed  (terminal unless manually retried)
 *                     ↘ queued  (automatic retry with backoff while attempts < maxAttempts)
 *   failed → queued (manual retry)
 */
const TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued: ["uploading"],
  uploading: ["published", "failed", "queued"],
  failed: ["queued"],
  published: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new Error(`Invalid job transition ${from} → ${to}`);
}

/** Exponential backoff: 30s, 60s, 120s, ... capped at 30 min. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 30 * 60_000);
}

/** Derive the overall post status from its jobs' statuses. */
export function derivePostStatus(jobStatuses: JobStatus[], current: PostStatus = "draft"): PostStatus {
  if (jobStatuses.length === 0) return current === "scheduled" ? "scheduled" : "draft";
  if (jobStatuses.some((s) => s === "queued" || s === "uploading")) return "publishing";
  const published = jobStatuses.filter((s) => s === "published").length;
  if (published === jobStatuses.length) return "published";
  if (published === 0) return "failed";
  return "partial";
}
