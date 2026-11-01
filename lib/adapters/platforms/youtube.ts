import fs from "node:fs/promises";
import type { ValidationResult } from "@/lib/platforms/validate";
import type { ConnectedAccount } from "@/lib/types";
import { BaseAdapter, type Profile } from "../base";
import { bearer, readFileChunk, request, requestJson } from "../http";
import type { OAuthConfig, TokenResponse } from "../oauth";
import type { DoPublishResult, PublishContext, PublishRequest } from "../types";

/**
 * YouTube Data API v3.
 *
 * Upload flow (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol):
 *   1. POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status  (JSON metadata)
 *      → 200 + `Location: <session URI>`
 *   2. PUT <session URI> in chunks (multiples of 256 KiB) with `Content-Range: bytes a-b/total`
 *      → 308 Resume Incomplete (+ `Range: bytes=0-n`) until the final 200/201 with the video resource.
 *   3. Interrupted? PUT <session URI> with `Content-Range: bytes * /total` (no space) to learn the offset.
 *   4. Optional: POST /upload/youtube/v3/thumbnails/set?videoId=… with the image bytes.
 * Scheduling: status.privacyStatus=private + status.publishAt (YouTube flips it public at that time).
 */

const UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos";
const THUMBNAIL_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const CHUNK_GRANULARITY = 256 * 1024;
const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;
const MAX_TAGS_CHARS = 500;

export interface YouTubeAdapterOptions {
  /** Upload chunk size; rounded down to a multiple of 256 KiB. Default 8 MiB. */
  chunkSize?: number;
}

interface UploadCheckpoint {
  sessionUri: string;
  totalBytes: number;
}

interface VideoResource {
  id: string;
  status?: { uploadStatus?: string; privacyStatus?: string; publishAt?: string };
}

/** Keep tags within YouTube's 500-character budget (tags with spaces count their quotes; commas separate). */
export function fitTags(tags: string[], budget = MAX_TAGS_CHARS): string[] {
  const out: string[] = [];
  let used = 0;
  for (const tag of tags) {
    const cost = tag.length + (/\s/.test(tag) ? 2 : 0) + (out.length ? 1 : 0);
    if (used + cost > budget) break;
    out.push(tag);
    used += cost;
  }
  return out;
}

/** "bytes=0-524287" → next offset 524288; missing header → 0. */
export function nextOffsetFromRange(range: string | null): number {
  const m = range?.match(/bytes=\d+-(\d+)/);
  return m ? Number(m[1]) + 1 : 0;
}

