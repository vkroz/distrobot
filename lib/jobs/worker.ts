import { getDb, type DB } from "@/lib/db";
import { claimNextJob, requeueOrphanedJobs } from "@/lib/db/repo";
import type { PublishJob } from "@/lib/types";
import { executeJob, type RunnerOptions } from "./runner";

export interface WorkerOptions extends RunnerOptions {
  concurrency?: number;
  intervalMs?: number;
}

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * In-process publish worker. Polls for due jobs on an interval and runs up to
 * `concurrency` at once. Safe within a single Node process only (SQLite claims are atomic,
 * but there is no cross-process lease) — run one app instance.
 */
export class PublishWorker {
  private inFlight = new Map<string, Promise<PublishJob>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  readonly concurrency: number;
  readonly intervalMs: number;

  constructor(
    private readonly db: DB,
    private readonly opts: WorkerOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.intervalMs = opts.intervalMs ?? 5000;
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get activeJobIds(): string[] {
    return [...this.inFlight.keys()];
  }

  start(): void {
    if (this.timer) return;
    requeueOrphanedJobs(this.db);
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref?.();
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Claim due jobs up to the concurrency limit and start them. Returns the started promises. */
  kick(): Promise<PublishJob>[] {
    const started: Promise<PublishJob>[] = [];
    while (this.inFlight.size < this.concurrency) {
      const job = claimNextJob(this.db);
      if (!job) break;
      const p = executeJob(this.db, job, this.opts).finally(() => this.inFlight.delete(job.id));
      this.inFlight.set(job.id, p);
      started.push(p);
    }
    return started;
  }

  /** Process every due job (including ones that become due via immediate retries) and wait for them. */
  async runDue(maxRounds = 100): Promise<PublishJob[]> {
    const results: PublishJob[] = [];
    for (let round = 0; round < maxRounds; round++) {
      const started = this.kick();
      if (started.length > 0) {
        results.push(...(await Promise.all(started)));
      } else if (this.inFlight.size > 0) {
        // Slots are busy with interval-started jobs; wait for one to free up.
        await Promise.race(this.inFlight.values());
      } else {
        break;
      }
    }
    return results;
  }

  /** Wait for currently running jobs (tests / graceful shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size > 0) await Promise.allSettled([...this.inFlight.values()]);
  }
}

const g = globalThis as unknown as { __publishWorker?: PublishWorker };

/** Process-wide worker singleton (survives dev hot reloads). Does not start polling. */
export function getWorker(): PublishWorker {
  if (!g.__publishWorker) {
    g.__publishWorker = new PublishWorker(getDb(), {
      concurrency: envInt("WORKER_CONCURRENCY", 2),
      intervalMs: envInt("WORKER_INTERVAL_MS", 5000),
      simulatedDelayMs: envInt("DRY_RUN_DELAY_MS", 1500),
    });
  }
  return g.__publishWorker;
}

/** Lazily start background polling (no-op during `next build` or when WORKER_DISABLED=true). */
export function ensureWorker(): PublishWorker {
  const worker = getWorker();
  const disabled = process.env.WORKER_DISABLED === "true" || process.env.NEXT_PHASE === "phase-production-build";
  if (!disabled) worker.start();
  return worker;
}
