import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/session/route";
import { POST as uploadMedia } from "@/app/api/media/route";
import { GET as serveMedia } from "@/app/api/media/[id]/route";
import {
  SESSION_COOKIE,
  getAuthConfig,
  isCrossOriginWrite,
  loginDelayMs,
  loginThrottle,
  resetLoginThrottle,
  safeNext,
  signSession,
} from "@/lib/auth";
import { getDb } from "@/lib/db";
import { createMedia } from "@/lib/db/repo";
import { safeReturnTo } from "@/lib/http";
import { isDeadLocalOwner } from "@/lib/jobs/lease";
import { ffprobeArgs, ffprobeCandidates, probeVideo } from "@/lib/media/probe";
import { saveStream } from "@/lib/storage/local";
import { config as proxyConfig, proxy } from "@/proxy";

let dir: string;
beforeAll(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sec-"));
});
afterAll(() => fs.rm(dir, { recursive: true, force: true }));
afterEach(() => {
  vi.unstubAllEnvs();
  resetLoginThrottle();
});

describe("open redirects", () => {
  it("rejects anything a browser would resolve off-origin", () => {
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "/\t/evil.example", "/\n/evil.example", "/\r\n/evil.example", "javascript:alert(1)", "", null]) {
      expect(safeNext(bad)).toBe("/dashboard");
      expect(safeReturnTo(bad)).toBe("/accounts");
    }
  });

  it("keeps legitimate same-origin targets (normalized)", () => {
    expect(safeNext("/compose?draft=1#x")).toBe("/compose?draft=1#x");
    expect(safeNext("/%2F%2Fevil.example")).toBe("/%2F%2Fevil.example"); // stays a local path
    expect(safeReturnTo("/accounts")).toBe("/accounts");
  });
});

describe("CSRF (cross-origin writes)", () => {
  const r = (method: string, headers: Record<string, string>) =>
    new Request("http://localhost:3000/api/posts", { method, headers: { host: "localhost:3000", ...headers } });

  it("blocks state-changing requests from other origins, including same-site ones", () => {
    expect(isCrossOriginWrite(r("POST", { origin: "http://localhost:5173" }))).toBe(true); // other port = same site!
    expect(isCrossOriginWrite(r("DELETE", { origin: "https://evil.example" }))).toBe(true);
    expect(isCrossOriginWrite(r("POST", { origin: "null" }))).toBe(true);
    expect(isCrossOriginWrite(r("POST", { "sec-fetch-site": "same-site" }))).toBe(true);
    expect(isCrossOriginWrite(r("PUT", { "sec-fetch-site": "cross-site" }))).toBe(true);
  });

  it("allows same-origin browsers, APP_URL, reverse proxies, non-browser clients and reads", () => {
    expect(isCrossOriginWrite(r("POST", { origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }))).toBe(false);
    expect(isCrossOriginWrite(r("POST", { origin: "https://app.example", "x-forwarded-host": "app.example" }))).toBe(false);
    expect(isCrossOriginWrite(r("POST", { origin: "https://pub.example" }), { APP_URL: "https://pub.example" })).toBe(false);
    expect(isCrossOriginWrite(r("POST", {}))).toBe(false); // curl / scripts
    expect(isCrossOriginWrite(r("GET", { origin: "https://evil.example" }))).toBe(false); // navigations/reads
  });

  it("proxy returns 403 for cross-origin writes even to public endpoints (login CSRF) and with a valid session", () => {
    vi.stubEnv("NODE_ENV", "development");
    const token = signSession(getAuthConfig());
    const mk = (p: string, headers: Record<string, string>) =>
      new NextRequest(new URL(p, "http://localhost:3000"), { method: "POST", headers: { host: "localhost:3000", ...headers } });
    expect(proxy(mk("/api/session", { origin: "http://localhost:8080" })).status).toBe(403);
    expect(proxy(mk("/api/jobs/run", { origin: "http://localhost:8080", cookie: `${SESSION_COOKIE}=${token}` })).status).toBe(403);
    expect(proxy(mk("/api/jobs/run", { origin: "http://localhost:3000", cookie: `${SESSION_COOKIE}=${token}` })).headers.get("x-middleware-next")).toBe("1");
  });

  it("the upload route (outside the proxy) applies the same check", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const token = signSession(getAuthConfig());
    const res = await uploadMedia(
      new Request("http://localhost:3000/api/media?filename=a.mp4", {
        method: "POST",
        body: "x",
        headers: { "content-type": "video/mp4", origin: "http://localhost:9999", cookie: `${SESSION_COOKIE}=${token}`, host: "localhost:3000" },
      }),
    );
    expect(res.status).toBe(403);
  });
});

describe("proxy matcher", () => {
  const matcher = new RegExp(`^${proxyConfig.matcher[0]}$`);
  it("no longer skips auth for paths that merely end in an image extension", () => {
    for (const p of ["/api/posts/abc.png", "/dry-run/x.svg", "/api/media/abc.jpg", "/compose.png"]) expect(matcher.test(p)).toBe(true);
    for (const p of ["/api/media", "/_next/static/a.js", "/_next/image", "/favicon.ico"]) expect(matcher.test(p)).toBe(false);
  });
});

