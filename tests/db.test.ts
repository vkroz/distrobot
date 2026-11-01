import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "@/lib/db";
import {
  claimNextJob,
  createMedia,
  createPost,
  enqueuePublish,
  getJob,
  getPost,
  listJobs,
  listTargets,
  markJobFailed,
  markJobPublished,
  retryJob,
  upsertAccount,
  upsertTarget,
} from "@/lib/db/repo";
import { canTransition, derivePostStatus } from "@/lib/jobs/state";

let db: DB;
beforeEach(() => {
  db = openDatabase(":memory:");
});

const future = () => new Date(Date.now() + 24 * 3600_000);

describe("schema & repo", () => {
  it("creates posts with media and per-platform overrides", () => {
    const media = createMedia(db, {
      originalFilename: "clip.mp4",
      storagePath: "ab/clip.mp4",
      mimeType: "video/mp4",
      sizeBytes: 1000,
      durationSec: 12.5,
      width: 1080,
      height: 1920,
    });
    const post = createPost(db, { title: "Hello", caption: "World", hashtags: ["a"], mediaId: media.id });
    expect(post.status).toBe("draft");
    expect(post.hashtags).toEqual(["a"]);

    upsertTarget(db, post.id, "x", { captionOverride: "Short version" });
    const t = upsertTarget(db, post.id, "x", { hashtagsOverride: ["b"] });
    expect(t.captionOverride).toBe("Short version"); // preserved across partial update
    expect(t.hashtagsOverride).toEqual(["b"]);
    expect(listTargets(db, post.id)).toHaveLength(1);
  });

  it("upserts accounts by (platform, externalId) and keeps refresh token when absent", () => {
    const base = {
      platform: "youtube" as const,
      externalId: "UC123",
      displayName: "Chan",
      accessToken: "a1",
      refreshToken: "r1",
      expiresAt: null,
      scopes: ["s"],
      metadata: {},
    };
    const a = upsertAccount(db, base);
    const b = upsertAccount(db, { ...base, accessToken: "a2", refreshToken: null });
    expect(b.id).toBe(a.id);
    expect(b.accessToken).toBe("a2");
    expect(b.refreshToken).toBe("r1");
  });

  it("is idempotent when migrating twice", async () => {
    const { migrate } = await import("@/lib/db");
    expect(() => migrate(db)).not.toThrow();
  });
});

describe("publish jobs", () => {
  function setup() {
    const post = createPost(db, { title: "T", caption: "C" });
    upsertTarget(db, post.id, "youtube");
    upsertTarget(db, post.id, "x");
    upsertTarget(db, post.id, "tiktok", { enabled: false });
    return post;
  }

  it("enqueues one job per enabled target and marks post publishing", () => {
    const post = setup();
    const jobs = enqueuePublish(db, post.id, { dryRun: true });
    expect(jobs.map((j) => j.platform).sort()).toEqual(["x", "youtube"]);
    expect(jobs.every((j) => j.status === "queued" && j.dryRun && j.attempts === 0)).toBe(true);
    expect(getPost(db, post.id)!.status).toBe("publishing");
    // Re-enqueue doesn't duplicate active jobs.
    expect(enqueuePublish(db, post.id)).toHaveLength(0);
  });

  it("walks queued → uploading → published and derives post status", () => {
    const post = setup();
    enqueuePublish(db, post.id);
    const j1 = claimNextJob(db)!;
    expect(j1.status).toBe("uploading");
    expect(j1.attempts).toBe(1);
    markJobPublished(db, j1.id, { url: "https://example.com/1", externalId: "1" });
    expect(getPost(db, post.id)!.status).toBe("publishing");

    const j2 = claimNextJob(db)!;
    markJobPublished(db, j2.id, { url: "https://example.com/2" });
    expect(getPost(db, post.id)!.status).toBe("published");
    expect(getJob(db, j2.id)!.resultUrl).toBe("https://example.com/2");
    expect(claimNextJob(db)).toBeNull();
  });

  it("retries with backoff, then fails after max attempts", () => {
    const post = createPost(db);
    upsertTarget(db, post.id, "x");
    enqueuePublish(db, post.id, { maxAttempts: 2 });

    let job = claimNextJob(db)!;
    job = markJobFailed(db, job.id, "timeout");
    expect(job.status).toBe("queued");
    expect(job.error).toBe("timeout");
    expect(new Date(job.nextRunAt!).getTime()).toBeGreaterThan(Date.now());
    expect(claimNextJob(db)).toBeNull(); // not due yet

    job = claimNextJob(db, future())!;
    expect(job.attempts).toBe(2);
    job = markJobFailed(db, job.id, "timeout again");
    expect(job.status).toBe("failed");
    expect(getPost(db, post.id)!.status).toBe("failed");

    job = retryJob(db, job.id);
    expect(job.status).toBe("queued");
    expect(job.maxAttempts).toBe(3);
  });

  it("fails immediately on non-retryable errors and yields partial post status", () => {
    const post = setup();
    enqueuePublish(db, post.id);
    const a = claimNextJob(db)!;
    markJobFailed(db, a.id, "validation", { retryable: false });
    const b = claimNextJob(db)!;
    markJobPublished(db, b.id, { url: "u" });
    expect(getJob(db, a.id)!.status).toBe("failed");
    expect(getPost(db, post.id)!.status).toBe("partial");
    // Only the failed target is re-enqueued.
    const again = enqueuePublish(db, post.id);
    expect(again.map((j) => j.targetId)).toEqual([a.targetId]);
    expect(listJobs(db, post.id)).toHaveLength(3);
    expect(getPost(db, post.id)!.status).toBe("publishing");
  });

  it("rejects invalid transitions", () => {
    const post = setup();
    const [job] = enqueuePublish(db, post.id);
    expect(() => markJobPublished(db, job.id, { url: null })).toThrow(/queued → published/);
  });

  it("enforces status values at the DB level", () => {
    const post = setup();
    const [job] = enqueuePublish(db, post.id);
    expect(() => db.prepare("UPDATE publish_jobs SET status = 'bogus' WHERE id = ?").run(job.id)).toThrow();
  });
});

describe("state helpers", () => {
  it("transition table", () => {
    expect(canTransition("queued", "uploading")).toBe(true);
    expect(canTransition("published", "queued")).toBe(false);
    expect(canTransition("failed", "queued")).toBe(true);
  });

  it("derivePostStatus", () => {
    expect(derivePostStatus([])).toBe("draft");
    expect(derivePostStatus(["published", "uploading"])).toBe("publishing");
    expect(derivePostStatus(["published", "published"])).toBe("published");
    expect(derivePostStatus(["failed", "published"])).toBe("partial");
    expect(derivePostStatus(["failed"])).toBe("failed");
  });
});
