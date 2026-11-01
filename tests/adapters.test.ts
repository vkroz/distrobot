import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdapterError, createPkcePair, getAdapter, listAdapters, registerAdapter, resetAdapters } from "@/lib/adapters";
import type { PublishRequest } from "@/lib/adapters";
import { openDatabase } from "@/lib/db";
import { createMedia, createPost, enqueuePublish, getJob, getPost, upsertTarget } from "@/lib/db/repo";
import { runNextJob } from "@/lib/jobs/runner";
import { PLATFORM_IDS, type ConnectedAccount, type Media } from "@/lib/types";

const media: Media = {
  id: "m1",
  kind: "video",
  metadataSource: null,
  originalFilename: "clip.mp4",
  storagePath: "m1.mp4",
  mimeType: "video/mp4",
  sizeBytes: 10_000_000,
  durationSec: 30,
  width: 1080,
  height: 1920,
  checksum: null,
  createdAt: new Date().toISOString(),
};

const req = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  jobId: "job-1",
  content: { title: "Title", caption: "Caption", hashtags: ["tag"] },
  media,
  mediaPath: "/tmp/m1.mp4",
  visibility: "public",
  settings: { privacyLevel: "PUBLIC_TO_EVERYONE" }, // TikTok requires an explicit choice
  ...over,
});

const account = (over: Partial<ConnectedAccount> = {}): ConnectedAccount => ({
  id: "acc",
  platform: "x",
  externalId: "1",
  displayName: "@me",
  accessToken: "tok",
  refreshToken: null,
  expiresAt: null,
  scopes: [],
  metadata: {},
  createdAt: "",
  updatedAt: "",
  ...over,
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetAdapters();
});

describe("registry", () => {
  it("has an adapter for every platform", () => {
    expect(listAdapters().map((a) => a.platform).sort()).toEqual([...PLATFORM_IDS].sort());
  });
});

describe("dry run", () => {
  it.each(PLATFORM_IDS)("%s dry-run publish returns a simulated result without network", async (platform) => {
    const progress: number[] = [];
    const res = await getAdapter(platform).publish(req(), {
      account: null,
      dryRun: true,
      simulatedDelayMs: 0,
      onProgress: (p) => progress.push(p.fraction ?? 0),
    });
    expect(res.dryRun).toBe(true);
    expect(res.url).toBe(`/dry-run/job-1`);
    expect(progress.at(-1)).toBe(1);
    if (platform === "vimeo") expect(res.payload.tags).toEqual(["tag"]);
    else expect(res.payload.caption).toContain("#tag");
  });

  it("still validates in dry-run", async () => {
    const p = getAdapter("x").publish(req({ content: { title: "", caption: "x".repeat(400), hashtags: [] } }), {
      account: null,
      dryRun: true,
    });
    await expect(p).rejects.toMatchObject({ code: "validation_failed", retryable: false });
  });

  it("real publish without an account fails", async () => {
    await expect(getAdapter("youtube").publish(req(), { account: null, dryRun: false })).rejects.toMatchObject({
      code: "no_account",
    });
  });
});

describe("account-specific rules", () => {
  it("X Premium relaxes caption length", () => {
    const content = { title: "", caption: "x".repeat(1000), hashtags: [] };
    expect(getAdapter("x").validate(content).ok).toBe(false);
    expect(getAdapter("x").validate(content, undefined, account({ metadata: { premium: true } })).ok).toBe(true);
  });

  it("TikTok uses the creator's max duration", () => {
    const acc = account({ platform: "tiktok", metadata: { maxVideoPostDurationSec: 60 } });
    const r = getAdapter("tiktok").validate({ title: "", caption: "c", hashtags: [] }, { ...media, durationSec: 90 }, acc);
    expect(r.errors.map((e) => e.code)).toContain("too_long");
  });
});

