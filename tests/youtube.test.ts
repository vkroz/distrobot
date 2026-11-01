import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AdapterError, type PublishRequest } from "@/lib/adapters";
import { YouTubeAdapter, fitTags, nextOffsetFromRange } from "@/lib/adapters/platforms/youtube";
import type { ConnectedAccount, Media } from "@/lib/types";

const KB256 = 256 * 1024;
const FILE_SIZE = KB256 * 2 + 1000; // 3 chunks at 256 KiB
let dir: string;
let videoPath: string;
let thumbPath: string;

beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "yt-test-"));
  videoPath = path.join(dir, "v.mp4");
  thumbPath = path.join(dir, "t.jpg");
  await fs.writeFile(videoPath, Buffer.alloc(FILE_SIZE, 7));
  await fs.writeFile(thumbPath, Buffer.alloc(1000, 1));
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());

const media: Media = {
  id: "m",
  kind: "video",
  metadataSource: null,
  originalFilename: "v.mp4",
  storagePath: "v.mp4",
  mimeType: "video/mp4",
  sizeBytes: FILE_SIZE,
  durationSec: 600,
  width: 1920,
  height: 1080,
  checksum: null,
  createdAt: "",
};

const account: ConnectedAccount = {
  id: "a",
  platform: "youtube",
  externalId: "UC1",
  displayName: "Chan",
  accessToken: "AT",
  refreshToken: "RT",
  expiresAt: null,
  scopes: [],
  metadata: {},
  createdAt: "",
  updatedAt: "",
};

const req = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  jobId: "j1",
  content: { title: "My video", caption: "Watch this", hashtags: ["travel", "lisbon"] },
  media,
  mediaPath: videoPath,
  visibility: "public",
  settings: {},
  ...over,
});

interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

/** In-memory fake of the YouTube resumable upload + thumbnails endpoints. */
function fakeYouTube(opts: { failChunkOnce?: number; sessionExpired?: boolean; thumbnailStatus?: number } = {}) {
  const calls: Call[] = [];
  let received = 0;
  let chunkCount = 0;
  let failed = false;
  const SESSION = "https://upload.example/session/abc";
  const fetchImpl = vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    const body = init.body;
    calls.push({ method: init.method ?? "GET", url, headers, body: typeof body === "string" ? JSON.parse(body) : body });

    if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/videos")) {
      return new Response("", { status: 200, headers: { location: SESSION } });
    }
    if (url === SESSION) {
      const range = headers["content-range"];
      if (range.startsWith("bytes */")) {
        if (opts.sessionExpired) return new Response("gone", { status: 410 });
        return new Response("", { status: 308, headers: received ? { range: `bytes=0-${received - 1}` } : {} });
      }
      chunkCount++;
      if (opts.failChunkOnce === chunkCount && !failed) {
        failed = true;
        return new Response("backend error", { status: 503 });
      }
      const [, start, end, total] = range.match(/bytes (\d+)-(\d+)\/(\d+)/)!.map(Number);
      expect(start).toBe(received);
      expect((body as Uint8Array).byteLength).toBe(end - start + 1);
      received = end + 1;
      if (received < total) return new Response("", { status: 308, headers: { range: `bytes=0-${end}` } });
      return Response.json({ id: "VID123", status: { uploadStatus: "uploaded" } }, { status: 201 });
    }
    if (url.startsWith("https://www.googleapis.com/upload/youtube/v3/thumbnails/set")) {
      const status = opts.thumbnailStatus ?? 200;
      return status === 200 ? Response.json({ items: [] }) : new Response("forbidden", { status });
    }
    return new Response("unexpected", { status: 404 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls, received: () => received };
}

