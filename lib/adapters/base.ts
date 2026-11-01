import { getRules, type PlatformRuleOverrides, type PlatformRules } from "@/lib/platforms/rules";
import { validateForPlatform, type ValidationResult } from "@/lib/platforms/validate";
import type { ConnectedAccount, MediaInfo, PlatformId, TargetContent } from "@/lib/types";
import { buildAuthUrl, exchangeCode, readClientCredentials, type OAuthConfig, type TokenResponse } from "./oauth";
import {
  AdapterError,
  type AccountCredentials,
  type AuthUrlParams,
  type CallbackParams,
  type PlatformAdapter,
  type PublishContext,
  type PublishRequest,
  type PublishResult,
} from "./types";

export interface Profile {
  externalId: string;
  displayName: string;
  metadata?: Record<string, unknown>;
}

/**
 * Shared adapter behaviour: rule-based validation, dry-run, generic OAuth2 code flow.
 * Subclasses provide `fetchProfile` and (eventually) `doPublish`.
 */
export abstract class BaseAdapter implements PlatformAdapter {
  abstract readonly platform: PlatformId;
  protected abstract readonly oauth: OAuthConfig;

  get displayName(): string {
    return getRules(this.platform).displayName;
  }

  get capabilities() {
    return {
      pkce: !!this.oauth.pkce,
      refreshTokens: true,
      publish: this.doPublish !== BaseAdapter.prototype.doPublish,
    };
  }

  isConfigured(): boolean {
    return readClientCredentials(this.oauth) !== null;
  }

  /** Override to adjust limits from account metadata. */
  protected ruleOverrides(_account?: ConnectedAccount | null): PlatformRuleOverrides | undefined {
    return undefined;
  }

  getRules(account?: ConnectedAccount | null): PlatformRules {
    return getRules(this.platform, this.ruleOverrides(account));
  }

  validate(content: TargetContent, media?: MediaInfo, account?: ConnectedAccount | null): ValidationResult {
    return validateForPlatform({ platform: this.platform, content, media, overrides: this.ruleOverrides(account) });
  }

  async publish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult> {
    const validation = this.validate(req.content, req.media, ctx.account);
    if (!validation.ok) {
      throw new AdapterError(
        "validation_failed",
        validation.errors.map((e) => e.message).join(" "),
        false,
        validation.errors,
      );
    }
    const warnings = validation.warnings.map((w) => w.message);
    if (ctx.dryRun) {
      return {
        url: `https://dry-run.invalid/${this.platform}/${req.jobId}`,
        externalId: `dry-run-${req.jobId}`,
        dryRun: true,
        payload: validation.effective,
        warnings,
      };
    }
    if (!ctx.account) throw new AdapterError("no_account", `No ${this.displayName} account connected.`);
    const result = await this.doPublish(req, { ...ctx, account: ctx.account }, validation);
    return { ...result, dryRun: false, payload: validation.effective, warnings: [...warnings, ...(result.warnings ?? [])] };
  }

  /** Real upload. Not implemented for any platform yet (Stage 2). */
  protected async doPublish(
    _req: PublishRequest,
    _ctx: PublishContext & { account: ConnectedAccount },
    _validation: ValidationResult,
  ): Promise<{ url: string | null; externalId: string | null; warnings?: string[] }> {
    throw new AdapterError("not_implemented", `Publishing to ${this.displayName} is not implemented yet.`);
  }

  getAuthUrl(params: AuthUrlParams): string {
    const creds = readClientCredentials(this.oauth);
    if (!creds) throw new AdapterError("not_configured", `${this.displayName} OAuth is not configured (${this.oauth.clientIdEnv}).`);
    if (this.oauth.pkce && !params.codeChallenge) {
      throw new AdapterError("auth_failed", `${this.displayName} requires a PKCE code challenge.`);
    }
    return buildAuthUrl(this.oauth, creds.clientId, params);
  }

  async handleCallback(params: CallbackParams): Promise<AccountCredentials> {
    const creds = readClientCredentials(this.oauth);
    if (!creds) throw new AdapterError("not_configured", `${this.displayName} OAuth is not configured.`);
    if (this.oauth.pkce && !params.codeVerifier) {
      throw new AdapterError("auth_failed", `${this.displayName} requires a PKCE code verifier.`);
    }
    const fetchImpl = params.fetch ?? fetch;
    let token: TokenResponse;
    try {
      token = await exchangeCode(this.oauth, creds, params, fetchImpl);
    } catch (err) {
      throw new AdapterError("auth_failed", (err as Error).message);
    }
    const profile = await this.fetchProfile(token, fetchImpl);
    return {
      platform: this.platform,
      externalId: profile.externalId,
      displayName: profile.displayName,
      accessToken: token.access_token,
      refreshToken: token.refresh_token ?? null,
      expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
      scopes: token.scope ? token.scope.split(/[\s,]+/).filter(Boolean) : this.oauth.scopes,
      metadata: profile.metadata ?? {},
    };
  }

  /** Identify the connected account using the fresh token. */
  protected abstract fetchProfile(token: TokenResponse, fetchImpl: typeof fetch): Promise<Profile>;

  protected async getJson<T>(fetchImpl: typeof fetch, url: string, accessToken: string): Promise<T> {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } });
    if (!res.ok) {
      throw new AdapterError(
        res.status === 429 ? "rate_limited" : res.status === 401 ? "auth_failed" : "upstream_error",
        `${this.displayName} API ${res.status}: ${(await res.text()).slice(0, 300)}`,
        res.status === 429 || res.status >= 500,
      );
    }
    return (await res.json()) as T;
  }
}
