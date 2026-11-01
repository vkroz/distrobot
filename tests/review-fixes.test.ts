import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError, getAdapter, type PlatformAdapter } from "@/lib/adapters";
import { getAuthConfig, sessionFromRequest, SESSION_COOKIE, signSession, verifySession } from "@/lib/auth";
import { revokeAllSessions, sessionsValidAfter } from "@/lib/auth-store";
import { openDatabase, type DB } from "@/lib/db";
import { claimNextJob, createMedia, deleteOrphanMedia, getJob, getMedia, upsertAccount } from "@/lib/db/repo";
import { parseRange } from "@/lib/http";
import { acquireLease } from "@/lib/jobs/lease";
import { withFreshAccount } from "@/lib/jobs/runner";
import { PublishWorker } from "@/lib/jobs/worker";
import { composePost } from "@/lib/services/posts";

let db: DB;
let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "review-"));
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => vi.unstubAllEnvs());

const video = (over: Partial<Parameters<typeof createMedia>[1]> = {}) =>
  createMedia(db, {
    originalFilename: "a.mp4",
    storagePath: "a.mp4",
    mimeType: "video/mp4",
    sizeBytes: 1_000_000,
    durationSec: 20,
    width: 1080,
    height: 1920,
    ...over,
  });

const queueJob = (platform: "x" | "youtube" = "x") =>
  composePost(db, {
    title: "t",
    caption: "c",
    hashtags: [],
    mediaId: video().id,
    visibility: "public",
    targets: [{ platform }],
    action: "publish",
  }).jobs[0];

describe("logout revokes existing sessions", () => {
  it("sessions issued before the revocation time are rejected; new logins work", () => {
    vi.stubEnv("NODE_ENV", "development");
    const cfg = getAuthConfig();
    const t0 = Date.now();
    const old = signSession(cfg, t0 - 1000);
    expect(sessionsValidAfter(db)).toBe(0);
    revokeAllSessions(db, t0);
    const after = sessionsValidAfter(db);
    expect(verifySession(cfg, old, t0, after)).toBeNull();
    expect(verifySession(cfg, signSession(cfg, t0 + 1), t0 + 2, after)).toMatchObject({ u: "admin" });
    // Tokens from before this change (no ms `t`) fall back to iat.
    expect(verifySession(cfg, old, t0)).not.toBeNull();
  });

  it("a malformed cookie is simply 'not logged in' (was a 500)", () => {
    vi.stubEnv("NODE_ENV", "development");
    const req = new Request("http://x/", { headers: { cookie: `${SESSION_COOKIE}=%E0%A4%A` } });
    expect(sessionFromRequest(req)).toBeNull();
  });
});

describe("token refresh for compose-time API calls (TikTok creator info)", () => {
  const connect = (expiresInMs: number) =>
    upsertAccount(db, {
      platform: "tiktok",
      externalId: "u1",
      displayName: "Maker",
      accessToken: "old",
      refreshToken: "RT",
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      scopes: [],
      metadata: {},
    });
  const adapterWith = (refresh: PlatformAdapter["refreshAccessToken"]) =>
    Object.assign(Object.create(getAdapter("tiktok")), { refreshAccessToken: refresh }) as PlatformAdapter;

  it("refreshes an expiring token first", async () => {
    const account = connect(10_000);
    const refresh = vi.fn(async () => ({ accessToken: "fresh", refreshToken: "RT", expiresAt: new Date(Date.now() + 86_400_000).toISOString() }));
    const used: string[] = [];
    await withFreshAccount(db, adapterWith(refresh), account, async (a) => used.push(a.accessToken));
    expect(used).toEqual(["fresh"]);
  });

  it("refreshes once and retries on auth_failed (expired early / revoked)", async () => {
    const account = connect(3_600_000);
    const refresh = vi.fn(async () => ({ accessToken: "fresh", refreshToken: "RT", expiresAt: null }));
    const call = vi.fn(async (a: { accessToken: string }) => {
      if (a.accessToken === "old") throw new AdapterError("auth_failed", "401");
      return "creator";
    });
    expect(await withFreshAccount(db, adapterWith(refresh), account, call)).toBe("creator");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
  });
});

