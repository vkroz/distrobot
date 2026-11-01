import type { ConnectedAccount } from "@/lib/types";
import type { PlatformRuleOverrides } from "@/lib/platforms/rules";
import { BaseAdapter, type Profile } from "../base";
import type { OAuthConfig, TokenResponse } from "../oauth";

export class XAdapter extends BaseAdapter {
  readonly platform = "x" as const;
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: "https://x.com/i/oauth2/authorize",
    tokenUrl: "https://api.x.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "media.write", "offline.access"],
    clientIdEnv: "X_CLIENT_ID",
    clientSecretEnv: "X_CLIENT_SECRET",
    tokenAuth: "basic",
    pkce: true,
  };

  /** Premium subscribers get long posts and longer videos. */
  protected ruleOverrides(account?: ConnectedAccount | null): PlatformRuleOverrides | undefined {
    if (account?.metadata?.premium !== true) return undefined;
    return { caption: { maxLength: 25_000 }, video: { maxDurationSec: 3 * 60 * 60 } };
  }

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const me = await this.getJson<{ data: { id: string; username: string; name: string } }>(
      f,
      "https://api.x.com/2/users/me",
      token.access_token,
    );
    return { externalId: me.data.id, displayName: `@${me.data.username}`, metadata: { name: me.data.name } };
  }
}
