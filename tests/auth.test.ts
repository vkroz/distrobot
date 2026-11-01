import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  checkCredentials,
  getAuthConfig,
  isPublicPath,
  safeNext,
  sessionFromRequest,
  signSession,
  verifySession,
} from "@/lib/auth";
import { POST as uploadMedia } from "@/app/api/media/route";
import { config as proxyConfig, proxy } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

const PROD = { NODE_ENV: "production", APP_USERNAME: "boss", APP_PASSWORD: "s3cret-pass", APP_SESSION_SECRET: "x".repeat(32) };

describe("auth config", () => {
  it("dev defaults to admin/admin with a dev secret and flags it", () => {
    const cfg = getAuthConfig({ NODE_ENV: "development" });
    expect(cfg).toMatchObject({ username: "admin", password: "admin", usingDefaultCredentials: true, usingDefaultSecret: true, disabledReason: null });
  });

  it("production requires username, password and secret", () => {
    expect(getAuthConfig({ NODE_ENV: "production" }).disabledReason).toMatch(/APP_USERNAME/);
    expect(getAuthConfig({ ...PROD, APP_SESSION_SECRET: undefined }).disabledReason).toMatch(/APP_SESSION_SECRET/);
    expect(getAuthConfig({ ...PROD, APP_SESSION_SECRET: "short" }).disabledReason).toMatch(/at least 16/);
    expect(getAuthConfig(PROD)).toMatchObject({ username: "boss", usingDefaultCredentials: false, disabledReason: null });
  });

  it("checks credentials (and refuses everything when disabled)", () => {
    const cfg = getAuthConfig(PROD);
    expect(checkCredentials(cfg, "boss", "s3cret-pass")).toBe(true);
    expect(checkCredentials(cfg, "boss", "wrong")).toBe(false);
    expect(checkCredentials(cfg, "admin", "admin")).toBe(false);
    expect(checkCredentials(getAuthConfig({ NODE_ENV: "production" }), "admin", "admin")).toBe(false);
  });
});

describe("session tokens", () => {
  const cfg = getAuthConfig(PROD);

  it("round-trips and expires", () => {
    const t0 = Date.parse("2026-01-01T00:00:00Z");
    const token = signSession(cfg, t0);
    expect(verifySession(cfg, token, t0 + 1000)).toMatchObject({ u: "boss" });
    expect(verifySession(cfg, token, t0 + SESSION_TTL_SEC * 1000 + 1)).toBeNull();
  });

  it("rejects tampering, other secrets and stale passwords", () => {
    const token = signSession(cfg);
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ u: "boss", iat: 0, exp: 9_999_999_999 })).toString("base64url");
    expect(verifySession(cfg, `${forged}.${sig}`)).toBeNull();
    expect(verifySession(cfg, `${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(verifySession(cfg, "garbage")).toBeNull();
    expect(verifySession(getAuthConfig({ ...PROD, APP_SESSION_SECRET: "y".repeat(32) }), token)).toBeNull();
    // Changing the password invalidates existing sessions.
    expect(verifySession(getAuthConfig({ ...PROD, APP_PASSWORD: "new-password" }), token)).toBeNull();
  });
});

describe("public paths and redirects", () => {
  it("only login, session, health and OAuth callbacks are public", () => {
    for (const p of ["/login", "/api/session", "/api/health", "/api/auth/youtube/callback"]) expect(isPublicPath(p)).toBe(true);
    for (const p of ["/", "/dashboard", "/compose", "/api/posts", "/api/auth/youtube/start", "/api/media/1", "/dry-run/x", "/api/jobs/run"]) {
      expect(isPublicPath(p)).toBe(false);
    }
  });

  it("safeNext only allows same-site paths", () => {
    expect(safeNext("/compose?draft=1")).toBe("/compose?draft=1");
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "", null]) expect(safeNext(bad)).toBe("/dashboard");
  });
});

describe("proxy", () => {
  const req = (path: string, cookie?: string) =>
    new NextRequest(new URL(path, "http://localhost:3000"), { headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {} });

  it("redirects pages to /login?next=… and returns 401 JSON for APIs", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const page = proxy(req("/compose?draft=abc"));
    expect(page.status).toBe(307);
    expect(page.headers.get("location")).toBe("http://localhost:3000/login?next=%2Fcompose%3Fdraft%3Dabc");
    const api = proxy(req("/api/posts"));
    expect(api.status).toBe(401);
    expect(await api.json()).toMatchObject({ error: expect.stringMatching(/Unauthorized/) });
  });

  it("lets public paths and valid sessions through", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(proxy(req("/api/health")).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req("/api/auth/tiktok/callback?code=1&state=2")).headers.get("x-middleware-next")).toBe("1");
    const token = signSession(getAuthConfig());
    expect(proxy(req("/api/posts", token)).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(req("/dashboard", "bogus.token")).status).toBe(307);
  });
});

describe("upload endpoint bypasses the proxy (body would be truncated at 10 MB) but stays protected", () => {
  // The matcher is a path-to-regexp pattern; as a plain anchored RegExp it behaves the same for these paths.
  const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);

  it("proxy runs on everything except the exact upload path and static assets", () => {
    for (const p of ["/", "/dashboard", "/compose", "/api/posts", "/api/media/abc", "/api/jobs/run", "/login"]) expect(matcher.test(p)).toBe(true);
    for (const p of ["/api/media", "/_next/static/chunk.js", "/favicon.ico", "/logo.png"]) expect(matcher.test(p)).toBe(false);
  });

  it("POST /api/media checks the session itself", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const body = new Blob(["x"]).stream();
    const res = await uploadMedia(
      new Request("http://localhost:3000/api/media?filename=a.mp4", { method: "POST", body, headers: { "content-type": "video/mp4" }, duplex: "half" } as RequestInit),
    );
    expect(res.status).toBe(401);
  });

  it("sessionFromRequest reads the cookie header", () => {
    vi.stubEnv("NODE_ENV", "development");
    const token = signSession(getAuthConfig());
    const r = (cookie?: string) => new Request("http://x/", { headers: cookie ? { cookie } : {} });
    expect(sessionFromRequest(r(`other=1; ${SESSION_COOKIE}=${token}; x=2`))).toMatchObject({ u: "admin" });
    expect(sessionFromRequest(r(`${SESSION_COOKIE}=nope`))).toBeNull();
    expect(sessionFromRequest(r())).toBeNull();
  });
});
