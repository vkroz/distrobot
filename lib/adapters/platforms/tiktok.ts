import fs from "node:fs/promises";
import type { ConnectedAccount } from "@/lib/types";
import {
  TIKTOK_PRIVACY_LABELS,
  normalizeCreatorInfo,
  parseTikTokSettings,
  tiktokPostInfo,
  validateTikTokSettings,
  type TikTokCreatorInfo,
} from "@/lib/platforms/tiktok";
import type { PlatformRuleOverrides } from "@/lib/platforms/rules";
import type { ValidationResult } from "@/lib/platforms/validate";
import { BaseAdapter, type Profile } from "../base";
import { bearer, pollUntil, readFileChunk, request, requestJson } from "../http";
import type { OAuthConfig, TokenResponse } from "../oauth";
import { AdapterError, type DoPublishResult, type PublishContext, type PublishRequest } from "../types";

const API = "https://open.tiktokapis.com";
const MB = 1024 * 1024;

export interface TikTokOptions {
  /** Preferred chunk size (TikTok: 5–64 MB; the last chunk absorbs the remainder). */
  chunkSize?: number;
  /** Files below this are sent as a single chunk (TikTok: 5 MB). */
  minChunkSize?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface TikTokEnvelope<T> {
  data: T;
  error?: { code: string; message?: string; log_id?: string };
}


interface TikTokCheckpoint {
  publishId: string;
  uploaded: boolean;
  username?: string;
}


/** Split `size` into TikTok-compliant chunks: equal chunks, the last one absorbing the remainder. */
export function tiktokChunks(size: number, chunkSize = 10 * MB, minChunkSize = 5 * MB) {
  if (size <= Math.max(minChunkSize, chunkSize)) return { chunkSize: size, count: 1 };
  const count = Math.floor(size / chunkSize);
  return { chunkSize, count };
}

/**
 * TikTok Content Posting API — Direct Post (FILE_UPLOAD).
 *   1. POST /v2/post/publish/creator_info/query/  → privacy options, interaction limits, max duration
 *      (the same call backs the compose screen's creator info via `queryCreatorInfo`)
 *   2. POST /v2/post/publish/video/init/           → publish_id, upload_url
 *   3. PUT upload_url (Content-Range per chunk)
 *   4. POST /v2/post/publish/status/fetch/         → poll until PUBLISH_COMPLETE
 * Docs: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
 * Privacy level, interaction toggles and commercial disclosure come from the user's explicit
 * choices in `settings` (see lib/platforms/tiktok.ts) — TikTok requires no defaults.
 * Shapes follow the public docs but are unverified against the live API.
 */
export class TikTokAdapter extends BaseAdapter {
  readonly platform = "tiktok" as const;
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: "https://www.tiktok.com/v2/auth/authorize/",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic", "video.upload", "video.publish"],
    scopeSeparator: ",",
    clientIdEnv: "TIKTOK_CLIENT_KEY",
    clientSecretEnv: "TIKTOK_CLIENT_SECRET",
    clientIdParam: "client_key",
  };

  constructor(private readonly opts: TikTokOptions = {}) {
    super();
  }

