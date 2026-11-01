/**
 * Contract tests: every registered adapter must honor the same PlatformAdapter guarantees,
 * regardless of platform. New adapters are covered automatically via the registry.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { AdapterError, getAdapter, listAdapters, type PublishRequest } from "@/lib/adapters";
import { PLATFORM_RULES } from "@/lib/platforms/rules";
import { PLATFORM_IDS, type ConnectedAccount, type Media, type PlatformId } from "@/lib/types";

const ROOT = path.resolve(__dirname, "..");
let dir: string;
let videoPath: string;

beforeAll(async () => {
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), "contract-"));
  videoPath = path.join(dir, "v.mp4");
  await fsp.writeFile(videoPath, Buffer.alloc(64 * 1024, 1));
});
afterAll(() => fsp.rm(dir, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

// Valid for every platform: vertical 30s mp4, small file, short text.
const media: Media = {
  id: "m",
  kind: "video",
  originalFilename: "v.mp4",
  storagePath: "v.mp4",
  mimeType: "video/mp4",
  sizeBytes: 10_000_000,
  durationSec: 30,
  width: 1080,
  height: 1920,
  checksum: null,
  createdAt: "",
};

const req = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  jobId: "job-c",
  content: { title: "Contract test", caption: "Hello", hashtags: ["test"] },
  media,
  mediaPath: videoPath,
  visibility: "public",
  settings: {},
  ...over,
});

const account = (platform: PlatformId): ConnectedAccount => ({
  id: "acc",
  platform,
  externalId: "123",
  displayName: "@creator",
  accessToken: "AT",
  refreshToken: "RT",
  expiresAt: null,
  scopes: [],
  // Superset of what individual adapters read from metadata.
  metadata: { authorUrn: "urn:li:person:123", pages: [{ id: "p1", name: "Page", accessToken: "PT" }], username: "creator" },
  createdAt: "",
  updatedAt: "",
});

/** fetch that fails the test if called. */
const forbiddenFetch = vi.fn(async () => {
  throw new Error("network must not be used");
}) as unknown as typeof fetch;

function configure(platform: PlatformId) {
  for (const name of getAdapter(platform).credentialEnvVars) vi.stubEnv(name, `test-${name.toLowerCase()}`);
}

describe("registry", () => {
  it("has exactly one adapter per platform", () => {
    expect(listAdapters().map((a) => a.platform).sort()).toEqual([...PLATFORM_IDS].sort());
  });
});