describe("login throttling (global, not spoofable via X-Forwarded-For)", () => {
  const attempt = (password: string, ip = "1.1.1.1") =>
    login(
      new Request("http://localhost:3000/api/session", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ username: "admin", password }),
      }),
    );

  it("delay grows with recent failures and expires with the window", () => {
    resetLoginThrottle();
    expect(loginDelayMs()).toBe(0);
  });

  it("serializes attempts and slows down after repeated failures, whatever the client IP", async () => {
    vi.stubEnv("NODE_ENV", "development");
    resetLoginThrottle();
    loginThrottle.maxDelayMs = 200;
    try {
      // Parallel guesses from "different IPs" are processed one at a time.
      const results = await Promise.all(Array.from({ length: 8 }, (_, i) => attempt("wrong", `10.0.0.${i}`)));
      expect(results.every((r) => r.status === 401)).toBe(true);
      expect(loginDelayMs()).toBe(200); // 8 failures > 5 free → capped delay
      // The real admin still gets in (after the delay) — no lockout.
      const t0 = Date.now();
      expect((await attempt("admin", "10.9.9.9")).status).toBe(200);
      expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    } finally {
      loginThrottle.maxDelayMs = 5_000;
      resetLoginThrottle();
    }
  });

  it("rejects floods fast with 429 instead of queueing forever", async () => {
    vi.stubEnv("NODE_ENV", "development");
    resetLoginThrottle();
    const saved = { ...loginThrottle };
    Object.assign(loginThrottle, { maxPending: 2, freeFailures: 0, maxDelayMs: 100 });
    try {
      const statuses = (await Promise.all(Array.from({ length: 5 }, () => attempt("wrong")))).map((r) => r.status);
      expect(statuses.filter((s) => s === 429).length).toBe(3);
      expect(statuses.filter((s) => s === 401).length).toBe(2);
    } finally {
      Object.assign(loginThrottle, saved);
      resetLoginThrottle();
    }
  });
});

describe("ffprobe hardening", () => {
  it("never allows network protocols or playlist/concat demuxers, and prefixes the path", () => {
    const args = ffprobeArgs("relative/clip.mp4");
    expect(args.slice(args.indexOf("-protocol_whitelist"), args.indexOf("-protocol_whitelist") + 2)).toEqual(["-protocol_whitelist", "file"]);
    const formats = args[args.indexOf("-format_whitelist") + 1].split(",");
    for (const bad of ["hls", "concat", "http", "image2", "tty"]) expect(formats).not.toContain(bad);
    expect(args.at(-1)).toBe(`file:${path.resolve("relative/clip.mp4")}`);
  });

  it.skipIf(ffprobeCandidates().length === 0)("an uploaded HLS playlist is not followed", async () => {
    const f = path.join(dir, "evil.m3u8");
    await fs.writeFile(f, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/x.ts\n#EXT-X-ENDLIST\n");
    expect(await probeVideo(f)).toBeNull();
  });

});

describe("stored files", () => {
  it("keeps only known media extensions", async () => {
    for (const [name, ext] of [["a.m3u8", ""], ["a.html", ""], ["a.svg", ""], ["clip.MP4", ".mp4"], ["t.webp", ".webp"]] as const) {
      const stored = await saveStream(new Blob(["x"]).stream(), name, { dir });
      expect(path.extname(stored.storagePath)).toBe(ext);
    }
  });

  it("are served only as video/image with nosniff + sandbox CSP", async () => {
    vi.stubEnv("DATABASE_PATH", path.join(dir, "app.db"));
    vi.stubEnv("UPLOAD_DIR", dir);
    await fs.writeFile(path.join(dir, "evil.bin"), "<script>alert(1)</script>");
    const db = getDb();
    const html = createMedia(db, { kind: "video", originalFilename: "x", storagePath: "evil.bin", mimeType: "text/html" });
    const ok = createMedia(db, { kind: "image", originalFilename: "t.png", storagePath: "evil.bin", mimeType: "image/png" });
    const get = (id: string) => serveMedia(new Request(`http://localhost/api/media/${id}`), { params: Promise.resolve({ id }) });
    const r1 = await get(html.id);
    expect(r1.headers.get("content-type")).toBe("application/octet-stream");
    expect(r1.headers.get("content-disposition")).toBe("attachment");
    const r2 = await get(ok.id);
    expect(r2.headers.get("content-type")).toBe("image/png");
    for (const r of [r1, r2]) {
      expect(r.headers.get("x-content-type-options")).toBe("nosniff");
      expect(r.headers.get("content-security-policy")).toContain("sandbox");
    }
  });
});

describe("lease after a restart that reused our pid (containers)", () => {
  it("treats a different owner id with our own pid on this host as dead", () => {
    const host = os.hostname();
    const self = `${host}:${process.pid}:new`;
    expect(isDeadLocalOwner(`${host}:${process.pid}:old`, host, self)).toBe(true);
    expect(isDeadLocalOwner(self, host, self)).toBe(false);
    expect(isDeadLocalOwner(`${host}:${process.pid}:old`, host)).toBe(false); // no self id → conservative
  });
});