  /** creator_info.max_video_post_duration_sec is cached in account metadata at connect/refresh time. */
  protected ruleOverrides(account?: ConnectedAccount | null): PlatformRuleOverrides | undefined {
    const max = account?.metadata?.maxVideoPostDurationSec;
    return typeof max === "number" ? { video: { maxDurationSec: max } } : undefined;
  }

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const data = await this.getJson<{ data: { user: { open_id: string; display_name: string; username?: string } } }>(
      f,
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,username",
      token.access_token,
    );
    const u = data.data.user;
    return { externalId: u.open_id, displayName: u.display_name, metadata: u.username ? { username: u.username } : {} };
  }

  private async call<T>(f: typeof fetch, path: string, token: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await requestJson<TikTokEnvelope<T>>(
      f,
      `${API}${path}`,
      {
        method: "POST",
        headers: { ...bearer(token), "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify(body ?? {}),
        signal,
      },
      { platform: this.displayName },
    );
    if (res.error && res.error.code !== "ok") {
      const retryable = res.error.code === "rate_limit_exceeded" || res.error.code === "internal_error";
      throw new AdapterError(
        res.error.code === "access_token_invalid" ? "auth_failed" : retryable ? "rate_limited" : "upstream_error",
        `TikTok ${path}: ${res.error.code} ${res.error.message ?? ""}`.trim(),
        retryable,
      );
    }
    return res.data;
  }

  /** creator_info/query for the compose screen (and pre-publish checks). */
  async queryCreatorInfo(account: ConnectedAccount, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<TikTokCreatorInfo> {
    const raw = await this.call<Record<string, unknown>>(fetchImpl, "/v2/post/publish/creator_info/query/", account.accessToken, {}, signal);
    return normalizeCreatorInfo(raw ?? {});
  }

  protected async doPublish(
    req: PublishRequest,
    ctx: PublishContext & { account: ConnectedAccount },
    validation: ValidationResult,
  ): Promise<DoPublishResult> {
    const f = ctx.fetch ?? fetch;
    const token = ctx.account.accessToken;
    const warnings: string[] = [];
    let cp = (req.checkpoint as TikTokCheckpoint | null | undefined) ?? null;

    if (!cp?.uploaded) {
      const creator = await this.queryCreatorInfo(ctx.account, f, ctx.signal);
      // Re-check the user's choices against the creator's current constraints (they can change).
      const issues = validateTikTokSettings(req.settings, creator, req.media.durationSec);
      if (issues.length) throw new AdapterError("validation_failed", issues.map((i) => i.message).join(" "));
      const settings = parseTikTokSettings(req.settings);
      const postInfo = tiktokPostInfo(settings, creator);

      const size = (await fs.stat(req.mediaPath)).size;
      const { chunkSize, count } = tiktokChunks(size, this.opts.chunkSize, this.opts.minChunkSize);
      const init = await this.call<{ publish_id: string; upload_url: string }>(
        f,
        "/v2/post/publish/video/init/",
        token,
        {
          post_info: { title: validation.effective.caption, ...postInfo },
          source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: chunkSize, total_chunk_count: count },
        },
        ctx.signal,
      );
      cp = { publishId: init.publish_id, uploaded: false, username: creator.username ?? undefined };
      if (settings.privacyLevel === "SELF_ONLY") warnings.push(`Posted with TikTok visibility "${TIKTOK_PRIVACY_LABELS.SELF_ONLY}".`);
      ctx.saveCheckpoint?.(cp);

      for (let i = 0; i < count; i++) {
        const start = i * chunkSize;
        const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
        const chunk = await readFileChunk(req.mediaPath, start, end - start + 1);
        await request(
          f,
          init.upload_url,
          {
            method: "PUT",
            headers: {
              "Content-Type": req.media.mimeType ?? "video/mp4",
              "Content-Length": String(chunk.length),
              "Content-Range": `bytes ${start}-${end}/${size}`,
            },
            body: new Uint8Array(chunk),
            signal: ctx.signal,
          },
          { platform: this.displayName },
        );
        ctx.onProgress?.({ phase: "uploading", fraction: (end + 1) / size });
      }
      cp = { ...cp, uploaded: true };
      ctx.saveCheckpoint?.(cp);
    }

    ctx.onProgress?.({ phase: "processing" });
    const publishId = cp.publishId;
    const status = await pollUntil(
      async () => {
        const st = await this.call<{ status: string; fail_reason?: string; publicaly_available_post_id?: Array<string | number> }>(
          f,
          "/v2/post/publish/status/fetch/",
          token,
          { publish_id: publishId },
          ctx.signal,
        );
        if (st.status === "FAILED") {
          ctx.saveCheckpoint?.(null);
          throw new AdapterError("upstream_error", `TikTok rejected the post: ${st.fail_reason ?? "unknown reason"}`);
        }
        return st.status === "PUBLISH_COMPLETE" ? st : undefined;
      },
      {
        intervalMs: this.opts.pollIntervalMs ?? 5000,
        timeoutMs: this.opts.pollTimeoutMs ?? 10 * 60_000,
        platform: this.displayName,
        signal: ctx.signal,
      },
    );

    const postId = status.publicaly_available_post_id?.[0];
    const username = cp.username ?? (ctx.account.metadata.username as string | undefined);
    if (postId && username) {
      return { url: `https://www.tiktok.com/@${username}/video/${postId}`, externalId: String(postId), warnings };
    }
    warnings.push("TikTok did not return a public post id yet (the post may be private or under review).");
    return { url: username ? `https://www.tiktok.com/@${username}` : "https://www.tiktok.com/", externalId: publishId, warnings };
  }
}
