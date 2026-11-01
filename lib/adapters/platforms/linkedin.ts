import { BaseAdapter, type Profile } from "../base";
import type { OAuthConfig, TokenResponse } from "../oauth";

export class LinkedInAdapter extends BaseAdapter {
  readonly platform = "linkedin" as const;
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["openid", "profile", "w_member_social"],
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
  };

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const me = await this.getJson<{ sub: string; name: string }>(f, "https://api.linkedin.com/v2/userinfo", token.access_token);
    // Posting uses the person URN as author.
    return { externalId: me.sub, displayName: me.name, metadata: { authorUrn: `urn:li:person:${me.sub}` } };
  }
}
