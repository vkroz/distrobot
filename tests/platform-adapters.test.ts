import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdapterError, type PublishRequest } from "@/lib/adapters";
import { FacebookAdapter } from "@/lib/adapters/platforms/facebook";
import { InstagramAdapter } from "@/lib/adapters/platforms/instagram";
import { LinkedInAdapter } from "@/lib/adapters/platforms/linkedin";
import { TikTokAdapter, tiktokChunks } from "@/lib/adapters/platforms/tiktok";
import { VimeoAdapter } from "@/lib/adapters/platforms/vimeo";
import { XAdapter } from "@/lib/adapters/platforms/x";
import type { ConnectedAccount, Media, PlatformId } from "@/lib/types";

const FILE_SIZE = 1000;
let dir: string;
let videoPath: string;
let thumbPath: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cp-adapters-"));
  videoPath = path.join(dir, "video.mp4");
  thumbPath = path.join(dir, "thumb.jpg");
  await fs.writeFile(videoPath, Buffer.alloc(FILE_SIZE, 7));
  await fs.writeFile(thumbPath, Buffer.from("jpegdata"));
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));

const media: Media = {
  id: "m1",
  kind: "video",
  metadataSource: null,
  originalFilename: "video.mp4",
  storagePath: "video.mp4",
  mimeType: "video/mp4",
  sizeBytes: 10 * 1024 * 1024, // declared; adapters must use the real file size
  durationSec: 30,
  width: 1080,
  height: 1920,
  checksum: null,
  createdAt: "",
};

const req = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  jobId: "job-1",
  content: { title: "My video", caption: "Hello world", hashtags: ["tag"] },
  media,
  mediaPath: videoPath,
  visibility: "public",
  settings: { privacyLevel: "PUBLIC_TO_EVERYONE" },
  ...over,
});

const account = (platform: PlatformId, over: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id: "acc",
  platform,
  externalId: "user1",
  displayName: "creator",
  accessToken: "TOKEN",
  refreshToken: null,
  expiresAt: null,
  scopes: [],
  metadata: {},
  createdAt: "",
  updatedAt: "",
  ...over,
});

