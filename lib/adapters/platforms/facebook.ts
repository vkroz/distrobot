import fs from "node:fs/promises";
import type { ConnectedAccount } from "@/lib/types";
import type { ValidationResult } from "@/lib/platforms/validate";
import { BaseAdapter, type Profile } from "../base";
import { readFileChunk, requestJson } from "../http";
import type { OAuthConfig, TokenResponse } from "../oauth";
import { AdapterError, type DoPublishResult, type PublishContext, type PublishRequest } from "../types";

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION ?? "v23.0";

interface FacebookPage {
  id: string;
  name: string;
  accessToken: string;
}

interface FacebookCheckpoint {
  pageId: string;
  sessionId: string;
  videoId: string;
  startOffset: number;
  endOffset: number;
}

interface PhaseResponse {
  video_id?: string;
  upload_session_id?: string;
  start_offset?: string | number;
  end_offset?: string | number;
  success?: boolean;
}

/**
 * Facebook Pages video — chunked upload via graph-video.facebook.com.
 *   1. POST /{page-id}/videos upload_phase=start (file_size)          → upload_session_id, video_id, offsets
 *   2. POST upload_phase=transfer (start_offset, video_file_chunk)    → next offsets, until start == end
 *   3. POST upload_phase=finish (title, description, published, thumb)
 * Uses the Page access token captured at connect time (GET /me/accounts).
 * Docs: https://developers.facebook.com/docs/video-api/guides/publishing
 * Shapes follow the public docs but are unverified against the live API.
 */
export class FacebookAdapter extends BaseAdapter {
  readonly platform = "facebook" as const;
  protected readonly features = { thumbnail: true };
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${GRAPH_VERSION}/oauth/access_token`,
    scopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "publish_video"],
    scopeSeparator: ",",
    clientIdEnv: "FACEBOOK_APP_ID",
    clientSecretEnv: "FACEBOOK_APP_SECRET",
  };

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const me = await this.getJson<{ id: string; name: string }>(
      f,
      `https://graph.facebook.com/${GRAPH_VERSION}/me?fields=id,name`,
      token.access_token,
    );
    const accounts = await this.getJson<{ data?: Array<{ id: string; name: string; access_token: string }> }>(
      f,
      `https://graph.facebook.com/${GRAPH_VERSION}/me/accounts?fields=id,name,access_token`,
      token.access_token,
    );
    const pages: FacebookPage[] = (accounts.data ?? []).map((p) => ({ id: p.id, name: p.name, accessToken: p.access_token }));
    return { externalId: me.id, displayName: me.name, metadata: { pages } };
  }

  private phase(f: typeof fetch, pageId: string, form: FormData, signal?: AbortSignal): Promise<PhaseResponse> {
    return requestJson<PhaseResponse>(
      f,
      `https://graph-video.facebook.com/${GRAPH_VERSION}/${pageId}/videos`,
      { method: "POST", body: form, signal },
      { platform: this.displayName },
    );
  }

  protected async doPublish(
    req: PublishRequest,
    ctx: PublishContext & { account: ConnectedAccount },
    validation: ValidationResult,
  ): Promise<DoPublishResult> {
    const f = ctx.fetch ?? fetch;
    const pages = (ctx.account.metadata.pages as FacebookPage[] | undefined) ?? [];
    const wanted = typeof req.settings.pageId === "string" ? req.settings.pageId : undefined;
    const page = wanted ? pages.find((p) => p.id === wanted) : pages[0];
    if (!page) {
      throw new AdapterError(
        "validation_failed",
        wanted ? `Facebook Page ${wanted} is not available to this account.` : "No Facebook Pages found for this account.",
      );
    }
    const size = (await fs.stat(req.mediaPath)).size;
    const warnings: string[] = [];

    let cp = (req.checkpoint as FacebookCheckpoint | null | undefined) ?? null;
    if (!cp || cp.pageId !== page.id) {
      const form = new FormData();
      form.set("upload_phase", "start");
      form.set("file_size", String(size));
      form.set("access_token", page.accessToken);
      const start = await this.phase(f, page.id, form, ctx.signal);
      if (!start.upload_session_id || !start.video_id) throw new AdapterError("upstream_error", "Facebook start phase returned no session");
      cp = {
        pageId: page.id,
        sessionId: start.upload_session_id,
        videoId: start.video_id,
        startOffset: Number(start.start_offset ?? 0),
        endOffset: Number(start.end_offset ?? 0),
      };
      ctx.saveCheckpoint?.(cp);
    }

    while (cp.startOffset < cp.endOffset) {
      const chunk = await readFileChunk(req.mediaPath, cp.startOffset, cp.endOffset - cp.startOffset);
      const form = new FormData();
      form.set("upload_phase", "transfer");
      form.set("upload_session_id", cp.sessionId);
      form.set("start_offset", String(cp.startOffset));
      form.set("access_token", page.accessToken);
      form.set("video_file_chunk", new Blob([new Uint8Array(chunk)], { type: "application/octet-stream" }), "chunk");
      const next = await this.phase(f, page.id, form, ctx.signal);
      cp = { ...cp, startOffset: Number(next.start_offset), endOffset: Number(next.end_offset) };
      ctx.saveCheckpoint?.(cp);
      ctx.onProgress?.({ phase: "uploading", fraction: Math.min(1, cp.startOffset / size) });
    }

    const published = req.visibility === "public";
    if (!published) warnings.push("Facebook Pages have no unlisted/private videos; uploaded as unpublished.");
    const form = new FormData();
    form.set("upload_phase", "finish");
    form.set("upload_session_id", cp.sessionId);
    form.set("access_token", page.accessToken);
    form.set("published", String(published));
    if (validation.effective.title) form.set("title", validation.effective.title);
    form.set("description", validation.effective.caption);
    if (req.thumbnail) {
      const thumb = await fs.readFile(req.thumbnail.path);
      form.set("thumb", new Blob([new Uint8Array(thumb)], { type: req.thumbnail.mimeType }), "thumb");
    }
    const fin = await this.phase(f, page.id, form, ctx.signal);
    if (fin.success === false) throw new AdapterError("upstream_error", "Facebook finish phase failed", true);
    ctx.saveCheckpoint?.(null);
    return {
      url: `https://www.facebook.com/${page.id}/videos/${cp.videoId}`,
      externalId: cp.videoId,
      warnings,
      extra: { pageId: page.id, pageName: page.name },
    };
  }
}
