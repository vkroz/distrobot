import { BaseAdapter, type Profile } from "../base";
import type { OAuthConfig, TokenResponse } from "../oauth";

/** Instagram API with Instagram Login (professional accounts). */
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

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const me = await this.getJson<{ user_id: string; username: string }>(
      f,
      "https://graph.instagram.com/me?fields=user_id,username",
      token.access_token,
    );
    return { externalId: String(me.user_id), displayName: me.username };
  }
}
