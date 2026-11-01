import type { ConnectedAccount } from "@/lib/types";
import type { PlatformRuleOverrides } from "@/lib/platforms/rules";
import { BaseAdapter, type Profile } from "../base";
import type { OAuthConfig, TokenResponse } from "../oauth";

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
}
