import { beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError, getAdapter, type PlatformAdapter, type PublishRequest } from "@/lib/adapters";
import { openDatabase, type DB } from "@/lib/db";
import {
  claimNextJob,
  createMedia,
  getAccount,
  getJob,
  getPost,
  listJobs,
  retryJob,
  upsertAccount,
} from "@/lib/db/repo";
import { dryRunModeFromEnv, shouldDryRun, type RunnerOptions } from "@/lib/jobs/runner";
import { PublishWorker, type WorkerOptions } from "@/lib/jobs/worker";
import { ComposeError, composePost, getPostSummary, parseComposeInput, type ComposeInput } from "@/lib/services/posts";
import type { PlatformId, PublishJob } from "@/lib/types";

let db: DB;
let mediaId: string;

beforeEach(() => {
  db = openDatabase(":memory:");
  mediaId = createMedia(db, {
    originalFilename: "clip.mp4",
    storagePath: "ab/clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 20_000_000,
    durationSec: 45,
    width: 1080,
    height: 1920,
  }).id;
});

const input = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  title: "Lisbon in 45 seconds",
  caption: "Tiles, trams and pastéis de nata.",
  hashtags: ["travel"],
  mediaId,
  visibility: "public",
  targets: [{ platform: "youtube" }, { platform: "tiktok" }, { platform: "x" }],
  action: "publish",
  ...over,
});

const BASE_OPTS: RunnerOptions = { uploadDir: "/tmp/cp-test", simulatedDelayMs: 0, dryRunMode: "on" };

type PublishFn = PlatformAdapter["publish"];

/** Wrap a real adapter, overriding selected methods. */
function fakeAdapter(platform: PlatformId, over: Partial<Pick<PlatformAdapter, "publish" | "isConfigured" | "refreshAccessToken">>) {
  return Object.assign(Object.create(getAdapter(platform)), over) as PlatformAdapter;
}

function workerWith(adapters: Partial<Record<PlatformId, PlatformAdapter>>, opts: Partial<WorkerOptions> = {}) {
  return new PublishWorker(db, { ...BASE_OPTS, ...opts, getAdapter: (p) => adapters[p] ?? getAdapter(p) });
}

const makeDue = (job: PublishJob) =>
  db.prepare("UPDATE publish_jobs SET next_run_at = ? WHERE id = ?").run(new Date(Date.now() - 1000).toISOString(), job.id);

describe("compose", () => {
  it("creates post, targets and one queued job per platform", () => {
    const res = composePost(db, input());
    expect(res.post.status).toBe("publishing");
    expect(res.targets.map((t) => t.platform)).toEqual(["youtube", "tiktok", "x"]);
    expect(res.jobs).toHaveLength(3);
    expect(res.jobs.every((j) => j.status === "queued")).toBe(true);
  });

  it("saves drafts without jobs or strict validation", () => {
    const res = composePost(db, input({ action: "draft", caption: "x".repeat(400) }));
    expect(res.jobs).toEqual([]);
    expect(res.post.status).toBe("draft");
    expect(res.validation.find((v) => v.platform === "x")!.ok).toBe(false);
  });

  it("rejects publishing when any target has validation errors (422)", () => {
    const err = (() => {
      try {
        composePost(db, input({ caption: "x".repeat(400) }));
      } catch (e) {
        return e as ComposeError;
      }
    })()!;
    expect(err).toBeInstanceOf(ComposeError);
    expect(err.status).toBe(422);
    expect(err.message).toMatch(/X/);
    expect(err.validation!.map((v) => [v.platform, v.ok])).toEqual([
      ["youtube", true],
      ["tiktok", true],
      ["x", false],
    ]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM posts").get()).toEqual({ n: 0 });
  });

  it("per-platform overrides fix validation for one platform only", () => {
    const res = composePost(
      db,
      input({ caption: "x".repeat(400), targets: [{ platform: "youtube" }, { platform: "x", captionOverride: "Short for X" }] }),
    );
    expect(res.jobs).toHaveLength(2);
    const summary = getPostSummary(db, res.post.id)!;
    expect(summary.targets.find((t) => t.platform === "x")!.captionOverride).toBe("Short for X");
  });

  it("schedules: YouTube (native scheduling) is due now, others at scheduledAt", () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const res = composePost(db, input({ scheduledAt: at }));
    const byPlatform = Object.fromEntries(res.jobs.map((j) => [j.platform, j]));
    expect(Date.parse(byPlatform.youtube.nextRunAt!)).toBeLessThanOrEqual(Date.now());
    expect(byPlatform.tiktok.nextRunAt).toBe(at);
    expect(byPlatform.x.nextRunAt).toBe(at);
  });

  it("rejects missing media, unknown platforms and past schedule times", () => {
    expect(() => composePost(db, input({ mediaId: "nope" }))).toThrow(/upload/);
    expect(() => parseComposeInput({ ...input(), targets: [{ platform: "myspace" }] })).toThrow(/Unknown platform/);
    expect(() => parseComposeInput({ ...input(), targets: [] })).toThrow(/at least one/);
    expect(() => composePost(db, input({ scheduledAt: new Date(Date.now() - 3600_000).toISOString() }))).toThrow(/past/);
  });
});

