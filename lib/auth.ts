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
}

export function signSession(cfg: AuthConfig, now = Date.now()): string {
  const iat = Math.floor(now / 1000);
  const payload = b64url(JSON.stringify({ u: cfg.username, iat, exp: iat + SESSION_TTL_SEC } satisfies Session));
  return `${payload}.${b64url(hmac(cfg, payload))}`;
}

export function verifySession(cfg: AuthConfig, token: string | undefined | null, now = Date.now()): Session | null {
  if (!token || cfg.disabledReason) return null;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = hmac(cfg, payload);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if (s.u !== cfg.username || typeof s.exp !== "number" || s.exp * 1000 <= now) return null;
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

/** Only allow same-site relative redirect targets after login. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/dashboard";
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
export function sessionFromRequest(req: Request, cfg: AuthConfig = getAuthConfig()): Session | null {
  const cookie = req.headers.get("cookie") ?? "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  return verifySession(cfg, m ? decodeURIComponent(m[1]) : null);
}
