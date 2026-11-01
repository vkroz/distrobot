import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DB } from "@/lib/db";
import { claimNextJob, createMedia, getJob } from "@/lib/db/repo";
import os from "node:os";
import { acquireLease, isDeadLocalOwner, readLease, releaseLease, renewLease } from "@/lib/jobs/lease";
import { PublishWorker } from "@/lib/jobs/worker";
import { composePost } from "@/lib/services/posts";

let db: DB;
beforeEach(() => {
  db = openDatabase(":memory:");
});

function queueXJob(maxAttempts?: number) {
  const mediaId = createMedia(db, {
    originalFilename: "a.mp4",
    storagePath: "a.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1_000_000,
    durationSec: 20,
    width: 1080,
    height: 1920,
  }).id;
  const { jobs } = composePost(db, {
    title: "t",
    caption: "c",
    hashtags: [],
    mediaId,
    visibility: "public",
    targets: [{ platform: "x" }],
    action: "publish",
  });
  if (maxAttempts) db.prepare("UPDATE publish_jobs SET max_attempts = ? WHERE id = ?").run(maxAttempts, jobs[0].id);
  return jobs[0];
}

const OPTS = { uploadDir: "/tmp/cp", simulatedDelayMs: 0, dryRunMode: "on" as const, intervalMs: 60_000 };

describe("worker lease", () => {
  it("is exclusive while fresh, renewable by the owner, and taken over when stale", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    expect(acquireLease(db, "A", 60_000, t0)).toBe(true);
    expect(acquireLease(db, "B", 60_000, new Date(t0.getTime() + 30_000))).toBe(false);
    expect(renewLease(db, "A", new Date(t0.getTime() + 50_000))).toBe(true);
    // Renewed at +50s, so at +100s A's heartbeat is only 50s old: still fresh.
    expect(acquireLease(db, "B", 60_000, new Date(t0.getTime() + 100_000))).toBe(false);
    expect(acquireLease(db, "A", 60_000, new Date(t0.getTime() + 100_000))).toBe(true); // owner re-acquire = renew
  });

  it("stale takeover and release", () => {
    const t0 = new Date("2026-01-01T00:00:00Z");
    acquireLease(db, "A", 60_000, t0);
    expect(acquireLease(db, "B", 60_000, new Date(t0.getTime() + 59_000))).toBe(false);
    expect(acquireLease(db, "B", 60_000, new Date(t0.getTime() + 61_000))).toBe(true);
    expect(readLease(db)!.owner).toBe("B");
    expect(renewLease(db, "A")).toBe(false); // A lost it
    releaseLease(db, "A"); // no-op for non-owner
    expect(readLease(db)!.owner).toBe("B");
    releaseLease(db, "B");
    expect(readLease(db)).toBeNull();
  });
});

describe("restart recovery", () => {
  it("on start, re-queues jobs a crashed process left `uploading`, with a clear message", async () => {
    const job = queueXJob();
    claimNextJob(db); // a previous process claimed it, then died
    const worker = new PublishWorker(db, { ...OPTS, owner: "new" });
    vi.spyOn(worker, "kick").mockReturnValueOnce([]); // inspect state before it runs again
    worker.start();
    expect(worker.lastRecovered.map((j) => j.id)).toEqual([job.id]);
    expect(getJob(db, job.id)).toMatchObject({
      status: "queued",
      error: expect.stringMatching(/Interrupted by a server restart during upload \(attempt 1\/3\); re-queued/),
    });
    // ...and then it publishes on the next tick.
    vi.mocked(worker.kick).mockRestore();
    await worker.runDue();
    expect(getJob(db, job.id)!.status).toBe("published");
    worker.stop();
  });

  it("fails (instead of looping) when the interrupted job has no attempts left", () => {
    const job = queueXJob(1);
    claimNextJob(db);
    const worker = new PublishWorker(db, { ...OPTS, owner: "new" });
    vi.spyOn(worker, "kick").mockReturnValue([]);
    worker.start();
    worker.stop();
    expect(getJob(db, job.id)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/no attempts are left \(1\/1\).*retry manually/),
    });
  });

  it("a second process stays in standby: it neither steals in-flight jobs nor claims new ones", async () => {
    const first = new PublishWorker(db, { ...OPTS, owner: "first" });
    vi.spyOn(first, "kick").mockReturnValue([]);
    first.start(); // holds the lease

    const job = queueXJob();
    claimNextJob(db); // "first" is uploading it

    const second = new PublishWorker(db, { ...OPTS, owner: "second" });
    second.start();
    expect(second.active).toBe(false);
    expect(second.status().holdsLease).toBe(false);
    expect(getJob(db, job.id)!.status).toBe("uploading"); // untouched
    queueXJob();
    expect(await second.runDue()).toEqual([]); // standby: claims nothing

    first.stop(); // graceful shutdown releases the lease
    second.stop();
    const third = new PublishWorker(db, { ...OPTS, owner: "third" });
    vi.spyOn(third, "kick").mockReturnValue([]);
    third.start();
    expect(third.active).toBe(true);
    expect(third.lastRecovered.map((j) => j.id)).toEqual([job.id]);
    third.stop();
  });
});

describe("crash takeover", () => {
  it("detects a dead owner process on this host (and only then)", () => {
    const host = os.hostname();
    expect(isDeadLocalOwner(`${host}:${process.pid}:x`, host)).toBe(false); // ourselves
    expect(isDeadLocalOwner(`${host}:${process.ppid}:x`, host)).toBe(false); // alive
    expect(isDeadLocalOwner(`${host}:2147483646:x`, host)).toBe(true); // no such pid
    expect(isDeadLocalOwner(`other-host:2147483646:x`, host)).toBe(false); // can't tell remotely
    expect(isDeadLocalOwner("garbage", host)).toBe(false);
  });

  it("a fresh lease held by a dead local process is taken over immediately", () => {
    const dead = `${os.hostname()}:2147483646:dead`;
    acquireLease(db, dead, 60_000);
    expect(acquireLease(db, "new", 60_000)).toBe(false); // default: wait for staleness
    expect(acquireLease(db, "new", 60_000, new Date(), (o) => isDeadLocalOwner(o, os.hostname()))).toBe(true);
    expect(readLease(db)!.owner).toBe("new");
  });
});