export class YouTubeAdapter extends BaseAdapter {
  readonly platform = "youtube" as const;
  protected readonly features = { nativeScheduling: true, thumbnail: true };
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    clientIdEnv: "YOUTUBE_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_CLIENT_SECRET",
    // offline + consent so Google returns a refresh token.
    extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  };
  private readonly chunkSize: number;

  constructor(opts: YouTubeAdapterOptions = {}) {
    super();
    const requested = opts.chunkSize ?? 8 * 1024 * 1024;
    this.chunkSize = Math.max(CHUNK_GRANULARITY, Math.floor(requested / CHUNK_GRANULARITY) * CHUNK_GRANULARITY);
  }

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const data = await this.getJson<{ items?: Array<{ id: string; snippet: { title: string; customUrl?: string } }> }>(
      f,
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      token.access_token,
    );
    const ch = data.items?.[0];
    if (!ch) throw new Error("No YouTube channel on this Google account");
    return { externalId: ch.id, displayName: ch.snippet.title, metadata: { customUrl: ch.snippet.customUrl ?? null } };
  }

  /** videos.insert resource body. */
  buildMetadata(req: PublishRequest, validation: ValidationResult) {
    const s = req.settings;
    const publishAt = req.scheduledAt && Date.parse(req.scheduledAt) > Date.now() ? req.scheduledAt : undefined;
    return {
      snippet: {
        title: validation.effective.title ?? req.content.title,
        description: validation.effective.caption,
        tags: fitTags(req.content.hashtags),
        categoryId: typeof s.categoryId === "string" ? s.categoryId : "22", // People & Blogs
        ...(typeof s.defaultLanguage === "string" ? { defaultLanguage: s.defaultLanguage } : {}),
      },
      status: {
        // publishAt requires a private video; YouTube makes it public at that time.
        privacyStatus: publishAt ? "private" : req.visibility,
        ...(publishAt ? { publishAt: new Date(publishAt).toISOString() } : {}),
        selfDeclaredMadeForKids: s.madeForKids === true,
        embeddable: s.embeddable !== false,
      },
    };
  }

  protected async doPublish(
    req: PublishRequest,
    ctx: PublishContext & { account: ConnectedAccount },
    validation: ValidationResult,
  ): Promise<DoPublishResult> {
    const f = ctx.fetch ?? fetch;
    const auth = bearer(ctx.account.accessToken);
    const { size } = await fs.stat(req.mediaPath);
    const metadata = this.buildMetadata(req, validation);
    const opts = { platform: this.displayName };

    // Resume a previous session if the checkpoint matches this file.
    let video: VideoResource | null = null;
    let offset = 0;
    let sessionUri: string | null = null;
    const cp = req.checkpoint as Partial<UploadCheckpoint> | null | undefined;
    if (cp?.sessionUri && cp.totalBytes === size) {
      const res = await request(
        f,
        cp.sessionUri,
        { method: "PUT", headers: { ...auth, "Content-Range": `bytes */${size}` }, signal: ctx.signal },
        { ...opts, allowStatuses: [308, 404, 410] },
      );
      if (res.status === 308) {
        sessionUri = cp.sessionUri;
        offset = nextOffsetFromRange(res.headers.get("range"));
      } else if (res.ok) {
        sessionUri = cp.sessionUri;
        video = (await res.json()) as VideoResource;
      }
      // 404/410: session expired → start over.
    }

    if (!sessionUri) {
      const url = new URL(UPLOAD_ENDPOINT);
      url.searchParams.set("uploadType", "resumable");
      url.searchParams.set("part", "snippet,status");
      if (req.settings.notifySubscribers === false) url.searchParams.set("notifySubscribers", "false");
      const res = await request(
        f,
        url.toString(),
        {
          method: "POST",
          headers: {
            ...auth,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": String(size),
            "X-Upload-Content-Type": req.media.mimeType ?? "video/*",
          },
          body: JSON.stringify(metadata),
          signal: ctx.signal,
        },
        opts,
      );
      sessionUri = res.headers.get("location");
      if (!sessionUri) throw new Error("YouTube did not return an upload session URI");
      ctx.saveCheckpoint?.({ sessionUri, totalBytes: size } satisfies UploadCheckpoint);
    }

    while (!video) {
      const len = Math.min(this.chunkSize, size - offset);
      const chunk = await readFileChunk(req.mediaPath, offset, len);
      const res = await request(
        f,
        sessionUri,
        {
          method: "PUT",
          headers: {
            ...auth,
            "Content-Type": req.media.mimeType ?? "video/*",
            "Content-Range": `bytes ${offset}-${offset + chunk.length - 1}/${size}`,
          },
          body: new Uint8Array(chunk),
          signal: ctx.signal,
        },
        { ...opts, allowStatuses: [308] },
      );
      if (res.status === 308) {
        const next = nextOffsetFromRange(res.headers.get("range"));
        if (next <= offset && chunk.length > 0) {
          // Server didn't accept anything; avoid a tight loop and let the job retry from the checkpoint.
          throw new Error(`YouTube upload made no progress at byte ${offset}`);
        }
        offset = next;
        ctx.onProgress?.({ phase: "uploading", fraction: offset / size });
      } else {
        video = (await res.json()) as VideoResource;
      }
    }
    ctx.onProgress?.({ phase: "processing", fraction: 1 });

    const warnings: string[] = [];
    if (req.thumbnail) {
      const warning = await this.setThumbnail(f, auth, video.id, req.thumbnail, ctx.signal);
      if (warning) warnings.push(warning);
    }

    return {
      url: validation.shortForm ? `https://www.youtube.com/shorts/${video.id}` : `https://www.youtube.com/watch?v=${video.id}`,
      externalId: video.id,
      warnings,
      extra: {
        privacyStatus: metadata.status.privacyStatus,
        publishAt: metadata.status.publishAt ?? null,
        tags: metadata.snippet.tags,
        categoryId: metadata.snippet.categoryId,
      },
    };
  }

  /** Thumbnail failures don't fail the publish (e.g. unverified channels can't set custom thumbnails). */
  private async setThumbnail(
    f: typeof fetch,
    auth: Record<string, string>,
    videoId: string,
    thumb: NonNullable<PublishRequest["thumbnail"]>,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!["image/jpeg", "image/png"].includes(thumb.mimeType)) return `Thumbnail skipped: YouTube accepts JPEG or PNG, got ${thumb.mimeType}.`;
    const bytes = await fs.readFile(thumb.path);
    if (bytes.length > MAX_THUMBNAIL_BYTES) return "Thumbnail skipped: YouTube thumbnails must be 2 MB or smaller.";
    try {
      await requestJson(
        f,
        `${THUMBNAIL_ENDPOINT}?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
        { method: "POST", headers: { ...auth, "Content-Type": thumb.mimeType }, body: new Uint8Array(bytes), signal },
        { platform: this.displayName },
      );
      return null;
    } catch (err) {
      return `Video published, but setting the thumbnail failed: ${(err as Error).message}`;
    }
  }
}
