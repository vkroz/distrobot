import fs from "node:fs/promises";
import type { ConnectedAccount } from "@/lib/types";
import type { PlatformRuleOverrides } from "@/lib/platforms/rules";
import type { ValidationResult } from "@/lib/platforms/validate";
import { BaseAdapter, type Profile } from "../base";
import { bearer, readFileChunk, request, requestJson, sleep } from "../http";
import type { OAuthConfig, TokenResponse } from "../oauth";
import { AdapterError, type DoPublishResult, type PublishContext, type PublishRequest } from "../types";

const API = "https://api.x.com/2";
const MB = 1024 * 1024;

export interface XOptions {
  /** APPEND segment size (X allows up to 5 MB per segment). */
  chunkSize?: number;
  /** Fixed poll interval; defaults to the API's check_after_secs. */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface XCheckpoint {
  mediaId: string;
  nextSegment: number;
  finalized: boolean;
}

interface ProcessingInfo {
  state: "pending" | "in_progress" | "succeeded" | "failed";
  check_after_secs?: number;
  progress_percent?: number;
  error?: { message?: string; name?: string };
}

/**
 * X API v2 — chunked media upload, then create a post.
 *   1. POST /2/media/upload/initialize {media_type, total_bytes, media_category:"tweet_video"} → id
 *   2. POST /2/media/upload/{id}/append  (multipart: media, segment_index) per chunk
 *   3. POST /2/media/upload/{id}/finalize → processing_info
 *   4. GET  /2/media/upload?command=STATUS&media_id=… until succeeded (honors check_after_secs)
 *   5. POST /2/tweets {text, media:{media_ids:[id]}}
 * Docs: https://docs.x.com/x-api/media/upload-media
 * Shapes follow the public docs but are unverified against the live API.
 */
export class XAdapter extends BaseAdapter {
  readonly platform = "x" as const;
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    clientIdEnv: "X_CLIENT_ID",
    clientSecretEnv: "X_CLIENT_SECRET",
    tokenAuth: "basic",
    pkce: true,
  };

  constructor(private readonly opts: XOptions = {}) {
    super();
  }

  /** Premium subscribers get long posts and longer videos. */
  protected ruleOverrides(account?: ConnectedAccount | null): PlatformRuleOverrides | undefined {
    if (account?.metadata?.premium !== true) return undefined;
    return { caption: { maxLength: 25_000 }, video: { maxDurationSec: 3 * 60 * 60 } };
  }

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const me = await this.getJson<{ data: { id: string; username: string; name: string } }>(
      f,
      "https://api.x.com/2/users/me",
      token.access_token,
    );
    return { externalId: me.data.id, displayName: `@${me.data.username}`, metadata: { name: me.data.name } };
  }

  private json<T>(f: typeof fetch, url: string, token: string, body: unknown, signal?: AbortSignal): Promise<T> {
    return requestJson<T>(
      f,
      url,
      { method: "POST", headers: { ...bearer(token), "Content-Type": "application/json" }, body: JSON.stringify(body), signal },
      { platform: this.displayName },
    );
  }

  protected async doPublish(
    req: PublishRequest,
    ctx: PublishContext & { account: ConnectedAccount },
    validation: ValidationResult,
  ): Promise<DoPublishResult> {
    const f = ctx.fetch ?? fetch;
    const token = ctx.account.accessToken;
    const size = (await fs.stat(req.mediaPath)).size;
    const chunkSize = this.opts.chunkSize ?? 4 * MB;
    const segments = Math.max(1, Math.ceil(size / chunkSize));
    let cp = (req.checkpoint as XCheckpoint | null | undefined) ?? null;

    if (!cp) {
      const init = await this.json<{ data: { id: string } }>(
        f,
        `${API}/media/upload/initialize`,
        token,
        { media_type: req.media.mimeType ?? "video/mp4", total_bytes: size, media_category: "tweet_video" },
        ctx.signal,
      );
      cp = { mediaId: init.data.id, nextSegment: 0, finalized: false };
      ctx.saveCheckpoint?.(cp);
    }
    const mediaId = cp.mediaId;

    for (let i = cp.nextSegment; i < segments && !cp.finalized; i++) {
      const chunk = await readFileChunk(req.mediaPath, i * chunkSize, chunkSize);
      const form = new FormData();
      form.set("segment_index", String(i));
      form.set("media", new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }), "chunk");
      await request(
        f,
        `${API}/media/upload/${mediaId}/append`,
        { method: "POST", headers: bearer(token), body: form, signal: ctx.signal },
        { platform: this.displayName },
      );
      cp = { ...cp, nextSegment: i + 1 };
      ctx.saveCheckpoint?.(cp);
      ctx.onProgress?.({ phase: "uploading", fraction: Math.min(1, ((i + 1) * chunkSize) / size) });
    }

    let info: ProcessingInfo | undefined;
    if (!cp.finalized) {
      const fin = await this.json<{ data: { id: string; processing_info?: ProcessingInfo } }>(
        f,
        `${API}/media/upload/${mediaId}/finalize`,
        token,
        {},
        ctx.signal,
      );
      info = fin.data.processing_info;
      cp = { ...cp, finalized: true };
      ctx.saveCheckpoint?.(cp);
    } else {
      info = { state: "pending" };
    }

    ctx.onProgress?.({ phase: "processing" });
    const deadline = Date.now() + (this.opts.pollTimeoutMs ?? 10 * 60_000);
    while (info && info.state !== "succeeded") {
      if (info.state === "failed") {
        ctx.saveCheckpoint?.(null);
        throw new AdapterError("upstream_error", `X could not process the video: ${info.error?.message ?? "failed"}`);
      }
      if (Date.now() > deadline) throw new AdapterError("upstream_error", "X media processing timed out", true);
      await sleep(this.opts.pollIntervalMs ?? (info.check_after_secs ?? 5) * 1000, ctx.signal);
      const st = await requestJson<{ data: { processing_info?: ProcessingInfo } }>(
        f,
        `${API}/media/upload?command=STATUS&media_id=${encodeURIComponent(mediaId)}`,
        { method: "GET", headers: bearer(token), signal: ctx.signal },
        { platform: this.displayName },
      );
      info = st.data.processing_info;
    }

    const tweet = await this.json<{ data: { id: string } }>(
      f,
      `${API}/tweets`,
      token,
      { text: validation.effective.caption, media: { media_ids: [mediaId] } },
      ctx.signal,
    );
    ctx.saveCheckpoint?.(null);
    const username = ctx.account.displayName.replace(/^@/, "");
    const url = username ? `https://x.com/${username}/status/${tweet.data.id}` : `https://x.com/i/web/status/${tweet.data.id}`;
    return { url, externalId: tweet.data.id };
  }
}