describe("helpers", () => {
  it("fits tags into 500 chars", () => {
    const tags = Array.from({ length: 100 }, (_, i) => `tag-number-${i}`);
    const fitted = fitTags(tags);
    expect(fitted.join(",").length).toBeLessThanOrEqual(500);
    expect(fitted.length).toBeGreaterThan(10);
    // Tags containing spaces are quoted: 9 chars + 2 quotes.
    expect(fitTags(["two words"], 11)).toEqual(["two words"]);
    expect(fitTags(["two words"], 10)).toEqual([]);
  });

  it("parses Range headers", () => {
    expect(nextOffsetFromRange("bytes=0-524287")).toBe(524288);
    expect(nextOffsetFromRange(null)).toBe(0);
  });
});

describe("YouTubeAdapter.publish", () => {
  const adapter = new YouTubeAdapter({ chunkSize: KB256 });

  it("uploads with the resumable protocol in chunks and returns the watch URL", async () => {
    const yt = fakeYouTube();
    const progress: number[] = [];
    const checkpoints: unknown[] = [];
    const res = await adapter.publish(req({ thumbnail: { path: thumbPath, mimeType: "image/jpeg", sizeBytes: 1000 } }), {
      account,
      dryRun: false,
      fetch: yt.fetchImpl,
      onProgress: (p) => progress.push(p.fraction ?? -1),
      saveCheckpoint: (c) => checkpoints.push(c),
    });

    expect(res).toMatchObject({ url: "https://www.youtube.com/watch?v=VID123", externalId: "VID123", dryRun: false });
    expect(yt.received()).toBe(FILE_SIZE);

    const [init, ...rest] = yt.calls;
    expect(init.method).toBe("POST");
    expect(init.url).toContain("uploadType=resumable");
    expect(init.url).toContain("part=snippet%2Cstatus");
    expect(init.headers.authorization).toBe("Bearer AT");
    expect(init.headers["x-upload-content-length"]).toBe(String(FILE_SIZE));
    expect(init.body).toMatchObject({
      snippet: { title: "My video", description: "Watch this\n\n#travel #lisbon", tags: ["travel", "lisbon"], categoryId: "22" },
      status: { privacyStatus: "public", selfDeclaredMadeForKids: false },
    });

    const puts = rest.filter((c) => c.method === "PUT");
    expect(puts.map((c) => c.headers["content-range"])).toEqual([
      `bytes 0-${KB256 - 1}/${FILE_SIZE}`,
      `bytes ${KB256}-${2 * KB256 - 1}/${FILE_SIZE}`,
      `bytes ${2 * KB256}-${FILE_SIZE - 1}/${FILE_SIZE}`,
    ]);
    expect(checkpoints).toEqual([{ sessionUri: "https://upload.example/session/abc", totalBytes: FILE_SIZE }]);
    expect(progress.at(-1)).toBe(1);

    const thumb = yt.calls.at(-1)!;
    expect(thumb.url).toContain("thumbnails/set?videoId=VID123");
    expect(thumb.headers["content-type"]).toBe("image/jpeg");
    expect(res.warnings).toEqual([]);
  });

  it("schedules natively with publishAt (forces private)", async () => {
    const yt = fakeYouTube();
    const at = new Date(Date.now() + 86_400_000).toISOString();
    const res = await adapter.publish(req({ scheduledAt: at, visibility: "public" }), { account, dryRun: false, fetch: yt.fetchImpl });
    expect(yt.calls[0].body).toMatchObject({ status: { privacyStatus: "private", publishAt: at } });
    expect(res.payload).toMatchObject({ publishAt: at, privacyStatus: "private" });
  });

  it("returns a Shorts URL for short vertical video", async () => {
    const yt = fakeYouTube();
    const res = await adapter.publish(req({ media: { ...media, width: 1080, height: 1920, durationSec: 30 } }), {
      account,
      dryRun: false,
      fetch: yt.fetchImpl,
    });
    expect(res.url).toBe("https://www.youtube.com/shorts/VID123");
  });

  it("fails retryably on a 5xx mid-upload, then resumes from the checkpoint", async () => {
    const yt = fakeYouTube({ failChunkOnce: 2 });
    let checkpoint: unknown = null;
    const ctx = { account, dryRun: false, fetch: yt.fetchImpl, saveCheckpoint: (c: unknown) => (checkpoint = c) };

    const err = await adapter.publish(req(), ctx).catch((e) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect(err).toMatchObject({ code: "upstream_error", retryable: true });
    expect(yt.received()).toBe(KB256);

    const res = await adapter.publish(req({ checkpoint }), ctx);
    expect(res.externalId).toBe("VID123");
    expect(yt.received()).toBe(FILE_SIZE);
    // Only one session was created; the retry queried status then continued at byte 256 KiB.
    expect(yt.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    const statusQuery = yt.calls.find((c) => c.headers["content-range"] === `bytes */${FILE_SIZE}`);
    expect(statusQuery).toBeDefined();
  });

  it("starts a new session when the checkpointed one expired", async () => {
    const yt = fakeYouTube({ sessionExpired: true });
    const res = await adapter.publish(
      req({ checkpoint: { sessionUri: "https://upload.example/session/abc", totalBytes: FILE_SIZE } }),
      { account, dryRun: false, fetch: yt.fetchImpl },
    );
    expect(res.externalId).toBe("VID123");
    expect(yt.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("treats quota errors as non-retryable and 401 as auth_failed", async () => {
    const quota = vi.fn(async () => new Response(JSON.stringify({ error: { errors: [{ reason: "quotaExceeded" }] } }), { status: 403 }));
    await expect(adapter.publish(req(), { account, dryRun: false, fetch: quota as unknown as typeof fetch })).rejects.toMatchObject({
      code: "quota_exceeded",
      retryable: false,
    });
    const unauth = vi.fn(async () => new Response("invalid credentials", { status: 401 }));
    await expect(adapter.publish(req(), { account, dryRun: false, fetch: unauth as unknown as typeof fetch })).rejects.toMatchObject({
      code: "auth_failed",
    });
  });

  it("publishes even if setting the thumbnail fails, with a warning", async () => {
    const yt = fakeYouTube({ thumbnailStatus: 403 });
    const res = await adapter.publish(req({ thumbnail: { path: thumbPath, mimeType: "image/jpeg", sizeBytes: 1000 } }), {
      account,
      dryRun: false,
      fetch: yt.fetchImpl,
    });
    expect(res.externalId).toBe("VID123");
    expect(res.warnings.join(" ")).toMatch(/thumbnail failed/);
  });

  it("skips unsupported thumbnail formats", async () => {
    const yt = fakeYouTube();
    const res = await adapter.publish(req({ thumbnail: { path: thumbPath, mimeType: "image/webp", sizeBytes: 1000 } }), {
      account,
      dryRun: false,
      fetch: yt.fetchImpl,
    });
    expect(res.warnings.join(" ")).toMatch(/JPEG or PNG/);
    expect(yt.calls.some((c) => c.url.includes("thumbnails"))).toBe(false);
  });
});

describe("YouTube OAuth refresh", () => {
  it("refreshes via Google's token endpoint and keeps the refresh token", async () => {
    vi.stubEnv("YOUTUBE_CLIENT_ID", "id");
    vi.stubEnv("YOUTUBE_CLIENT_SECRET", "secret");
    const f = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("RT");
      expect(body.get("client_secret")).toBe("secret");
      return Response.json({ access_token: "AT2", expires_in: 3600 });
    });
    const tokens = await new YouTubeAdapter().refreshAccessToken(account, f as unknown as typeof fetch);
    expect(f.mock.calls[0][0]).toBe("https://oauth2.googleapis.com/token");
    expect(tokens.accessToken).toBe("AT2");
    expect(tokens.refreshToken).toBe("RT");
    expect(Date.parse(tokens.expiresAt!)).toBeGreaterThan(Date.now());
    vi.unstubAllEnvs();
  });
});
