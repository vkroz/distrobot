import fs from "node:fs/promises";
import type { ConnectedAccount } from "@/lib/types";
import type { ValidationResult } from "@/lib/platforms/validate";
import { BaseAdapter, type Profile } from "../base";
import { pollUntil, readFileChunk, request, requestJson } from "../http";
import type { OAuthConfig, TokenResponse } from "../oauth";
import { AdapterError, type DoPublishResult, type PublishContext, type PublishRequest } from "../types";

const VERSION = process.env.INSTAGRAM_GRAPH_VERSION ?? "v23.0";
const GRAPH = `https://graph.instagram.com/${VERSION}`;
const RUPLOAD = `https://rupload.facebook.com/ig-api-upload/${VERSION}`;

export interface InstagramOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface InstagramCheckpoint {
  containerId: string;
  uploaded: boolean;
}

/**
 * Instagram API with Instagram Login — Reels via resumable upload.
 *   1. POST /{ig-user-id}/media (media_type=REELS, upload_type=resumable, caption) → container id
 *   2. POST rupload.facebook.com/ig-api-upload/{ver}/{container} (headers offset, file_size) with bytes
 *   3. GET /{container}?fields=status_code  → poll until FINISHED
 *   4. POST /{ig-user-id}/media_publish?creation_id=… → media id
 *   5. GET /{media-id}?fields=permalink
 * Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
 * Shapes follow the public docs but are unverified against the live API.
 */
export class InstagramAdapter extends BaseAdapter {
  readonly platform = "instagram" as const;
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: "https://www.instagram.com/oauth/authorize",
    tokenUrl: "https://api.instagram.com/oauth/access_token",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    scopeSeparator: ",",
    clientIdEnv: "INSTAGRAM_APP_ID",
    clientSecretEnv: "INSTAGRAM_APP_SECRET",
  };

  constructor(private readonly opts: InstagramOptions = {}) {
    super();
  }

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const me = await this.getJson<{ user_id: string; username: string }>(
      f,
      "https://graph.instagram.com/me?fields=user_id,username",
      token.access_token,
    );
    return { externalId: String(me.user_id), displayName: me.username };
  }

  private post<T>(f: typeof fetch, url: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return requestJson<T>(f, url, { method: "POST", body: new URLSearchParams(params), signal }, { platform: this.displayName });
  }

  private get<T>(f: typeof fetch, url: string, token: string, signal?: AbortSignal): Promise<T> {
    const u = new URL(url);
    u.searchParams.set("access_token", token);
    return requestJson<T>(f, u.toString(), { method: "GET", signal }, { platform: this.displayName });
  }

  protected async doPublish(
    req: PublishRequest,
    ctx: PublishContext & { account: ConnectedAccount },
    validation: ValidationResult,
  ): Promise<DoPublishResult> {
    const f = ctx.fetch ?? fetch;
    const token = ctx.account.accessToken;
    const igUserId = ctx.account.externalId;
    let cp = (req.checkpoint as InstagramCheckpoint | null | undefined) ?? null;

    if (!cp) {
      const params: Record<string, string> = {
        media_type: "REELS",
        upload_type: "resumable",
        caption: validation.effective.caption,
        share_to_feed: String(req.settings.shareToFeed !== false),
        access_token: token,
      };
      if (typeof req.settings.thumbOffsetMs === "number") params.thumb_offset = String(req.settings.thumbOffsetMs);
      const container = await this.post<{ id: string }>(f, `${GRAPH}/${igUserId}/media`, params, ctx.signal);
      cp = { containerId: container.id, uploaded: false };
      ctx.saveCheckpoint?.(cp);
    }

    if (!cp.uploaded) {
      // Reels are capped at 300 MB, so a single request is acceptable here.
      const size = (await fs.stat(req.mediaPath)).size;
      const bytes = await readFileChunk(req.mediaPath, 0, size);
      await request(
        f,
        `${RUPLOAD}/${cp.containerId}`,
        {
          method: "POST",
          headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(size) },
          body: new Uint8Array(bytes),
          signal: ctx.signal,
        },
        { platform: this.displayName },
      );
      cp = { ...cp, uploaded: true };
      ctx.saveCheckpoint?.(cp);
      ctx.onProgress?.({ phase: "uploading", fraction: 1 });
    }

    ctx.onProgress?.({ phase: "processing" });
    const containerId = cp.containerId;
    await pollUntil(
      async () => {
        const st = await this.get<{ status_code: string; status?: string }>(
          f,
          `${GRAPH}/${containerId}?fields=status_code,status`,
          token,
          ctx.signal,
        );
        if (st.status_code === "ERROR") {
          ctx.saveCheckpoint?.(null);
          throw new AdapterError("upstream_error", `Instagram could not process the video: ${st.status ?? "ERROR"}`);
        }
        if (st.status_code === "EXPIRED") {
          // Container lifetime ran out; start over with a fresh container on retry.
          ctx.saveCheckpoint?.(null);
          throw new AdapterError("upstream_error", "Instagram media container expired", true);
        }
        return st.status_code === "FINISHED" || st.status_code === "PUBLISHED" ? st : undefined;
      },
      {
        intervalMs: this.opts.pollIntervalMs ?? 5000,
        timeoutMs: this.opts.pollTimeoutMs ?? 10 * 60_000,
        platform: this.displayName,
        signal: ctx.signal,
      },
    );

    const published = await this.post<{ id: string }>(
      f,
      `${GRAPH}/${igUserId}/media_publish`,
      { creation_id: containerId, access_token: token },
      ctx.signal,
    );
    ctx.saveCheckpoint?.(null);
    const warnings: string[] = [];
    let url: string | null = null;
    try {
      url = (await this.get<{ permalink?: string }>(f, `${GRAPH}/${published.id}?fields=permalink`, token, ctx.signal)).permalink ?? null;
    } catch {
      warnings.push("Published, but could not fetch the Instagram permalink.");
    }
    return { url, externalId: published.id, warnings };
  }
}