describe("worker (dry-run)", () => {
  it("processes all due jobs end to end with simulated uploads", async () => {
    const { post } = composePost(db, input());
    const processed = await workerWith({}).runDue();
    expect(processed).toHaveLength(3);
    for (const job of listJobs(db, post.id)) {
      expect(job.status).toBe("published");
      expect(job.resultUrl).toBe(`/dry-run/${job.id}`);
      expect(job.progress).toBe(1);
      expect(job.attempts).toBe(1);
      expect(job.resultPayload).toMatchObject({ dryRun: true, visibility: "public" });
    }
    expect(getPost(db, post.id)!.status).toBe("published");
    const x = listJobs(db, post.id).find((j) => j.platform === "x")!;
    expect((x.resultPayload as { caption: string }).caption).toBe("Tiles, trams and pastéis de nata.\n\n#travel");
  });

  it("leaves scheduled jobs alone until they are due", async () => {
    const at = new Date(Date.now() + 3600_000).toISOString();
    const { post } = composePost(db, input({ scheduledAt: at }));
    expect(getPost(db, post.id)!.status).toBe("publishing"); // YouTube job is due now

    const worker = workerWith({});
    expect((await worker.runDue()).map((j) => j.platform)).toEqual(["youtube"]);
    expect(getPost(db, post.id)!.status).toBe("scheduled");
    const yt = listJobs(db, post.id).find((j) => j.platform === "youtube")!;
    expect(yt.resultPayload).toMatchObject({ scheduledAt: at });

    for (const j of listJobs(db, post.id)) if (j.status === "queued") makeDue(j);
    expect((await worker.runDue()).map((j) => j.platform).sort()).toEqual(["tiktok", "x"]);
    expect(getPost(db, post.id)!.status).toBe("published");
  });

  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    const slow: PublishFn = async (req) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { url: "u", externalId: req.jobId, dryRun: true, payload: { title: null, caption: "", tags: [] }, warnings: [] };
    };
    composePost(db, input({ targets: ["youtube", "tiktok", "x", "facebook", "linkedin"].map((p) => ({ platform: p as PlatformId })) }));
    const adapters = Object.fromEntries(
      (["youtube", "tiktok", "x", "facebook", "linkedin"] as PlatformId[]).map((p) => [p, fakeAdapter(p, { publish: slow })]),
    );
    const processed = await workerWith(adapters, { concurrency: 2 }).runDue();
    expect(processed).toHaveLength(5);
    expect(peak).toBe(2);
  });
});

