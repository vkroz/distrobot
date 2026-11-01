import { randomUUID } from "node:crypto";
import os from "node:os";
import { getDb, type DB } from "@/lib/db";
import { getAdapter as defaultGetAdapter } from "@/lib/adapters";
import { claimNextJob, deleteOrphanMedia, requeueOrphanedJobs } from "@/lib/db/repo";
import { deleteStoredFile } from "@/lib/storage/local";
import type { PublishJob } from "@/lib/types";
import { acquireLease, isDeadLocalOwner, readLease, releaseLease, renewLease, type LeaseRow } from "./lease";
import { dryRunModeFromEnv, executeJob, shouldDryRun, type RunnerOptions } from "./runner";

export interface WorkerOptions extends RunnerOptions {
  concurrency?: number;
  intervalMs?: number;
  /** A lease whose heartbeat is older than this is considered abandoned. Default: max(60s, 6 × interval). */
  leaseStaleMs?: number;
  /** Lease owner id (defaults to host:pid:random). */
  owner?: string;
  /** Uploads not referenced by any post are deleted after this long (default 24 h; 0 disables). */
  orphanMediaMaxAgeMs?: number;
}

const HOUR = 60 * 60_000;

const envInt = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/**
 * In-process publish worker. Polls for due jobs on an interval and runs up to `concurrency` at once.
 *
 * Restart safety: `start()` takes a SQLite lease (see lease.ts). Only the lease holder claims jobs
 * and recovers jobs orphaned in `uploading` by a crashed process. A second process on the same DB
 * stays in standby and takes over if the holder's heartbeat goes stale. Still: run one app instance.
 */
export class PublishWorker {
  private inFlight = new Map<string, Promise<PublishJob>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** True once start() was called: from then on jobs are only claimed while holding the lease. */
  private leaseMode = false;
  private holdsLease = false;
  readonly concurrency: number;
  readonly intervalMs: number;
  readonly owner: string;
  readonly leaseStaleMs: number;
  /** Jobs recovered from a previous process on the last lease acquisition. */
  lastRecovered: PublishJob[] = [];

  constructor(
    private readonly db: DB,
    private readonly opts: WorkerOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 2);
    this.intervalMs = opts.intervalMs ?? 5000;
    this.owner = opts.owner ?? `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
    this.leaseStaleMs = opts.leaseStaleMs ?? Math.max(60_000, this.intervalMs * 6);
  }

  get running(): boolean {
    return this.timer !== null;
  }

  get activeJobIds(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Whether this process may claim jobs (always true for workers that were never started, e.g. tests). */
  get active(): boolean {
    return !this.leaseMode || this.holdsLease;
  }

  status(): { running: boolean; holdsLease: boolean; owner: string; lease: LeaseRow | null; active: string[] } {
    return { running: this.running, holdsLease: this.holdsLease, owner: this.owner, lease: readLease(this.db), active: this.activeJobIds };
  }

  start(): void {
    if (this.timer) return;
    this.leaseMode = true;
    this.heartbeat();
    this.timer = setInterval(() => {
      this.heartbeat();
      this.kick();
    }, this.intervalMs);
    this.timer.unref?.();
    this.kick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.holdsLease) releaseLease(this.db, this.owner);
    this.holdsLease = false;
  }

  /**
   * A job interrupted mid-upload is only retried automatically if that can't post twice: it was a
   * dry-run, or the adapter saved a resume checkpoint (it re-checks the upload session on retry).
   */
  private canAutoRetry = (job: PublishJob): boolean => {
    if (job.checkpoint != null) return true;
    const adapter = (this.opts.getAdapter ?? defaultGetAdapter)(job.platform);
    return shouldDryRun(adapter, job, this.opts.dryRunMode ?? dryRunModeFromEnv());
  };

  private lastGc = 0;

  /** Periodically delete uploads nobody references (replaced/abandoned videos fill the disk otherwise). */
  gcOrphanMedia(now = Date.now()): string[] {
    const maxAge = this.opts.orphanMediaMaxAgeMs ?? 24 * HOUR;
    if (!maxAge) return [];
    this.lastGc = now;
    const paths = deleteOrphanMedia(this.db, maxAge, now);
    for (const p of paths) void deleteStoredFile(p, this.opts.uploadDir).catch(() => undefined);
    return paths;
  }

  /** Renew our lease, or try to acquire it; on (re)acquisition recover orphaned jobs. */
  private heartbeat(): void {
    if (this.holdsLease && renewLease(this.db, this.owner)) {
      if (Date.now() - this.lastGc > HOUR) this.gcOrphanMedia();
      return;
    }
    const wasHolding = this.holdsLease;
    this.holdsLease = acquireLease(this.db, this.owner, this.leaseStaleMs, new Date(), (o) =>
      isDeadLocalOwner(o, os.hostname(), this.owner),
    );
    if (this.holdsLease && !wasHolding) {
      // Anything still `uploading` belongs to a process that no longer holds the lease (crashed/restarted).
      this.lastRecovered = requeueOrphanedJobs(this.db, this.inFlight.keys(), this.canAutoRetry);
      if (this.lastRecovered.length) {
        console.warn(`[worker] recovered ${this.lastRecovered.length} job(s) interrupted by a previous process`);
      }
    } else if (!this.holdsLease && !wasHolding && this.lastStandbyLog < Date.now() - 60_000) {
      this.lastStandbyLog = Date.now();
      console.warn(`[worker] standby: another process holds the worker lease (${readLease(this.db)?.owner})`);
    }
  }
  private lastStandbyLog = 0;

  /** Claim due jobs up to the concurrency limit and start them. Returns the started promises. */
  kick(): Promise<PublishJob>[] {
    if (!this.active) return [];
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

  /**
   * Manual tick (POST /api/jobs/run). If the background worker isn't running in this process
   * (WORKER_DISABLED), take the lease just for this run so we never race another process.
   * Returns null when another process holds the lease.
   */
  async runDueExclusive(): Promise<PublishJob[] | null> {
    if (this.leaseMode) return this.active ? this.runDue() : null;
    const got = acquireLease(this.db, this.owner, this.leaseStaleMs, new Date(), (o) => isDeadLocalOwner(o, os.hostname(), this.owner));
    if (!got) return null;
    try {
      return await this.runDue();
    } finally {
      releaseLease(this.db, this.owner);
    }
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
  if (!disabled && !worker.running) {
    worker.start();
    // Release the lease on shutdown so a restarted server can take over immediately.
    // Next.js installs its own graceful-shutdown handlers; only exit ourselves if nobody else will.
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      process.once(sig, () => {
        worker.stop();
        if (process.listenerCount(sig) === 0) process.exit(sig === "SIGTERM" ? 143 : 130);
      });
    }
  }
  return worker;
}
