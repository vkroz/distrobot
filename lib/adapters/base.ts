import { getRules, type PlatformRuleOverrides, type PlatformRules } from "@/lib/platforms/rules";
import { validateForPlatform, type ValidationResult } from "@/lib/platforms/validate";
import type { ConnectedAccount, MediaInfo, PlatformId, TargetContent } from "@/lib/types";
import { sleep } from "./http";
import {
  buildAuthUrl,
  exchangeCode,
  readClientCredentials,
  refreshToken,
  type OAuthConfig,
  type TokenResponse,
} from "./oauth";
import {
  AdapterError,
  type AccountCredentials,
  type AdapterCapabilities,
  type DoPublishResult,
  type RefreshedTokens,
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

/** Default simulated latency for dry-run publishes. */
const DEFAULT_DRY_RUN_DELAY_MS = 1500;

/**
 * Shared adapter behaviour: rule-based validation, dry-run, generic OAuth2 code flow + refresh.
 * Subclasses provide `fetchProfile` and `doPublish`.
 */
export abstract class BaseAdapter implements PlatformAdapter {
  abstract readonly platform: PlatformId;
  protected abstract readonly oauth: OAuthConfig;

  get displayName(): string {
    return getRules(this.platform).displayName;
  }

  /** Subclasses declare optional features. */
  protected readonly features: { nativeScheduling?: boolean; thumbnail?: boolean; refreshTokens?: boolean } = {};

  get capabilities(): AdapterCapabilities {
    return {
      pkce: !!this.oauth.pkce,
      refreshTokens: this.features.refreshTokens ?? true,
      publish: this.doPublish !== BaseAdapter.prototype.doPublish,
      nativeScheduling: !!this.features.nativeScheduling,
      thumbnail: !!this.features.thumbnail,
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
    const payload = {
      ...validation.effective,
      visibility: req.visibility,
      scheduledAt: req.scheduledAt ?? null,
      thumbnail: !!req.thumbnail && this.capabilities.thumbnail,
    };
    if (ctx.dryRun) {
      await this.simulateUpload(ctx);
      return {
        url: `/dry-run/${req.jobId}`,
        externalId: `dry-run-${req.jobId}`,
        dryRun: true,
        payload,
        warnings,
      };
    }
    if (!ctx.account) throw new AdapterError("no_account", `No ${this.displayName} account connected.`);
    const result = await this.doPublish(req, { ...ctx, account: ctx.account }, validation);
    return {
      url: result.url,
      externalId: result.externalId,
      dryRun: false,
      payload: { ...payload, ...result.extra },
      warnings: [...warnings, ...(result.warnings ?? [])],
    };
  }

  private async simulateUpload(ctx: PublishContext): Promise<void> {
    const total = ctx.simulatedDelayMs ?? DEFAULT_DRY_RUN_DELAY_MS;
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      await sleep(total / steps, ctx.signal);
      ctx.onProgress?.({ phase: "uploading", fraction: i / steps });
    }
  }

  /** Real upload. Override per platform. */
  protected async doPublish(
    _req: PublishRequest,
    _ctx: PublishContext & { account: ConnectedAccount },
    _validation: ValidationResult,
  ): Promise<DoPublishResult> {
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

  /** Standard OAuth2 refresh_token grant. Override for platforms with non-standard refresh. */
  async refreshAccessToken(account: ConnectedAccount, fetchImpl: typeof fetch = fetch): Promise<RefreshedTokens> {
    const creds = readClientCredentials(this.oauth);
    if (!creds) throw new AdapterError("not_configured", `${this.displayName} OAuth is not configured.`);
    if (!account.refreshToken) throw new AdapterError("auth_failed", `${this.displayName} account has no refresh token; reconnect it.`);
    try {
      const token = await refreshToken(this.oauth, creds, account.refreshToken, fetchImpl);
      return {
        accessToken: token.access_token,
        // Many providers (Google) omit the refresh token on refresh: keep the old one.
        refreshToken: token.refresh_token ?? account.refreshToken,
        expiresAt: token.expires_in ? new Date(Date.now() + token.expires_in * 1000).toISOString() : null,
      };
    } catch (err) {
      throw new AdapterError("auth_failed", `Token refresh failed: ${(err as Error).message}`);
    }
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
