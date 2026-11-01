import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, getAuthConfig, isPublicPath, verifySession } from "@/lib/auth";

/**
 * Login protection for every page and API route (Next 16 "proxy", formerly middleware).
 * Public: /login, /api/session, /api/health, OAuth callbacks, static assets.
 */
export function proxy(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const session = verifySession(getAuthConfig(), request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized: log in first (POST /api/session)" }, { status: 401 });
  }
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + search);
  return NextResponse.redirect(login);
}

export const config = {
  // Everything except Next internals, static files and the upload endpoint.
  // `/api/media` (exact path) is excluded on purpose: requests that pass through the proxy have
  // their body buffered in memory and silently truncated at `proxyClientMaxBodySize` (10 MB),
  // which would corrupt video uploads. That route checks the session itself and streams to disk.
  // `/api/media/<id>` (file download) is still protected here.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/media$|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
