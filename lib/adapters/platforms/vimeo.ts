import fs from "node:fs/promises";
import type { ConnectedAccount, Visibility } from "@/lib/types";
import type { PlatformRuleOverrides } from "@/lib/platforms/rules";
import type { ValidationResult } from "@/lib/platforms/validate";
import { BaseAdapter, type Profile } from "../base";
import { bearer, readFileChunk, request, requestJson } from "../http";
import type { OAuthConfig, TokenResponse } from "../oauth";
import { AdapterError, type DoPublishResult, type PublishContext, type PublishRequest } from "../types";

const API = "https://api.vimeo.com";
const ACCEPT = "application/vnd.vimeo.*+json;version=3.4";
const MB = 1024 * 1024;

export interface VimeoOptions {
  /** tus PATCH chunk size. */
  chunkSize?: number;
}

interface VimeoCheckpoint {
  uri: string;
  link: string;
  uploadLink: string;
}

const PRIVACY: Record<Visibility, string> = { public: "anybody", unlisted: "unlisted", private: "nobody" };

/**
 * Vimeo — tus resumable upload.
 *   1. POST /me/videos {upload:{approach:"tus", size}, name, description, privacy} → uri, link, upload.upload_link
 *   2. PATCH upload_link per chunk (Tus-Resumable, Upload-Offset); resume via HEAD → Upload-Offset
 *   3. PUT /videos/{id}/tags [{name}]
 * Docs: https://developer.vimeo.com/api/upload/videos
 * Shapes follow the public docs but are unverified against the live API.
 */
export class VimeoAdapter extends BaseAdapter {
  readonly platform = "vimeo" as const;
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: "https://api.vimeo.com/oauth/authorize",
    tokenUrl: "https://api.vimeo.com/oauth/access_token",
    scopes: ["public", "private", "upload", "edit"],
    clientIdEnv: "VIMEO_CLIENT_ID",
    clientSecretEnv: "VIMEO_CLIENT_SECRET",
    tokenAuth: "basic",
  };

  constructor(private readonly opts: VimeoOptions = {}) {
    super();
  }

  /** Remaining upload quota (from /me upload_quota) is cached in account metadata. */
  protected ruleOverrides(account?: ConnectedAccount | null): PlatformRuleOverrides | undefined {
    const free = account?.metadata?.uploadQuotaFreeBytes;
    return typeof free === "number" ? { video: { maxFileSizeBytes: free } } : undefined;
  }

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const me = await this.getJson<{ uri: string; name: string; upload_quota?: { space?: { free?: number } } }>(
      f,
      "https://api.vimeo.com/me",
      token.access_token,
    );
    const free = me.upload_quota?.space?.free;
    return {
      externalId: me.uri.replace("/users/", ""),
      displayName: me.name,
      metadata: typeof free === "number" ? { uploadQuotaFreeBytes: free } : {},
    };
  }

  protected async doPublish(
    req: PublishRequest,
    ctx: PublishContext & { account: ConnectedAccount },
    validation: ValidationResult,
  ): Promise<DoPublishResult> {
    const f = ctx.fetch ?? fetch;
    const token = ctx.account.accessToken;
    const opts = { platform: this.displayName };
    const size = (await fs.stat(req.mediaPath)).size;
    const warnings: string[] = [];

    let cp = (req.checkpoint as VimeoCheckpoint | null | undefined) ?? null;
    let offset = 0;
    if (cp) {
      const head = await request(
        f,
        cp.uploadLink,
        { method: "HEAD", headers: { "Tus-Resumable": "1.0.0" }, signal: ctx.signal },
        opts,
      );
      offset = Number(head.headers.get("upload-offset") ?? 0);
    } else {
      const created = await requestJson<{ uri: string; link: string; upload: { upload_link: string } }>(
        f,
        `${API}/me/videos`,
        {
          method: "POST",
          headers: { ...bearer(token), "Content-Type": "application/json", Accept: ACCEPT },
          body: JSON.stringify({
            upload: { approach: "tus", size: String(size) },
            name: validation.effective.title ?? req.media.originalFilename,
            description: validation.effective.caption,
            privacy: { view: PRIVACY[req.visibility] },
          }),
          signal: ctx.signal,
        },
        opts,
      );
      cp = { uri: created.uri, link: created.link, uploadLink: created.upload.upload_link };
      ctx.saveCheckpoint?.(cp);
    }

    const chunkSize = this.opts.chunkSize ?? 64 * MB;
    while (offset < size) {
      const chunk = await readFileChunk(req.mediaPath, offset, Math.min(chunkSize, size - offset));
      const res = await request(
        f,
        cp.uploadLink,
        {
          method: "PATCH",
          headers: {
            "Tus-Resumable": "1.0.0",
            "Upload-Offset": String(offset),
            "Content-Type": "application/offset+octet-stream",
          },
          body: new Uint8Array(chunk),
          signal: ctx.signal,
        },
        opts,
      );
      const next = Number(res.headers.get("upload-offset"));
      if (!Number.isFinite(next) || next <= offset) {
        throw new AdapterError("upstream_error", "Vimeo upload did not advance; will resume on retry", true);
      }
      offset = next;
      ctx.onProgress?.({ phase: "uploading", fraction: offset / size });
    }

    const tags = validation.effective.tags;
    if (tags.length > 0) {
      try {
        await request(
          f,
          `${API}${cp.uri}/tags`,
          {
            method: "PUT",
            headers: { ...bearer(token), "Content-Type": "application/json", Accept: ACCEPT },
            body: JSON.stringify(tags.map((name) => ({ name }))),
            signal: ctx.signal,
          },
          opts,
        );
      } catch (err) {
        warnings.push(`Could not set Vimeo tags: ${(err as Error).message}`);
      }
    }
    ctx.saveCheckpoint?.(null);
    return { url: cp.link, externalId: cp.uri.replace("/videos/", ""), warnings };
  }
}