describe("OAuth", () => {
  it("throws not_configured without client credentials", () => {
    vi.stubEnv("YOUTUBE_CLIENT_ID", "");
    expect(getAdapter("youtube").isConfigured()).toBe(false);
    expect(() => getAdapter("youtube").getAuthUrl({ state: "s", redirectUri: "http://localhost/cb" })).toThrow(AdapterError);
  });

  it("builds a YouTube auth URL with offline access", () => {
    vi.stubEnv("YOUTUBE_CLIENT_ID", "yt-id");
    vi.stubEnv("YOUTUBE_CLIENT_SECRET", "yt-secret");
    const url = new URL(getAdapter("youtube").getAuthUrl({ state: "s1", redirectUri: "http://localhost/cb" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe("yt-id");
    expect(url.searchParams.get("state")).toBe("s1");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("scope")).toContain("youtube.upload");
  });

  it("uses client_key and comma scopes for TikTok", () => {
    vi.stubEnv("TIKTOK_CLIENT_KEY", "tk");
    vi.stubEnv("TIKTOK_CLIENT_SECRET", "ts");
    const url = new URL(getAdapter("tiktok").getAuthUrl({ state: "s", redirectUri: "http://localhost/cb" }));
    expect(url.searchParams.get("client_key")).toBe("tk");
    expect(url.searchParams.get("scope")).toBe("user.info.basic,video.upload,video.publish");
  });

  it("requires PKCE for X", () => {
    vi.stubEnv("X_CLIENT_ID", "xid");
    vi.stubEnv("X_CLIENT_SECRET", "xs");
    const x = getAdapter("x");
    expect(x.capabilities.pkce).toBe(true);
    expect(() => x.getAuthUrl({ state: "s", redirectUri: "http://l/cb" })).toThrow(/PKCE/);
    const { challenge } = createPkcePair();
    const url = new URL(x.getAuthUrl({ state: "s", redirectUri: "http://l/cb", codeChallenge: challenge }));
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
  });

  it("exchanges the code and fetches the profile (X, basic auth + PKCE)", async () => {
    vi.stubEnv("X_CLIENT_ID", "xid");
    vi.stubEnv("X_CLIENT_SECRET", "xs");
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/oauth2/token")) {
        expect(init?.method).toBe("POST");
        expect((init?.headers as Record<string, string>).Authorization).toMatch(/^Basic /);
        expect(String(init?.body)).toContain("code_verifier=ver");
        return Response.json({ access_token: "AT", refresh_token: "RT", expires_in: 7200, scope: "tweet.read tweet.write" });
      }
      if (u.endsWith("/2/users/me")) return Response.json({ data: { id: "42", username: "creator", name: "Creator" } });
      return new Response("not found", { status: 404 });
    });
    const creds = await getAdapter("x").handleCallback({
      code: "c",
      redirectUri: "http://l/cb",
      codeVerifier: "ver",
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(creds).toMatchObject({
      platform: "x",
      externalId: "42",
      displayName: "@creator",
      accessToken: "AT",
      refreshToken: "RT",
      scopes: ["tweet.read", "tweet.write"],
    });
    expect(new Date(creds.expiresAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("wraps token exchange failures as auth_failed", async () => {
    vi.stubEnv("LINKEDIN_CLIENT_ID", "id");
    vi.stubEnv("LINKEDIN_CLIENT_SECRET", "s");
    const fetchMock = vi.fn(async () => new Response("bad code", { status: 400 }));
    await expect(
      getAdapter("linkedin").handleCallback({ code: "c", redirectUri: "r", fetch: fetchMock as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "auth_failed" });
  });
});

const RUN = { uploadDir: "/tmp/u", simulatedDelayMs: 0, dryRunMode: "auto" as const };

describe("job runner", () => {
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    db = openDatabase(":memory:");
  });

  function postWithTargets(caption = "Hello") {
    const m = createMedia(db, { originalFilename: "a.mp4", storagePath: "a.mp4", mimeType: "video/mp4", sizeBytes: 5_000_000, durationSec: 30, width: 1080, height: 1920 });
    const post = createPost(db, { title: "T", caption, mediaId: m.id });
    upsertTarget(db, post.id, "tiktok", { settings: { privacyLevel: "PUBLIC_TO_EVERYONE" } });
    upsertTarget(db, post.id, "x");
    return post;
  }

  it("publishes dry-run jobs end to end", async () => {
    const post = postWithTargets();
    enqueuePublish(db, post.id, { dryRun: true });
    const a = await runNextJob(db, RUN);
    const b = await runNextJob(db, RUN);
    expect(a!.status).toBe("published");
    expect(b!.resultUrl).toBe(`/dry-run/${b!.id}`);
    expect(await runNextJob(db, RUN)).toBeNull();
    expect(getPost(db, post.id)!.status).toBe("published");
  });

  it("fails validation errors permanently and retries transient errors", async () => {
    const post = postWithTargets("y".repeat(500)); // too long for X only
    enqueuePublish(db, post.id, { dryRun: true });
    const results = [await runNextJob(db, RUN), await runNextJob(db, RUN)];
    const x = results.find((j) => j!.platform === "x")!;
    expect(x.status).toBe("failed");
    expect(x.error).toMatch(/280/);
    expect(getPost(db, post.id)!.status).toBe("partial");

    // Transient error → re-queued.
    registerAdapter(
      Object.assign(Object.create(getAdapter("x")), {
        publish: async () => {
          throw new Error("ECONNRESET");
        },
      }),
    );
    const post2 = postWithTargets();
    upsertTarget(db, post2.id, "tiktok", { enabled: false });
    const [job] = enqueuePublish(db, post2.id);
    const after = await runNextJob(db, RUN);
    expect(after!.id).toBe(job.id);
    expect(getJob(db, job.id)!.status).toBe("queued");
    expect(getJob(db, job.id)!.error).toBe("ECONNRESET");
  });
});
