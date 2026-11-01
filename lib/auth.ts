import crypto from "node:crypto";

/**
 * Single-admin login: credentials from env, stateless HMAC-signed session cookie.
 *
 *   APP_USERNAME / APP_PASSWORD   — the one admin account
 *   APP_SESSION_SECRET            — HMAC key for session cookies (≥ 16 chars)
 *
 * Development: unset values fall back to admin / admin and a fixed dev secret (a warning is shown).
 * Production (NODE_ENV=production): all three are required, otherwise login is disabled.
 */

export const SESSION_COOKIE = "cp_session";
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60;
export const DEFAULT_USERNAME = "admin";
export const DEFAULT_PASSWORD = "admin";
const DEV_SECRET = "dev-only-insecure-session-secret-change-me";
const MIN_SECRET_LENGTH = 16;

export interface AuthConfig {
  username: string;
  password: string;
  secret: string;
  /** Default demo credentials are in use (dev only). */
  usingDefaultCredentials: boolean;
  usingDefaultSecret: boolean;
  /** When set, login is impossible (misconfigured production). */
  disabledReason: string | null;
}

export function getAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const prod = env.NODE_ENV === "production";
  const hasCreds = !!env.APP_USERNAME && !!env.APP_PASSWORD;
  const secret = env.APP_SESSION_SECRET ?? "";
  let disabledReason: string | null = null;
  if (prod && !hasCreds) disabledReason = "Login is disabled: set APP_USERNAME and APP_PASSWORD.";
  else if (prod && !secret) disabledReason = "Login is disabled: set APP_SESSION_SECRET.";
  else if (secret && secret.length < MIN_SECRET_LENGTH) {
    disabledReason = `Login is disabled: APP_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters.`;
  }
  return {
    username: hasCreds ? env.APP_USERNAME! : DEFAULT_USERNAME,
    password: hasCreds ? env.APP_PASSWORD! : DEFAULT_PASSWORD,
    secret: secret || DEV_SECRET,
    usingDefaultCredentials: !hasCreds,
    usingDefaultSecret: !secret,
    disabledReason,
  };
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** HMAC key also depends on the password, so changing the password invalidates existing sessions. */
function hmac(cfg: Pick<AuthConfig, "secret" | "password">, data: string): Buffer {
  const key = crypto.createHash("sha256").update(`${cfg.secret}\0${cfg.password}`).digest();
  return crypto.createHmac("sha256", key).update(data).digest();
}

export interface Session {
  u: string;
  iat: number;
  exp: number;
  /** Issue time in ms (for revocation by logout). */
  t?: number;
}

export function signSession(cfg: AuthConfig, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({ u: cfg.username, iat, exp: iat + SESSION_TTL_SEC, t: now } satisfies Session));
  return `${payload}.${b64url(hmac(cfg, payload))}`;
}

/**
 * @param validAfterMs sessions issued before this time are revoked (set by logout).
 */
export function verifySession(
  cfg: AuthConfig,
  token: string | undefined | null,
  now = Date.now(),
  validAfterMs = 0,
): Session | null {
  if (!token || cfg.disabledReason) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = hmac(cfg, payload);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (s.u !== cfg.username || typeof s.exp !== "number" || s.exp * 1000 <= now) return null;
    if ((s.t ?? s.iat * 1000) < validAfterMs) return null;
    return s;
  } catch {
    return null;
  }
}

/** Constant-time credential check. */
export function checkCredentials(cfg: AuthConfig, username: string, password: string): boolean {
  if (cfg.disabledReason) return false;
  const digest = (v: string) => crypto.createHash("sha256").update(v).digest();
  const userOk = crypto.timingSafeEqual(digest(username), digest(cfg.username));
  const passOk = crypto.timingSafeEqual(digest(password), digest(cfg.password));
  return userOk && passOk;
}

/** Paths reachable without a session. Static assets are excluded by the proxy matcher. */
export function isPublicPath(pathname: string): boolean {
  return (
    pathname === "/login" ||
    pathname === "/api/session" ||
    pathname === "/api/health" ||
    // OAuth providers redirect here; protected by the single-use `state` created by a logged-in user.
    /^\/api\/auth\/[a-z]+\/callback$/.test(pathname)
  );
}

