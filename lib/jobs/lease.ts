import type { DB } from "@/lib/db";
import { transaction } from "@/lib/db";

/**
 * Single-row lease in SQLite so only one process runs the publish worker against a database.
 * The holder renews `heartbeat_at` on every poll; a lease whose heartbeat is older than `staleMs`
 * is considered abandoned (crashed/killed process) and can be taken over.
 *
 * This guards against two processes on the same machine/DB file (e.g. `next dev` next to `next start`).
 * It is not a distributed lock — run a single app instance.
 */

export interface LeaseRow {
  owner: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export function readLease(db: DB): LeaseRow | null {
  const r = db.prepare("SELECT owner, acquired_at, heartbeat_at FROM worker_lease WHERE id = 1").get() as
    | { owner: string; acquired_at: string; heartbeat_at: string }
    | undefined;
  return r ? { owner: r.owner, acquiredAt: r.acquired_at, heartbeatAt: r.heartbeat_at } : null;
}

/**
 * Owner ids look like `host:pid:random`. If the holder ran on this host and its pid is gone, it
 * crashed (e.g. kill -9) and its lease can be taken immediately instead of waiting for staleness.
 */
export function isDeadLocalOwner(owner: string, hostname: string, self?: string): boolean {
  const [host, pidStr] = owner.split(":");
  const pid = Number(pidStr);
  if (host !== hostname || !Number.isInteger(pid) || pid <= 0) return false;
  // Same host + same pid but a different owner id = a previous run of this process (containers
  // often reuse pids across restarts), so that holder is certainly gone.
  if (pid === process.pid) return self !== undefined && owner !== self;
  try {
    process.kill(pid, 0); // signal 0 = existence check
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** Take (or keep) the lease. Returns false if another live owner holds a fresh lease. */
export function acquireLease(
  db: DB,
  owner: string,
  staleMs: number,
  now = new Date(),
  isAbandoned: (owner: string) => boolean = () => false,
): boolean {
  return transaction(db, () => {
    const current = readLease(db);
    const ts = now.toISOString();
    const fresh = current && now.getTime() - Date.parse(current.heartbeatAt) < staleMs;
    if (current && current.owner !== owner && fresh && !isAbandoned(current.owner)) return false;
    if (current?.owner === owner) {
      db.prepare("UPDATE worker_lease SET heartbeat_at = ? WHERE id = 1").run(ts);
    } else {
      db.prepare(
        `INSERT INTO worker_lease (id, owner, acquired_at, heartbeat_at) VALUES (1, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET owner = excluded.owner, acquired_at = excluded.acquired_at, heartbeat_at = excluded.heartbeat_at`,
      ).run(owner, ts, ts);
    }
    return true;
  });
}

/** Renew our heartbeat. Returns false if we no longer own the lease. */
export function renewLease(db: DB, owner: string, now = new Date()): boolean {
  const res = db.prepare("UPDATE worker_lease SET heartbeat_at = ? WHERE id = 1 AND owner = ?").run(now.toISOString(), owner);
  return Number(res.changes) > 0;
}

export function releaseLease(db: DB, owner: string): void {
  db.prepare("DELETE FROM worker_lease WHERE id = 1 AND owner = ?").run(owner);
}