describe("crash recovery never risks a double post", () => {
  const OPTS = { uploadDir: "/tmp/cp", simulatedDelayMs: 0, intervalMs: 60_000 };

  it("real uploads without a resume checkpoint fail with a 'check the platform' message", () => {
    const job = queueJob("x");
    claimNextJob(db);
    const yt = Object.assign(Object.create(getAdapter("x")), { isConfigured: () => true }) as PlatformAdapter;
    const worker = new PublishWorker(db, { ...OPTS, dryRunMode: "auto", getAdapter: () => yt, owner: "w" });
    vi.spyOn(worker, "kick").mockReturnValue([]);
    worker.start();
    worker.stop();
    expect(getJob(db, job.id)).toMatchObject({ status: "failed", error: expect.stringMatching(/may already have been posted/) });
  });

  it("real uploads with a checkpoint (resumable) are re-queued", () => {
    const job = queueJob("youtube");
    claimNextJob(db);
    db.prepare("UPDATE publish_jobs SET checkpoint = ? WHERE id = ?").run(JSON.stringify({ sessionUri: "s" }), job.id);
    const worker = new PublishWorker(db, { ...OPTS, dryRunMode: "off", owner: "w" });
    vi.spyOn(worker, "kick").mockReturnValue([]);
    worker.start();
    worker.stop();
    expect(getJob(db, job.id)).toMatchObject({ status: "queued", error: expect.stringMatching(/re-queued/) });
  });
});

describe("manual run respects the lease even when the background worker is disabled", () => {
  it("returns null while another process holds the lease, runs and releases otherwise", async () => {
    const job = queueJob("x");
    const worker = new PublishWorker(db, { uploadDir: "/tmp/cp", simulatedDelayMs: 0, dryRunMode: "on", owner: "manual" });
    acquireLease(db, "someone-else:1:x", 60_000);
    expect(await worker.runDueExclusive()).toBeNull();
    expect(getJob(db, job.id)!.status).toBe("queued");
    db.prepare("DELETE FROM worker_lease").run();
    expect((await worker.runDueExclusive())!.map((j) => j.status)).toEqual(["published"]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM worker_lease").get()).toEqual({ n: 0 }); // released
  });
});

describe("orphaned uploads are garbage-collected", () => {
  it("deletes old unreferenced media (rows + files), keeps referenced and recent ones", async () => {
    const day = 86_400_000;
    await fs.writeFile(path.join(dir, "old.mp4"), "x");
    const old = video({ storagePath: "old.mp4" });
    const used = video({ storagePath: "used.mp4" });
    composePost(db, { title: "t", caption: "", hashtags: [], mediaId: used.id, visibility: "public", targets: [], action: "draft" });
    const fresh = video({ storagePath: "fresh.mp4" });
    db.prepare("UPDATE media SET created_at = ? WHERE id IN (?, ?)").run(new Date(Date.now() - 2 * day).toISOString(), old.id, used.id);

    expect(deleteOrphanMedia(db, day, Date.now() + 1)).toEqual(["old.mp4"]);
    expect(getMedia(db, old.id)).toBeNull();
    expect(getMedia(db, used.id)).not.toBeNull();
    expect(getMedia(db, fresh.id)).not.toBeNull();

    const old2 = video({ storagePath: "old.mp4" });
    db.prepare("UPDATE media SET created_at = ? WHERE id = ?").run(new Date(Date.now() - 2 * day).toISOString(), old2.id);
    const worker = new PublishWorker(db, { uploadDir: dir });
    expect(worker.gcOrphanMedia()).toEqual(["old.mp4"]);
    await new Promise((r) => setTimeout(r, 50));
    await expect(fs.access(path.join(dir, "old.mp4"))).rejects.toThrow();
  });
});

describe("Range requests for video previews", () => {
  it("parses single ranges and rejects unsatisfiable ones", () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange("bytes=0-9", 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange("bytes=50-1000", 100)).toEqual({ start: 50, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("invalid");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull(); // multi-range → full body
  });

  it("serves 206 partial content with Content-Range", async () => {
    vi.stubEnv("DATABASE_PATH", path.join(dir, "range.db"));
    vi.stubEnv("UPLOAD_DIR", dir);
    const { getDb } = await import("@/lib/db");
    const { GET } = await import("@/app/api/media/[id]/route");
    await fs.writeFile(path.join(dir, "r.mp4"), "0123456789");
    const m = createMedia(getDb(), { kind: "video", originalFilename: "r.mp4", storagePath: "r.mp4", mimeType: "video/mp4" });
    const res = await GET(new Request("http://x/", { headers: { range: "bytes=2-5" } }), { params: Promise.resolve({ id: m.id }) });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await res.text()).toBe("2345");
    const bad = await GET(new Request("http://x/", { headers: { range: "bytes=50-" } }), { params: Promise.resolve({ id: m.id }) });
    expect(bad.status).toBe(416);
  });
});
