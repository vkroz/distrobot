import { BaseAdapter, type Profile } from "../base";
import type { OAuthConfig, TokenResponse } from "../oauth";

const GRAPH_VERSION = process.env.FACEBOOK_GRAPH_VERSION ?? "v23.0";

/** Publishes to Facebook Pages. The user token is later exchanged for a Page token (Stage 2). */
export class FacebookAdapter extends BaseAdapter {
  readonly platform = "facebook" as const;
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
    return { externalId: me.id, displayName: me.name };
  }
}
