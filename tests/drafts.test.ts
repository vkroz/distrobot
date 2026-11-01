import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type DB } from "@/lib/db";
import { createMedia, getMedia, getPost, listJobs, listTargets } from "@/lib/db/repo";
import { PublishWorker } from "@/lib/jobs/worker";
import {
  ComposeError,
  composePost,
  deletePostAndOrphans,
  parseComposeInput,
  publishDraft,
  updateDraft,
  type ComposeInput,
} from "@/lib/services/posts";

let db: DB;
let mediaId: string;
beforeEach(() => {
  db = openDatabase(":memory:");
  mediaId = createMedia(db, {
    originalFilename: "a.mp4",
    storagePath: "ab/a.mp4",
    mimeType: "video/mp4",
    sizeBytes: 5_000_000,
    durationSec: 30,
    width: 1080,
    height: 1920,
  }).id;
});

const TIKTOK_OK = { privacyLevel: "PUBLIC_TO_EVERYONE" };
const draft = (over: Partial<ComposeInput> = {}): ComposeInput => ({
  title: "Draft title",
  caption: "Draft caption",
  hashtags: ["draft"],
  mediaId,
  visibility: "public",
  targets: [{ platform: "youtube" }, { platform: "tiktok", settings: TIKTOK_OK }],
  action: "draft",
  ...over,
});
const runAll = () => new PublishWorker(db, { uploadDir: "/tmp/cp", simulatedDelayMs: 0, dryRunMode: "on" }).runDue();
const expectComposeError = (fn: () => unknown, status: number, msg?: RegExp) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ComposeError);
    expect((e as ComposeError).status).toBe(status);
    if (msg) expect((e as Error).message).toMatch(msg);
    return e as ComposeError;
  }
  throw new Error("expected ComposeError");
};

describe("drafts", () => {
  it("can be saved before a video is uploaded and without platforms", () => {
    const parsed = parseComposeInput({ title: "Idea", action: "draft" });
    expect(parsed).toMatchObject({ mediaId: null, targets: [], action: "draft" });
    const { post, jobs } = composePost(db, parsed);
    expect(post).toMatchObject({ status: "draft", mediaId: null, title: "Idea" });
    expect(jobs).toEqual([]);
    // ...but publishing still needs a video and a platform.
    expect(() => parseComposeInput({ title: "Idea", action: "publish" })).toThrow(/mediaId/);
  });

  it("drafts skip strict validation (invalid TikTok settings are reported but saved)", () => {
    const { post, validation } = composePost(db, draft({ targets: [{ platform: "tiktok" }] }));
    expect(post.status).toBe("draft");
    expect(validation[0].errors.map((e) => e.code)).toContain("tiktok_privacy_required");
  });

  it("edit: updates fields, overrides and settings, and drops deselected platforms", () => {
    const { post } = composePost(db, draft());
    const { post: updated, targets } = updateDraft(
      db,
      post.id,
      draft({
        title: "Edited",
        targets: [{ platform: "tiktok", captionOverride: "TikTok only", settings: { ...TIKTOK_OK, allowComment: true } }],
      }),
    );
    expect(updated).toMatchObject({ id: post.id, title: "Edited", status: "draft" });
    expect(targets).toHaveLength(1);
    expect(listTargets(db, post.id).map((t) => [t.platform, t.captionOverride, t.settings])).toEqual([
      ["tiktok", "TikTok only", { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true }],
    ]);
  });

  it("publish now from the editor: validates, enqueues, and the draft becomes a published post", async () => {
    const { post } = composePost(db, draft());
    const { jobs } = updateDraft(db, post.id, draft({ action: "publish" }));
    expect(jobs).toHaveLength(2);
    await runAll();
    expect(getPost(db, post.id)!.status).toBe("published");
    // No more editing once it has jobs.
    expectComposeError(() => updateDraft(db, post.id, draft()), 409, /Only drafts/);
  });

  it("publish blocks on validation errors with a 422 and leaves the draft untouched", () => {
    const { post } = composePost(db, draft({ targets: [{ platform: "tiktok" }] }));
    const err = expectComposeError(() => publishDraft(db, post.id), 422, /TikTok/);
    expect(err.validation![0].errors[0].code).toBe("tiktok_privacy_required");
    expect(getPost(db, post.id)!.status).toBe("draft");
    expect(listJobs(db, post.id)).toEqual([]);
  });

  it("publishDraft: now, or scheduled later", async () => {
    const a = composePost(db, draft()).post;
    const nowResult = publishDraft(db, a.id, { scheduledAt: null });
    expect(nowResult.post.scheduledAt).toBeNull();
    await runAll();
    expect(getPost(db, a.id)!.status).toBe("published");

    const b = composePost(db, draft()).post;
    const at = new Date(Date.now() + 2 * 86_400_000).toISOString();
    const later = publishDraft(db, b.id, { scheduledAt: at });
    expect(later.post.scheduledAt).toBe(at);
    expect(later.jobs.find((j) => j.platform === "tiktok")!.nextRunAt).toBe(at);
    await runAll(); // only YouTube (native scheduling) uploads now
    expect(getPost(db, b.id)!.status).toBe("scheduled");
  });

  it("publishDraft keeps the draft's own schedule when none is given; past times are rejected", () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const { post } = composePost(db, draft({ scheduledAt: at }));
    expect(publishDraft(db, post.id).post.scheduledAt).toBe(at);
    const old = composePost(db, draft({ scheduledAt: new Date(Date.now() - 86_400_000).toISOString() })).post;
    expectComposeError(() => publishDraft(db, old.id), 400, /past/);
    expectComposeError(() => publishDraft(db, "missing"), 404);
  });

  it("publishing a draft without a video is refused", () => {
    const { post } = composePost(db, draft({ mediaId: null }));
    expectComposeError(() => publishDraft(db, post.id), 400, /Upload a video/);
  });
});

describe("delete", () => {
  it("deletes a draft and its no-longer-referenced media", () => {
    const { post } = composePost(db, draft());
    expect(deletePostAndOrphans(db, post.id).deletedMediaPaths).toEqual(["ab/a.mp4"]);
    expect(getPost(db, post.id)).toBeNull();
    expect(getMedia(db, mediaId)).toBeNull();
  });

  it("keeps media still used by another post; cancels queued jobs of scheduled posts", () => {
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const scheduled = composePost(db, draft({ action: "publish", scheduledAt: at, targets: [{ platform: "x" }] })).post;
    const other = composePost(db, draft()).post;
    expect(listJobs(db, scheduled.id)).toHaveLength(1);
    expect(deletePostAndOrphans(db, scheduled.id).deletedMediaPaths).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM publish_jobs").get()).toEqual({ n: 0 });
    expect(getMedia(db, mediaId)).not.toBeNull();
    expect(getPost(db, other.id)).not.toBeNull();
  });

  it("refuses while a job is uploading", () => {
    const { post } = composePost(db, draft({ action: "publish", targets: [{ platform: "x" }] }));
    db.prepare("UPDATE publish_jobs SET status = 'uploading'").run();
    expectComposeError(() => deletePostAndOrphans(db, post.id), 409, /uploading/);
  });
});
