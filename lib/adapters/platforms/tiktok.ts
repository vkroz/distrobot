import type { ConnectedAccount } from "@/lib/types";
import type { PlatformRuleOverrides } from "@/lib/platforms/rules";
import { BaseAdapter, type Profile } from "../base";
import type { OAuthConfig, TokenResponse } from "../oauth";

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

  /** creator_info.max_video_post_duration_sec is cached in account metadata at connect/refresh time. */
  protected ruleOverrides(account?: ConnectedAccount | null): PlatformRuleOverrides | undefined {
    const max = account?.metadata?.maxVideoPostDurationSec;
    return typeof max === "number" ? { video: { maxDurationSec: max } } : undefined;
  }

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const data = await this.getJson<{ data: { user: { open_id: string; display_name: string } } }>(
      f,
      "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url",
      token.access_token,
    );
    return { externalId: data.data.user.open_id, displayName: data.data.user.display_name };
  }
}