describe("retries", () => {
  it("auto-retries transient errors with backoff, then fails after maxAttempts", async () => {
    const publish = vi.fn<PublishFn>(async () => {
      throw new AdapterError("upstream_error", "503 backend error", true);
    });
    const { post } = composePost(db, input({ targets: [{ platform: "tiktok" }] }));
    const worker = workerWith({ tiktok: fakeAdapter("tiktok", { publish }) });

    let [job] = await worker.runDue();
    expect(job).toMatchObject({ status: "queued", attempts: 1, error: "503 backend error" });
    const delay = Date.parse(job.nextRunAt!) - Date.now();
    expect(delay).toBeGreaterThan(20_000); // 30s first backoff
    expect(await worker.runDue()).toEqual([]); // not due yet

    makeDue(job);
    [job] = await worker.runDue();
    expect(job).toMatchObject({ status: "queued", attempts: 2 });
    expect(Date.parse(job.nextRunAt!) - Date.now()).toBeGreaterThan(50_000); // 60s second backoff

    makeDue(job);
    [job] = await worker.runDue();
    expect(job).toMatchObject({ status: "failed", attempts: 3 });
    expect(getPost(db, post.id)!.status).toBe("failed");
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it("fails immediately on non-retryable errors; manual retry re-runs and succeeds", async () => {
    let fail = true;
    const publish = vi.fn<PublishFn>(async (req) => {
      if (fail) throw new AdapterError("upstream_error", "400 invalid video", false);
      return { url: "https://x.com/me/status/1", externalId: "1", dryRun: false, payload: { title: null, caption: "", tags: [] }, warnings: [] };
    });
    const { post } = composePost(db, input({ targets: [{ platform: "x" }, { platform: "tiktok" }] }));
    const worker = workerWith({ x: fakeAdapter("x", { publish }) });

    await worker.runDue();
    const failed = listJobs(db, post.id).find((j) => j.platform === "x")!;
    expect(failed).toMatchObject({ status: "failed", attempts: 1, error: "400 invalid video" });
    expect(getPost(db, post.id)!.status).toBe("partial");

    fail = false;
    expect(retryJob(db, failed.id).status).toBe("queued");
    const [job] = await worker.runDue();
    expect(job).toMatchObject({ id: failed.id, status: "published", attempts: 2, resultUrl: "https://x.com/me/status/1" });
    expect(getPost(db, post.id)!.status).toBe("published");
  });

  it("persists adapter checkpoints and hands them back on retry", async () => {
    const seen: unknown[] = [];
    const publish = vi.fn<PublishFn>(async (req: PublishRequest, ctx) => {
      seen.push(req.checkpoint ?? null);
      if (!req.checkpoint) {
        ctx.saveCheckpoint?.({ sessionUri: "https://upload/s1", offset: 100 });
        throw new AdapterError("upstream_error", "connection reset", true);
      }
      return { url: "u", externalId: "e", dryRun: false, payload: { title: null, caption: "", tags: [] }, warnings: [] };
    });
    composePost(db, input({ targets: [{ platform: "youtube" }] }));
    const worker = workerWith({ youtube: fakeAdapter("youtube", { publish }) });
    const [first] = await worker.runDue();
    expect(getJob(db, first.id)!.checkpoint).toEqual({ sessionUri: "https://upload/s1", offset: 100 });
    makeDue(first);
    const [second] = await worker.runDue();
    expect(second.status).toBe("published");
    expect(second.checkpoint).toBeNull();
    expect(seen).toEqual([null, { sessionUri: "https://upload/s1", offset: 100 }]);
  });

  it("re-queues jobs orphaned in `uploading` when the worker starts", () => {
    composePost(db, input({ targets: [{ platform: "x" }] }));
    const job = claimNextJob(db)!;
    expect(job.status).toBe("uploading");
    const worker = workerWith({}, { intervalMs: 60_000 });
    // Swallow the immediate kick so we can inspect the requeued state.
    vi.spyOn(worker, "kick").mockReturnValue([]);
    worker.start();
    worker.stop();
    expect(getJob(db, job.id)).toMatchObject({ status: "queued", error: "Interrupted by server restart" });
  });
});

describe("dry-run mode and accounts", () => {
  it("parses DRY_RUN", () => {
    expect(dryRunModeFromEnv({ DRY_RUN: "true" })).toBe("on");
    expect(dryRunModeFromEnv({ DRY_RUN: "0" })).toBe("off");
    expect(dryRunModeFromEnv({})).toBe("auto");
  });

  it("auto mode simulates only platforms without credentials", () => {
    const configured = fakeAdapter("youtube", { isConfigured: () => true });
    const unconfigured = fakeAdapter("youtube", { isConfigured: () => false });
    expect(shouldDryRun(configured, { dryRun: false }, "auto")).toBe(false);
    expect(shouldDryRun(unconfigured, { dryRun: false }, "auto")).toBe(true);
    expect(shouldDryRun(configured, { dryRun: true }, "off")).toBe(true); // per-job flag wins
    expect(shouldDryRun(unconfigured, { dryRun: false }, "off")).toBe(false);
  });

  it("configured platform without a connected account fails clearly (not retried)", async () => {
    composePost(db, input({ targets: [{ platform: "youtube" }] }));
    const yt = fakeAdapter("youtube", { isConfigured: () => true });
    const [job] = await workerWith({ youtube: yt }, { dryRunMode: "auto" }).runDue();
    expect(job).toMatchObject({ status: "failed" });
    expect(job.error).toMatch(/No YouTube account connected/);
  });

  const connect = (expiresInMs: number) =>
    upsertAccount(db, {
      platform: "youtube",
      externalId: "UC1",
      displayName: "Chan",
      accessToken: "old",
      refreshToken: "RT",
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      scopes: [],
      metadata: {},
    });

  it("refreshes an expiring token before publishing and stores it", async () => {
    const account = connect(30_000);
    const tokensUsed: string[] = [];
    const yt = fakeAdapter("youtube", {
      isConfigured: () => true,
      refreshAccessToken: vi.fn(async () => ({ accessToken: "fresh", refreshToken: "RT", expiresAt: new Date(Date.now() + 3600_000).toISOString() })),
      publish: async (req, ctx) => {
        tokensUsed.push(ctx.account!.accessToken);
        return { url: "https://www.youtube.com/watch?v=1", externalId: "1", dryRun: false, payload: { title: "", caption: "", tags: [] }, warnings: [] };
      },
    });
    const { post } = composePost(db, input({ targets: [{ platform: "youtube" }] }));
    expect(getPostSummary(db, post.id)!.targets[0].accountId).toBe(account.id);
    const [job] = await workerWith({ youtube: yt }, { dryRunMode: "off" }).runDue();
    expect(job.status).toBe("published");
    expect(tokensUsed).toEqual(["fresh"]);
    expect(getAccount(db, account.id)!.accessToken).toBe("fresh");
  });

  it("on auth_failed, forces one refresh and retries the publish", async () => {
    connect(3600_000);
    const refresh = vi.fn(async () => ({ accessToken: "fresh", refreshToken: "RT", expiresAt: null }));
    const yt = fakeAdapter("youtube", {
      isConfigured: () => true,
      refreshAccessToken: refresh,
      publish: async (_req, ctx) => {
        if (ctx.account!.accessToken === "old") throw new AdapterError("auth_failed", "401");
        return { url: "u", externalId: "1", dryRun: false, payload: { title: "", caption: "", tags: [] }, warnings: [] };
      },
    });
    composePost(db, input({ targets: [{ platform: "youtube" }] }));
    const [job] = await workerWith({ youtube: yt }, { dryRunMode: "off" }).runDue();
    expect(job.status).toBe("published");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