interface Call {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

/** Records calls; `route` returns a Response for each request. */
function mockFetch(route: (c: Call, i: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = async (input: string | URL | Request, init: RequestInit = {}) => {
    const c: Call = {
      method: init.method ?? "GET",
      url: String(input),
      headers: new Headers(init.headers),
      body: init.body,
    };
    calls.push(c);
    return route(c, calls.length - 1);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

const jsonBody = (c: Call) => JSON.parse(String(c.body));
const bodyLength = (c: Call) => (c.body instanceof Uint8Array ? c.body.length : -1);
const ok = (data: unknown, init: ResponseInit = {}) => Response.json(data, init);

// ---------------------------------------------------------------------------

describe("TikTok", () => {
  it("computes compliant chunks", () => {
    expect(tiktokChunks(3_000_000)).toEqual({ chunkSize: 3_000_000, count: 1 });
    const mb = 1024 * 1024;
    expect(tiktokChunks(25 * mb, 10 * mb)).toEqual({ chunkSize: 10 * mb, count: 2 }); // last chunk takes 15 MB
  });

  const route = (statuses: string[]) => {
    let polls = 0;
    return (c: Call) => {
      if (c.url.endsWith("/creator_info/query/")) {
        return ok({
          data: { creator_username: "maker", privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], max_video_post_duration_sec: 600 },
          error: { code: "ok" },
        });
      }
      if (c.url.endsWith("/video/init/")) return ok({ data: { publish_id: "pub1", upload_url: "https://upload.tiktok/u1" }, error: { code: "ok" } });
      if (c.url.startsWith("https://upload.tiktok/")) return new Response(null, { status: 201 });
      if (c.url.endsWith("/status/fetch/")) {
        const status = statuses[Math.min(polls++, statuses.length - 1)];
        return ok({
          data: { status, fail_reason: "spam_risk", publicaly_available_post_id: status === "PUBLISH_COMPLETE" ? [777] : [] },
          error: { code: "ok" },
        });
      }
      return new Response("unexpected", { status: 404 });
    };
  };

  it("inits, uploads in chunks with Content-Range, polls, and returns the video URL", async () => {
    const m = mockFetch(route(["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"]));
    const checkpoints: unknown[] = [];
    const adapter = new TikTokAdapter({ chunkSize: 400, minChunkSize: 100, pollIntervalMs: 1 });
    const res = await adapter.publish(req(), {
      account: account("tiktok"),
      dryRun: false,
      fetch: m.fetch,
      saveCheckpoint: (d) => checkpoints.push(d),
    });
    expect(res.url).toBe("https://www.tiktok.com/@maker/video/777");
    const init = m.calls.find((c) => c.url.endsWith("/video/init/"))!;
    expect(jsonBody(init)).toMatchObject({
      post_info: {
        title: "Hello world\n\n#tag",
        privacy_level: "PUBLIC_TO_EVERYONE",
        // Interactions are off unless the user turns them on; no commercial disclosure.
        disable_comment: true,
        disable_duet: true,
        disable_stitch: true,
        brand_content_toggle: false,
        brand_organic_toggle: false,
      },
      source_info: { source: "FILE_UPLOAD", video_size: FILE_SIZE, chunk_size: 400, total_chunk_count: 2 },
    });
    const puts = m.calls.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.headers.get("content-range"))).toEqual(["bytes 0-399/1000", "bytes 400-999/1000"]);
    expect(puts.map(bodyLength)).toEqual([400, 600]);
    expect(checkpoints.at(-1)).toMatchObject({ publishId: "pub1", uploaded: true });
  });

  it("sends the user's interaction and commercial-disclosure choices", async () => {
    const m = mockFetch(route(["PUBLISH_COMPLETE"]));
    await new TikTokAdapter({ pollIntervalMs: 1 }).publish(
      req({
        settings: {
          privacyLevel: "PUBLIC_TO_EVERYONE",
          allowComment: true,
          allowDuet: true,
          commercial: { enabled: true, yourBrand: true, brandedContent: true },
        },
      }),
      { account: account("tiktok"), dryRun: false, fetch: m.fetch },
    );
    expect(jsonBody(m.calls.find((c) => c.url.endsWith("/video/init/"))!).post_info).toMatchObject({
      disable_comment: false,
      disable_duet: false,
      disable_stitch: true,
      brand_organic_toggle: true,
      brand_content_toggle: true,
    });
  });

  it("never picks a privacy level for the user: missing or disallowed choices fail before upload", async () => {
    for (const settings of [{}, { privacyLevel: "FOLLOWER_OF_CREATOR" }]) {
      const m = mockFetch(route(["PUBLISH_COMPLETE"]));
      await expect(
        new TikTokAdapter({ pollIntervalMs: 1 }).publish(req({ settings }), { account: account("tiktok"), dryRun: false, fetch: m.fetch }),
      ).rejects.toMatchObject({ code: "validation_failed", retryable: false });
      expect(m.calls.some((c) => c.url.endsWith("/video/init/"))).toBe(false);
    }
  });

  it("resumes from an uploaded checkpoint by polling only", async () => {
    const m = mockFetch(route(["PUBLISH_COMPLETE"]));
    await new TikTokAdapter({ pollIntervalMs: 1 }).publish(
      req({ checkpoint: { publishId: "pub1", uploaded: true, username: "maker" } }),
      { account: account("tiktok"), dryRun: false, fetch: m.fetch },
    );
    expect(m.calls.map((c) => c.url.split("/").slice(-2).join("/"))).toEqual(["fetch/"]);
  });

  it("FAILED status is a non-retryable error", async () => {
    const m = mockFetch(route(["FAILED"]));
    await expect(
      new TikTokAdapter({ pollIntervalMs: 1 }).publish(req(), { account: account("tiktok"), dryRun: false, fetch: m.fetch }),
    ).rejects.toMatchObject({ code: "upstream_error", retryable: false, message: expect.stringMatching(/spam_risk/) });
  });

  it("API error envelope is surfaced", async () => {
    const m = mockFetch(() => ok({ data: {}, error: { code: "spam_risk_too_many_posts", message: "slow down" } }));
    await expect(
      new TikTokAdapter().publish(req(), { account: account("tiktok"), dryRun: false, fetch: m.fetch }),
    ).rejects.toMatchObject({ message: expect.stringMatching(/spam_risk_too_many_posts/) });
  });
});

// ---------------------------------------------------------------------------

describe("Instagram", () => {
  const route = (statuses: string[]) => {
    let polls = 0;
    return (c: Call) => {
      if (c.method === "POST" && c.url.endsWith("/user1/media")) return ok({ id: "cont1" });
      if (c.url.startsWith("https://rupload.facebook.com/")) return ok({ success: true });
      if (c.url.includes("/cont1?")) return ok({ status_code: statuses[Math.min(polls++, statuses.length - 1)], status: "Error: bad codec" });
      if (c.url.endsWith("/user1/media_publish")) return ok({ id: "media9" });
      if (c.url.includes("/media9?")) return ok({ permalink: "https://www.instagram.com/reel/abc/" });
      return new Response("unexpected", { status: 404 });
    };
  };

  it("creates a resumable REELS container, uploads, polls, publishes and fetches the permalink", async () => {
    const m = mockFetch(route(["IN_PROGRESS", "FINISHED"]));
    const res = await new InstagramAdapter({ pollIntervalMs: 1 }).publish(req(), {
      account: account("instagram"),
      dryRun: false,
      fetch: m.fetch,
    });
    expect(res.url).toBe("https://www.instagram.com/reel/abc/");
    expect(res.externalId).toBe("media9");
    const create = m.calls[0];
    const params = new URLSearchParams(String(create.body));
    expect(create.url).toBe("https://graph.instagram.com/v23.0/user1/media");
    expect(params.get("media_type")).toBe("REELS");
    expect(params.get("upload_type")).toBe("resumable");
    expect(params.get("caption")).toBe("Hello world\n\n#tag");
    const upload = m.calls[1];
    expect(upload.url).toBe("https://rupload.facebook.com/ig-api-upload/v23.0/cont1");
    expect(upload.headers.get("authorization")).toBe("OAuth TOKEN");
    expect(upload.headers.get("file_size")).toBe(String(FILE_SIZE));
    expect(upload.headers.get("offset")).toBe("0");
    expect(bodyLength(upload)).toBe(FILE_SIZE);
    expect(new URLSearchParams(String(m.calls.find((c) => c.url.endsWith("media_publish"))!.body)).get("creation_id")).toBe("cont1");
  });

  it("container ERROR fails permanently", async () => {
    const m = mockFetch(route(["ERROR"]));
    await expect(
      new InstagramAdapter({ pollIntervalMs: 1 }).publish(req(), { account: account("instagram"), dryRun: false, fetch: m.fetch }),
    ).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/bad codec/) });
  });

  it("5xx during upload is retryable", async () => {
    const m = mockFetch((c) => (c.url.startsWith("https://rupload") ? new Response("oops", { status: 503 }) : ok({ id: "cont1" })));
    const err = await new InstagramAdapter()
      .publish(req(), { account: account("instagram"), dryRun: false, fetch: m.fetch })
      .catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe("X", () => {
  const route = (states: string[]) => {
    let polls = 0;
    return (c: Call) => {
      if (c.url.endsWith("/media/upload/initialize")) return ok({ data: { id: "mid1" } });
      if (c.url.endsWith("/append")) return ok({});
      if (c.url.endsWith("/finalize")) return ok({ data: { id: "mid1", processing_info: { state: "pending", check_after_secs: 1 } } });
      if (c.url.includes("command=STATUS")) {
        const state = states[Math.min(polls++, states.length - 1)];
        return ok({ data: { processing_info: { state, error: { message: "InvalidMedia" } } } });
      }
      if (c.url.endsWith("/2/tweets")) return ok({ data: { id: "t42" } });
      return new Response("unexpected", { status: 404 });
    };
  };

  it("initializes, appends segments, finalizes, polls, and posts", async () => {
    const m = mockFetch(route(["in_progress", "succeeded"]));
    const res = await new XAdapter({ chunkSize: 300, pollIntervalMs: 1 }).publish(req(), {
      account: account("x", { displayName: "@creator" }),
      dryRun: false,
      fetch: m.fetch,
    });
    expect(res.url).toBe("https://x.com/creator/status/t42");
    expect(jsonBody(m.calls[0])).toEqual({ media_type: "video/mp4", total_bytes: FILE_SIZE, media_category: "tweet_video" });
    const appends = m.calls.filter((c) => c.url.endsWith("/append"));
    expect(appends).toHaveLength(4);
    expect(appends.map((c) => (c.body as FormData).get("segment_index"))).toEqual(["0", "1", "2", "3"]);
    expect(jsonBody(m.calls.at(-1)!)).toEqual({ text: "Hello world\n\n#tag", media: { media_ids: ["mid1"] } });
  });

  it("resumes appends from the checkpoint segment", async () => {
    const m = mockFetch(route(["succeeded"]));
    await new XAdapter({ chunkSize: 300, pollIntervalMs: 1 }).publish(
      req({ checkpoint: { mediaId: "mid1", nextSegment: 3, finalized: false } }),
      { account: account("x"), dryRun: false, fetch: m.fetch },
    );
    expect(m.calls.some((c) => c.url.endsWith("/initialize"))).toBe(false);
    expect(m.calls.filter((c) => c.url.endsWith("/append"))).toHaveLength(1);
  });

  it("processing failure is a non-retryable error", async () => {
    const m = mockFetch(route(["failed"]));
    await expect(
      new XAdapter({ pollIntervalMs: 1 }).publish(req(), { account: account("x"), dryRun: false, fetch: m.fetch }),
    ).rejects.toMatchObject({ retryable: false, message: expect.stringMatching(/InvalidMedia/) });
  });

  it("429 is retryable", async () => {
    const m = mockFetch(() => new Response("Too Many Requests", { status: 429 }));
    await expect(new XAdapter().publish(req(), { account: account("x"), dryRun: false, fetch: m.fetch })).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });
});

// ---------------------------------------------------------------------------

describe("Facebook", () => {
  const fbAccount = account("facebook", { metadata: { pages: [{ id: "page1", name: "My Page", accessToken: "PAGETOKEN" }] } });
  const route = () => (c: Call) => {
    const form = c.body as FormData;
    switch (form.get("upload_phase")) {
      case "start":
        return ok({ video_id: "vid1", upload_session_id: "sess1", start_offset: "0", end_offset: "600" });
      case "transfer":
        return form.get("start_offset") === "0"
          ? ok({ start_offset: "600", end_offset: "1000" })
          : ok({ start_offset: "1000", end_offset: "1000" });
      case "finish":
        return ok({ success: true });
    }
    return new Response("unexpected", { status: 404 });
  };

  it("runs start/transfer/finish with the page token and returns the page video URL", async () => {
    const m = mockFetch(route());
    const res = await new FacebookAdapter().publish(
      req({ thumbnail: { path: thumbPath, mimeType: "image/jpeg", sizeBytes: 8 } }),
      { account: fbAccount, dryRun: false, fetch: m.fetch },
    );
    expect(res.url).toBe("https://www.facebook.com/page1/videos/vid1");
    expect(m.calls.every((c) => c.url === "https://graph-video.facebook.com/v23.0/page1/videos")).toBe(true);
    const forms = m.calls.map((c) => c.body as FormData);
    expect(forms.map((f) => f.get("upload_phase"))).toEqual(["start", "transfer", "transfer", "finish"]);
    expect(forms.every((f) => f.get("access_token") === "PAGETOKEN")).toBe(true);
    expect(forms[0].get("file_size")).toBe(String(FILE_SIZE));
    expect((forms[1].get("video_file_chunk") as Blob).size).toBe(600);
    expect((forms[2].get("video_file_chunk") as Blob).size).toBe(400);
    expect(forms[3].get("title")).toBe("My video");
    expect(forms[3].get("published")).toBe("true");
    expect(forms[3].get("thumb")).toBeInstanceOf(Blob);
  });

  it("errors when the account has no pages", async () => {
    const m = mockFetch(route());
    await expect(
      new FacebookAdapter().publish(req(), { account: account("facebook"), dryRun: false, fetch: m.fetch }),
    ).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("resumes transfer from the checkpoint offsets", async () => {
    const m = mockFetch(route());
    await new FacebookAdapter().publish(
      req({ checkpoint: { pageId: "page1", sessionId: "sess1", videoId: "vid1", startOffset: 600, endOffset: 1000 } }),
      { account: fbAccount, dryRun: false, fetch: m.fetch },
    );
    expect(m.calls.map((c) => (c.body as FormData).get("upload_phase"))).toEqual(["transfer", "finish"]);
  });
});

// ---------------------------------------------------------------------------

describe("LinkedIn", () => {
  const route = () => (c: Call) => {
    if (c.url.endsWith("action=initializeUpload")) {
      return ok({
        value: {
          video: "urn:li:video:V1",
          uploadToken: "",
          uploadInstructions: [
            { uploadUrl: "https://upload.linkedin/p1", firstByte: 0, lastByte: 499 },
            { uploadUrl: "https://upload.linkedin/p2", firstByte: 500, lastByte: 999 },
          ],
          thumbnailUploadUrl: "https://upload.linkedin/thumb",
        },
      });
    }
    if (c.url.startsWith("https://upload.linkedin/p")) return new Response(null, { status: 200, headers: { etag: `etag-${c.url.slice(-1)}` } });
    if (c.url === "https://upload.linkedin/thumb") return new Response(null, { status: 201 });
    if (c.url.endsWith("action=finalizeUpload")) return new Response(null, { status: 200 });
    if (c.url.includes("/rest/videos/")) return ok({ status: "AVAILABLE" });
    if (c.url.endsWith("/rest/posts")) return new Response(null, { status: 201, headers: { "x-restli-id": "urn:li:share:99" } });
    return new Response("unexpected", { status: 404 });
  };

  it("initializes, uploads parts, finalizes with ETags and creates the post", async () => {
    const m = mockFetch(route());
    const res = await new LinkedInAdapter({ pollIntervalMs: 1 }).publish(
      req({ thumbnail: { path: thumbPath, mimeType: "image/jpeg", sizeBytes: 8 } }),
      { account: account("linkedin", { metadata: { authorUrn: "urn:li:person:abc" } }), dryRun: false, fetch: m.fetch },
    );
    expect(res.url).toBe("https://www.linkedin.com/feed/update/urn:li:share:99");
    const init = m.calls[0];
    expect(init.headers.get("linkedin-version")).toMatch(/^\d{6}$/);
    expect(init.headers.get("x-restli-protocol-version")).toBe("2.0.0");
    expect(jsonBody(init).initializeUploadRequest).toEqual({
      owner: "urn:li:person:abc",
      fileSizeBytes: FILE_SIZE,
      uploadCaptions: false,
      uploadThumbnail: true,
    });
    expect(m.calls.filter((c) => c.url.startsWith("https://upload.linkedin/p")).map(bodyLength)).toEqual([500, 500]);
    expect(jsonBody(m.calls.find((c) => c.url.endsWith("finalizeUpload"))!).finalizeUploadRequest.uploadedPartIds).toEqual([
      "etag-1",
      "etag-2",
    ]);
    const post = jsonBody(m.calls.at(-1)!);
    expect(post).toMatchObject({
      author: "urn:li:person:abc",
      commentary: "Hello world\n\n#tag",
      visibility: "PUBLIC",
      content: { media: { title: "My video", id: "urn:li:video:V1" } },
      lifecycleState: "PUBLISHED",
    });
  });

  it("PROCESSING_FAILED fails permanently", async () => {
    const base = route();
    const m = mockFetch((c) => (c.url.includes("/rest/videos/") ? ok({ status: "PROCESSING_FAILED" }) : base(c)));
    await expect(
      new LinkedInAdapter({ pollIntervalMs: 1 }).publish(req(), { account: account("linkedin"), dryRun: false, fetch: m.fetch }),
    ).rejects.toMatchObject({ retryable: false });
  });
});

// ---------------------------------------------------------------------------

describe("Vimeo", () => {
  const route = () => (c: Call) => {
    if (c.url === "https://api.vimeo.com/me/videos") {
      return ok({ uri: "/videos/123", link: "https://vimeo.com/123", upload: { upload_link: "https://tus.vimeo/up1" } });
    }
    if (c.url === "https://tus.vimeo/up1" && c.method === "HEAD") return new Response(null, { status: 200, headers: { "Upload-Offset": "700" } });
    if (c.url === "https://tus.vimeo/up1" && c.method === "PATCH") {
      const next = Number(c.headers.get("upload-offset")) + bodyLength(c);
      return new Response(null, { status: 204, headers: { "Upload-Offset": String(next) } });
    }
    if (c.url.endsWith("/videos/123/tags")) return new Response(null, { status: 200 });
    return new Response("unexpected", { status: 404 });
  };

  it("creates a tus upload, PATCHes chunks, sets tags", async () => {
    const m = mockFetch(route());
    const res = await new VimeoAdapter({ chunkSize: 400 }).publish(req({ visibility: "unlisted" }), {
      account: account("vimeo"),
      dryRun: false,
      fetch: m.fetch,
    });
    expect(res.url).toBe("https://vimeo.com/123");
    expect(res.externalId).toBe("123");
    const create = jsonBody(m.calls[0]);
    expect(create).toMatchObject({
      upload: { approach: "tus", size: String(FILE_SIZE) },
      name: "My video",
      description: "Hello world",
      privacy: { view: "unlisted" },
    });
    const patches = m.calls.filter((c) => c.method === "PATCH");
    expect(patches.map((c) => c.headers.get("upload-offset"))).toEqual(["0", "400", "800"]);
    expect(patches.every((c) => c.headers.get("tus-resumable") === "1.0.0")).toBe(true);
    expect(jsonBody(m.calls.at(-1)!)).toEqual([{ name: "tag" }]);
  });

  it("resumes via HEAD from the checkpoint", async () => {
    const m = mockFetch(route());
    await new VimeoAdapter({ chunkSize: 400 }).publish(
      req({ checkpoint: { uri: "/videos/123", link: "https://vimeo.com/123", uploadLink: "https://tus.vimeo/up1" } }),
      { account: account("vimeo"), dryRun: false, fetch: m.fetch },
    );
    expect(m.calls[0].method).toBe("HEAD");
    expect(m.calls.filter((c) => c.method === "PATCH").map((c) => c.headers.get("upload-offset"))).toEqual(["700"]);
  });

  it("tag failure is only a warning", async () => {
    const base = route();
    const m = mockFetch((c) => (c.url.endsWith("/tags") ? new Response("nope", { status: 400 }) : base(c)));
    const res = await new VimeoAdapter().publish(req(), { account: account("vimeo"), dryRun: false, fetch: m.fetch });
    expect(res.url).toBe("https://vimeo.com/123");
    expect(res.warnings.join(" ")).toMatch(/tags/);
  });
});
