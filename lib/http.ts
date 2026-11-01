/** Small helpers shared by route handlers. */

export const json = (data: unknown, status = 200) => Response.json(data, { status });

export const errorJson = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  Response.json({ error: message, ...extra }, { status });

/** Base URL used for OAuth redirect URIs. */
export function appUrl(req?: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  return req ? new URL(req.url).origin : "http://localhost:3000";
}

/** Only allow same-site relative redirects. */
export function safeReturnTo(v: string | null | undefined, fallback = "/accounts"): string {
  return v && v.startsWith("/") && !v.startsWith("//") ? v : fallback;
}
