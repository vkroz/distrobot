import { BaseAdapter, type Profile } from "../base";
import type { OAuthConfig, TokenResponse } from "../oauth";

export class YouTubeAdapter extends BaseAdapter {
  readonly platform = "youtube" as const;
  protected readonly oauth: OAuthConfig = {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    clientIdEnv: "YOUTUBE_CLIENT_ID",
    clientSecretEnv: "YOUTUBE_CLIENT_SECRET",
    // offline + consent so Google returns a refresh token.
    extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  };

  protected async fetchProfile(token: TokenResponse, f: typeof fetch): Promise<Profile> {
    const data = await this.getJson<{ items?: Array<{ id: string; snippet: { title: string } }> }>(
      f,
      "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true",
      token.access_token,
    );
    const ch = data.items?.[0];
    if (!ch) throw new Error("No YouTube channel on this Google account");
    return { externalId: ch.id, displayName: ch.snippet.title };
  }
}