describe.each(PLATFORM_IDS)("%s adapter contract", (platform) => {
  const adapter = () => getAdapter(platform);

  it("identifies itself consistently with the platform rules", () => {
    const a = adapter();
    expect(a.platform).toBe(platform);
    expect(a.displayName).toBe(PLATFORM_RULES[platform].displayName);
    expect(a.getRules().platform).toBe(platform);
    expect(Object.keys(a.capabilities).sort()).toEqual(["nativeScheduling", "pkce", "publish", "refreshTokens", "thumbnail"]);
    expect(a.capabilities.publish).toBe(true);
  });

  it("declares credential env vars that are documented in .env.example", () => {
    const vars = adapter().credentialEnvVars;
    expect(vars).toHaveLength(2);
    const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    for (const v of vars) expect(example).toMatch(new RegExp(`^${v}=$`, "m"));
  });

  it("is configured only when all credential env vars are set", () => {
    const [id, secret] = adapter().credentialEnvVars;
    vi.stubEnv(id, "");
    vi.stubEnv(secret, "");
    expect(adapter().isConfigured()).toBe(false);
    vi.stubEnv(id, "x");
    expect(adapter().isConfigured()).toBe(false);
    vi.stubEnv(secret, "y");
    expect(adapter().isConfigured()).toBe(true);
  });

  it("getAuthUrl: not_configured without credentials; https URL carrying state + redirect when configured", () => {
    for (const v of adapter().credentialEnvVars) vi.stubEnv(v, "");
    expect(() => adapter().getAuthUrl({ state: "s", redirectUri: "http://localhost/cb", codeChallenge: "c" })).toThrow(
      expect.objectContaining({ code: "not_configured" }),
    );
    configure(platform);
    const a = adapter();
    if (a.capabilities.pkce) {
      expect(() => a.getAuthUrl({ state: "s", redirectUri: "http://localhost/cb" })).toThrow(AdapterError);
    }
    const url = new URL(a.getAuthUrl({ state: "st4te", redirectUri: "http://localhost/cb", codeChallenge: "chal" }));
    expect(url.protocol).toBe("https:");
    expect(url.searchParams.get("state")).toBe("st4te");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost/cb");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBeTruthy();
    expect([...url.searchParams.values()]).toContain(`test-${a.credentialEnvVars[0].toLowerCase()}`);
  });

  it("validate returns a ValidationResult for its platform", () => {
    const r = adapter().validate(req().content, media);
    expect(r.platform).toBe(platform);
    expect(r.ok).toBe(true);
    expect(r.effective.caption).toContain("Hello");
  });

  it("dry-run publish simulates without network, reports progress and returns a preview link", async () => {
    const progress: number[] = [];
    const res = await adapter().publish(req(), {
      account: null,
      dryRun: true,
      simulatedDelayMs: 0,
      fetch: forbiddenFetch,
      onProgress: (p) => progress.push(p.fraction ?? 0),
    });
    expect(res).toMatchObject({ dryRun: true, url: "/dry-run/job-c", externalId: "dry-run-job-c" });
    expect(res.payload).toMatchObject({ visibility: "public" });
    expect(progress.at(-1)).toBe(1);
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  it("rejects invalid content before any network call (validation_failed, not retryable)", async () => {
    const bad = req({ media: { ...media, durationSec: 100_000, mimeType: "video/x-unknown" } });
    for (const dryRun of [true, false]) {
      await expect(
        adapter().publish(bad, { account: account(platform), dryRun, simulatedDelayMs: 0, fetch: forbiddenFetch }),
      ).rejects.toMatchObject({ code: "validation_failed", retryable: false });
    }
    expect(forbiddenFetch).not.toHaveBeenCalled();
  });

  it("real publish without an account fails with no_account before any network call", async () => {
    await expect(adapter().publish(req(), { account: null, dryRun: false, fetch: forbiddenFetch })).rejects.toMatchObject({
      code: "no_account",
    });
  });

  it("classifies upstream 5xx and network errors as retryable AdapterErrors", async () => {
    const f503 = vi.fn(async () => new Response("unavailable", { status: 503 })) as unknown as typeof fetch;
    const err503 = await adapter().publish(req(), { account: account(platform), dryRun: false, fetch: f503 }).catch((e) => e);
    expect(err503).toBeInstanceOf(AdapterError);
    expect(err503.retryable).toBe(true);

    const fNet = vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const errNet = await adapter().publish(req(), { account: account(platform), dryRun: false, fetch: fNet }).catch((e) => e);
    expect(errNet).toBeInstanceOf(AdapterError);
    expect(errNet.retryable).toBe(true);
  });

  it("classifies 401 as auth_failed (so the runner refreshes the token)", async () => {
    const f401 = vi.fn(async () => new Response("unauthorized", { status: 401 })) as unknown as typeof fetch;
    await expect(adapter().publish(req(), { account: account(platform), dryRun: false, fetch: f401 })).rejects.toMatchObject({
      code: "auth_failed",
    });
  });

  it("handleCallback maps a rejected code exchange to auth_failed", async () => {
    configure(platform);
    const f = vi.fn(async () => new Response("invalid_grant", { status: 400 })) as unknown as typeof fetch;
    await expect(
      adapter().handleCallback({ code: "c", redirectUri: "http://localhost/cb", codeVerifier: "v", fetch: f }),
    ).rejects.toMatchObject({ code: "auth_failed" });
  });

  it("refreshAccessToken: not_configured without credentials; auth_failed without a refresh token", async () => {
    for (const v of adapter().credentialEnvVars) vi.stubEnv(v, "");
    await expect(adapter().refreshAccessToken(account(platform), forbiddenFetch)).rejects.toMatchObject({ code: "not_configured" });
    configure(platform);
    await expect(
      adapter().refreshAccessToken({ ...account(platform), refreshToken: null }, forbiddenFetch),
    ).rejects.toMatchObject({ code: "auth_failed" });
  });
});

describe("configuration docs", () => {
  it("every env var read by app code is documented in .env.example", () => {
    const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
    const files = ["app", "lib", "components"]
      .flatMap((d) => fs.readdirSync(path.join(ROOT, d), { recursive: true, encoding: "utf8" }).map((f) => path.join(ROOT, d, f)))
      .filter((f) => /\.tsx?$/.test(f));
    const used = new Set<string>();
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|env\.([A-Z][A-Z0-9_]+)|envInt\("([A-Z0-9_]+)"/g)) {
        used.add(m[1] ?? m[2] ?? m[3]);
      }
    }
    // Set by Next.js itself.
    for (const internal of ["NEXT_PHASE", "NEXT_RUNTIME"]) used.delete(internal);
    expect(used.size).toBeGreaterThan(5);
    const missing = [...used].filter((v) => !new RegExp(`^#?\\s*${v}=`, "m").test(example));
    expect(missing).toEqual([]);
  });
});
