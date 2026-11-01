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

type JobLike = JobStatus | { status: JobStatus; attempts?: number; nextRunAt?: string | null };

/**
 * Derive the overall post status from its latest job per target.
 * Queued jobs that have never run and are due in the future count as "scheduled".
 */
export function derivePostStatus(jobs: JobLike[], current: PostStatus = "draft", now: Date = new Date()): PostStatus {
  const list = jobs.map((j) => (typeof j === "string" ? { status: j } : j));
  if (list.length === 0) return current === "scheduled" ? "scheduled" : "draft";
  const active = list.filter((j) => j.status === "queued" || j.status === "uploading");
  if (active.length > 0) {
    const allScheduled = active.every(
      (j) => j.status === "queued" && !j.attempts && j.nextRunAt && Date.parse(j.nextRunAt) > now.getTime(),
    );
    return allScheduled ? "scheduled" : "publishing";
  }
  const published = list.filter((j) => j.status === "published").length;
  if (published === list.length) return "published";
  if (published === 0) return "failed";
  return "partial";
}
