import fs from "node:fs/promises";
import { AdapterError } from "./types";

export interface RequestOptions {
  /** Non-2xx statuses that should be returned instead of thrown (e.g. 308 for resumable uploads). */
  allowStatuses?: number[];
  platform: string;
}

/** Map an HTTP failure to an AdapterError with a sensible retry policy. */
export function errorFromResponse(platform: string, status: number, body: string): AdapterError {
  const snippet = body.slice(0, 500);
  const msg = `${platform} API ${status}: ${snippet}`;
  if (status === 401) return new AdapterError("auth_failed", msg, false, { status });
  if (status === 403 && /quota|limitExceeded|uploadLimit|rateLimit/i.test(body)) {
    return new AdapterError("quota_exceeded", msg, false, { status });
  }
  if (status === 408 || status === 429) return new AdapterError("rate_limited", msg, true, { status });
  if (status >= 500) return new AdapterError("upstream_error", msg, true, { status });
  return new AdapterError("upstream_error", msg, false, { status });
}

/** fetch wrapper: network errors are retryable, HTTP errors are classified. */
export async function request(
  f: typeof fetch,
  url: string,
  init: RequestInit,
  opts: RequestOptions,
): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch (err) {
    if ((err as Error).name === "AbortError") throw new AdapterError("aborted", "Request aborted", true);
    throw new AdapterError("upstream_error", `${opts.platform} network error: ${(err as Error).message}`, true);
  }
  if (res.ok || opts.allowStatuses?.includes(res.status)) return res;
  throw errorFromResponse(opts.platform, res.status, await res.text().catch(() => ""));
}

export async function requestJson<T>(f: typeof fetch, url: string, init: RequestInit, opts: RequestOptions): Promise<T> {
  const res = await request(f, url, init, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : {}) as T;
}

/** Read `length` bytes starting at `offset` (short read at EOF). */
export async function readFileChunk(path: string, offset: number, length: number): Promise<Buffer> {
  const fh = await fs.open(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new AdapterError("aborted", "Aborted", true));
    });
  });
}

/**
 * Poll `check` until it returns a non-undefined value. Throws a retryable error on timeout
 * (the platform may still be processing; a retry can pick up from a checkpoint).
 */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  opts: { intervalMs: number; timeoutMs: number; platform: string; signal?: AbortSignal },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() + opts.intervalMs > deadline) {
      throw new AdapterError("upstream_error", `${opts.platform} processing timed out`, true);
    }
    await sleep(opts.intervalMs, opts.signal);
  }
}

export const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });
