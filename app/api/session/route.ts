import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { revokeAllSessions, sessionsValidAfter } from "@/lib/auth-store";
import {
  SESSION_COOKIE,
  acquireLoginSlot,
  checkCredentials,
  getAuthConfig,
  isHttps,
  safeNext,
  sessionCookie,
  signSession,
  verifySession,
} from "@/lib/auth";

/** Current session + auth configuration warnings (public; used by the nav and login page). */
export async function GET() {
  const cfg = getAuthConfig();
  const session = verifySession(cfg, (await cookies()).get(SESSION_COOKIE)?.value, Date.now(), sessionsValidAfter());
  return Response.json({
    authenticated: !!session,
    username: session?.u ?? null,
    usingDefaultCredentials: cfg.usingDefaultCredentials,
    usingDefaultSecret: cfg.usingDefaultSecret,
    disabledReason: cfg.disabledReason,
  });
}

/**
 * Log in. Accepts JSON `{username, password}` (→ 200/401 JSON) or an HTML form post
 * (→ 303 redirect to `next` or back to /login?error=…).
 */
export async function POST(req: Request) {
  const cfg = getAuthConfig();
  const isForm = (req.headers.get("content-type") ?? "").includes("form");
  let username = "";
  let password = "";
  let next = "/dashboard";
  try {
    if (isForm) {
      const f = await req.formData();
      username = String(f.get("username") ?? "");
      password = String(f.get("password") ?? "");
      next = safeNext(String(f.get("next") ?? ""));
    } else {
      const b = (await req.json()) as Record<string, unknown>;
      username = String(b.username ?? "");
      password = String(b.password ?? "");
    }
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  // Brute-force protection: serialized + increasingly delayed once failures accumulate.
  const done = await acquireLoginSlot();
  const busy = done === null;
  const ok = !busy && checkCredentials(cfg, username, password);
  done?.(ok || !!cfg.disabledReason);
  if (!ok) {
    const error = busy
      ? "Too many login attempts right now. Please wait a moment and try again."
      : (cfg.disabledReason ?? "Invalid username or password");
    if (isForm) {
      const url = new URL("/login", req.url);
      url.searchParams.set("error", error);
      if (next !== "/dashboard") url.searchParams.set("next", next);
      return NextResponse.redirect(url, 303);
    }
    return Response.json({ error }, { status: busy ? 429 : cfg.disabledReason ? 503 : 401 });
  }

  const res = isForm
    ? NextResponse.redirect(new URL(next, req.url), 303)
    : NextResponse.json({ ok: true, username: cfg.username });
  res.cookies.set(sessionCookie(signSession(cfg), isHttps(req)));
  return res;
}

/** Log out — revokes every existing session (single admin), not just this browser's cookie. */
export async function DELETE() {
  // Only an authenticated caller may revoke (the endpoint is public; don't let anyone log the admin out).
  const cfg = getAuthConfig();
  if (verifySession(cfg, (await cookies()).get(SESSION_COOKIE)?.value, Date.now(), sessionsValidAfter())) {
    revokeAllSessions();
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
