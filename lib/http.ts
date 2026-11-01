import { safeNext } from "@/lib/auth";

/** Small helpers shared by route handlers. */

export const json = (data: unknown, status = 200) => Response.json(data, { status });

export const errorJson = (message: string, status: number, extra: Record<string, unknown> = {}) =>
  Response.json({ error: message, ...extra }, { status });

/** Base URL used for OAuth redirect URIs. */
export function appUrl(req?: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  return req ? new URL(req.url).origin : "http://localhost:3000";
}

/** Only allow same-origin relative redirects (see safeNext). */
export function safeReturnTo(v: string | null | undefined, fallback = "/accounts"): string {
  return safeNext(v, fallback);
}

/** Parse a single `Range: bytes=a-b` header. Returns null if absent/unsupported, "invalid" if unsatisfiable. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null | "invalid" {
  if (!header) return null;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (m[1] === "" && m[2] === "")) return null; // multi-range or garbage → full response
  let start: number;
  let end: number;
  if (m[1] === "") {
    // suffix range: last N bytes
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}