/**
 * Only allow same-origin relative redirect targets (after login / OAuth). Resolves the value the
 * way a browser would — which strips tabs/newlines, so "/\t/evil.example" becomes "//evil.example" —
 * and accepts it only if it stays on our origin. Returns the normalized path.
 */
export function safeNext(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/")) return fallback;
  const base = "http://same-origin.invalid";
  try {
    const url = new URL(next, base);
    if (url.origin !== base) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * CSRF guard for cookie-authenticated, state-changing requests.
 *
 * SameSite=Lax already stops cross-*site* requests from carrying the session cookie, but not
 * same-site ones (another port on localhost, a sibling subdomain), and several endpoints accept
 * "simple" requests (text/plain bodies or no body). Browsers send `Origin` on all cross-origin
 * POST/PUT/PATCH/DELETE requests (and `Sec-Fetch-Site`), so we require it to be our own origin.
 * Non-browser clients (curl, scripts) send neither header and are allowed.
 */
export function isCrossOriginWrite(req: Request, env: Record<string, string | undefined> = process.env): boolean {
  if (!STATE_CHANGING.has(req.method.toUpperCase())) return false;
  const origin = req.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return true; // "null" (sandboxed/file) or garbage
    }
    const allowed = new Set<string>();
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    if (host) allowed.add(host.split(",")[0].trim());
    allowed.add(new URL(req.url).host);
    if (env.APP_URL) {
      try {
        allowed.add(new URL(env.APP_URL).host);
      } catch {
        /* ignore malformed APP_URL */
      }
    }
    return !allowed.has(originHost);
  }
  const site = req.headers.get("sec-fetch-site");
  return site === "cross-site" || site === "same-site";
}

export function sessionCookie(token: string, secure: boolean) {
  return {
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    path: "/",
    maxAge: SESSION_TTL_SEC,
  };
}

export const isHttps = (req: Request) =>
  new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";

/** Parse the session cookie from a raw request (for routes the proxy deliberately skips). */
export function sessionFromRequest(req: Request, cfg: AuthConfig = getAuthConfig(), validAfterMs = 0): Session | null {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  let token: string | null = null;
  try {
    token = m ? decodeURIComponent(m[1]) : null;
  } catch {
    return null; // malformed %-encoding → not a session (not a 500)
  }
  return verifySession(cfg, token, Date.now(), validAfterMs);
}

// ---------------------------------------------------------------------------
// Login throttling — global, not per-IP: client IPs / X-Forwarded-For are spoofable, and a
// per-IP lockout behind no proxy would let anyone lock the admin out. Instead, once failures
// pile up, attempts are serialized with a growing delay (max ~1 attempt per maxDelayMs), and
// excess concurrent attempts are rejected fast (429). The real admin can still always log in.
// In-memory, so it resets on restart (fine for a single instance).
// ---------------------------------------------------------------------------

export const loginThrottle = {
  windowMs: 15 * 60_000,
  /** Failures within the window before slowing down. */
  freeFailures: 5,
  maxDelayMs: 5_000,
  /** Max login attempts waiting in line. */
  maxPending: 20,
};

let failureTimes: number[] = [];
let pending = 0;
let tail: Promise<void> = Promise.resolve();

/** Delay applied to the next attempt, given recent failures. */
export function loginDelayMs(now = Date.now()): number {
  failureTimes = failureTimes.filter((t) => now - t < loginThrottle.windowMs);
  const excess = failureTimes.length - loginThrottle.freeFailures;
  return excess < 0 ? 0 : Math.min(loginThrottle.maxDelayMs, 250 * 2 ** excess);
}

/**
 * Wait for a login slot. Resolves to a `done(success)` callback that must be called once the
 * credentials were checked, or `null` if too many attempts are already queued.
 */
export async function acquireLoginSlot(): Promise<((success: boolean) => void) | null> {
  if (pending >= loginThrottle.maxPending) return null;
  pending++;
  const prev = tail;
  let release!: () => void;
  tail = new Promise<void>((r) => (release = r));
  await prev;
  const delay = loginDelayMs();
  if (delay) await new Promise((r) => setTimeout(r, delay));
  return (success: boolean) => {
    if (!success) {
      failureTimes.push(Date.now());
      if (failureTimes.length > 1000) failureTimes = failureTimes.slice(-1000);
    }
    pending--;
    release();
  };
}

export function resetLoginThrottle(): void {
  failureTimes = [];
  pending = 0;
  tail = Promise.resolve();
}
