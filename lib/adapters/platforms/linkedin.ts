import fs from "node:fs/promises";
import type { ConnectedAccount } from "@/lib/types";
import type { ValidationResult } from "@/lib/platforms/validate";
import { BaseAdapter, type Profile } from "../base";
import { bearer, pollUntil, readFileChunk, request, requestJson } from "../http";
import type { OAuthConfig, TokenResponse } from "../oauth";
import { AdapterError, type DoPublishResult, type PublishContext, type PublishRequest } from "../types";

const API = "https://api.linkedin.com/rest";

export interface LinkedInOptions {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

interface UploadInstruction {
  uploadUrl: string;
  firstByte: number;
  lastByte: number;
}

interface LinkedInCheckpoint {
  video: string;
  uploadToken: string;
  instructions: UploadInstruction[];
  /** ETag per instruction; null = not uploaded yet. */
  etags: Array<string | null>;
  finalized: boolean;
}

/**
 * LinkedIn Videos API + Posts API (versioned REST).
 *   1. POST /rest/videos?action=initializeUpload → video URN, uploadToken, uploadInstructions[], thumbnailUploadUrl
 *   2. PUT each byte range to its uploadUrl (collect ETags); optional thumbnail PUT
 *   3. POST /rest/videos?action=finalizeUpload {video, uploadToken, uploadedPartIds}
 *   4. GET /rest/videos/{urn} until AVAILABLE
 *   5. POST /rest/posts → post URN in x-restli-id
 * Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
 * Shapes follow the public docs but are unverified against the live API.
 */
export class LinkedInAdapter extends BaseAdapter {
  readonly platform = "linkedin" as const;
  protected readonly features = { thumbnail: true };
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "w_member_social"],
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
  };

  constructor(private readonly opts: LinkedInOptions = {}) {
    super();
  }

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const me = await this.getJson<{ sub: string; name: string }>(f, "https://api.linkedin.com/v2/userinfo", token.access_token);
    // Posting uses the person URN as author.
    return { externalId: me.sub, displayName: me.name, metadata: { authorUrn: `urn:li:person:${me.sub}` } };
  }

  private headers(token: string): Record<string, string> {
    return {
      ...bearer(token),
      "LinkedIn-Version": process.env.LINKEDIN_API_VERSION ?? "202509",
      "X-Restli-Protocol-Version": "2.0.0",
      "Content-Type": "application/json",
    };
  }

  protected async doPublish(
    req: PublishRequest,
    ctx: PublishContext & { account: ConnectedAccount },
    validation: ValidationResult,
  ): Promise<DoPublishResult> {
    const f = ctx.fetch ?? fetch;
    const token = ctx.account.accessToken;
    const owner = (ctx.account.metadata.authorUrn as string | undefined) ?? `urn:li:person:${ctx.account.externalId}`;
    const opts = { platform: this.displayName };
    const warnings: string[] = [];
    const size = (await fs.stat(req.mediaPath)).size;

    let cp = (req.checkpoint as LinkedInCheckpoint | null | undefined) ?? null;
    if (!cp) {
      const init = await requestJson<{
        value: {
          video: string;
          uploadToken?: string;
          uploadInstructions: UploadInstruction[];
          thumbnailUploadUrl?: string;
        };
      }>(
        f,
        `${API}/videos?action=initializeUpload`,
        {
          method: "POST",
          headers: this.headers(token),
          body: JSON.stringify({
            initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: !!req.thumbnail },
          }),
          signal: ctx.signal,
        },
        opts,
      );
      const v = init.value;
      cp = {
        video: v.video,
        uploadToken: v.uploadToken ?? "",
        instructions: v.uploadInstructions,
        etags: v.uploadInstructions.map(() => null),
        finalized: false,
      };
      ctx.saveCheckpoint?.(cp);

      if (req.thumbnail && v.thumbnailUploadUrl) {
        try {
          await request(
            f,
            v.thumbnailUploadUrl,
            {
              method: "PUT",
              headers: { ...bearer(token), "Content-Type": req.thumbnail.mimeType },
              body: new Uint8Array(await fs.readFile(req.thumbnail.path)),
              signal: ctx.signal,
            },
            opts,
          );
        } catch (err) {
          warnings.push(`Thumbnail upload failed: ${(err as Error).message}`);
        }
      }
    }

    for (let i = 0; i < cp.instructions.length && !cp.finalized; i++) {
      if (cp.etags[i]) continue;
      const part = cp.instructions[i];
      const chunk = await readFileChunk(req.mediaPath, part.firstByte, part.lastByte - part.firstByte + 1);
      const res = await request(
        f,
        part.uploadUrl,
        {
          method: "PUT",
          headers: { ...bearer(token), "Content-Type": "application/octet-stream" },
          body: new Uint8Array(chunk),
          signal: ctx.signal,
        },
        opts,
      );
      const etag = res.headers.get("etag");
      if (!etag) throw new AdapterError("upstream_error", "LinkedIn upload part returned no ETag", true);
      const etags: Array<string | null> = [...cp.etags];
      etags[i] = etag;
      cp = { ...cp, etags };
      ctx.saveCheckpoint?.(cp);
      ctx.onProgress?.({ phase: "uploading", fraction: (part.lastByte + 1) / size });
    }

    if (!cp.finalized) {
      await request(
        f,
        `${API}/videos?action=finalizeUpload`,
        {
          method: "POST",
          headers: this.headers(token),
          body: JSON.stringify({
            finalizeUploadRequest: { video: cp.video, uploadToken: cp.uploadToken, uploadedPartIds: cp.etags },
          }),
          signal: ctx.signal,
        },
        opts,
      );
      cp = { ...cp, finalized: true };
      ctx.saveCheckpoint?.(cp);
    }

    ctx.onProgress?.({ phase: "processing" });
    const video = cp.video;
    await pollUntil(
      async () => {
        const st = await requestJson<{ status?: string }>(
          f,
          `${API}/videos/${encodeURIComponent(video)}`,
          { method: "GET", headers: this.headers(token), signal: ctx.signal },
          opts,
        );
        if (st.status === "PROCESSING_FAILED") {
          ctx.saveCheckpoint?.(null);
          throw new AdapterError("upstream_error", "LinkedIn could not process the video");
        }
        return st.status === "AVAILABLE" ? st : undefined;
      },
      {
        intervalMs: this.opts.pollIntervalMs ?? 5000,
        timeoutMs: this.opts.pollTimeoutMs ?? 10 * 60_000,
        platform: this.displayName,
        signal: ctx.signal,
      },
    );

    const res = await request(
      f,
      `${API}/posts`,
      {
        method: "POST",
        headers: this.headers(token),
        body: JSON.stringify({
          author: owner,
          commentary: validation.effective.caption,
          visibility: req.visibility === "public" ? "PUBLIC" : "CONNECTIONS",
          distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
          content: { media: { ...(validation.effective.title ? { title: validation.effective.title } : {}), id: video } },
          lifecycleState: "PUBLISHED",
          isReshareDisabledByAuthor: false,
        }),
        signal: ctx.signal,
      },
      opts,
    );
    ctx.saveCheckpoint?.(null);
    if (req.visibility === "unlisted") warnings.push("LinkedIn has no unlisted posts; shared with connections only.");
    const urn = res.headers.get("x-restli-id");
    return { url: urn ? `https://www.linkedin.com/feed/update/${urn}` : null, externalId: urn ?? video, warnings };
  }
}
