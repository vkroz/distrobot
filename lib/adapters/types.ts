import type { PlatformRuleOverrides, PlatformRules } from "@/lib/platforms/rules";
import type { ValidationResult } from "@/lib/platforms/validate";
import type { ConnectedAccount, Media, MediaInfo, PlatformId, TargetContent } from "@/lib/types";

export interface PublishRequest {
  jobId: string;
  content: TargetContent;
  media: Media;
  /** Absolute path to the media file on local disk. */
  mediaPath: string;
  /** Platform-specific target settings (privacy, category, ...). */
  settings: Record<string, unknown>;
}

export interface PublishProgress {
  phase: "uploading" | "processing";
  /** 0..1 when known. */
  fraction?: number;
}

export interface PublishContext {
  account: ConnectedAccount | null;
  /** Validate and simulate only — never calls the platform API. */
  dryRun: boolean;
  signal?: AbortSignal;
  onProgress?: (p: PublishProgress) => void;
  fetch?: typeof fetch;
}

export interface PublishResult {
  url: string | null;
  externalId: string | null;
  dryRun: boolean;
  /** What was (or would have been) sent. */
  payload: ValidationResult["effective"];
  warnings: string[];
}

export interface AuthUrlParams {
  state: string;
  redirectUri: string;
  /** Required by adapters with `capabilities.pkce`. S256 challenge. */
  codeChallenge?: string;
}

export interface CallbackParams {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  fetch?: typeof fetch;
}

/** Credentials + identity returned by OAuth; persisted as a ConnectedAccount. */
export type AccountCredentials = Omit<ConnectedAccount, "id" | "createdAt" | "updatedAt">;

export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly displayName: string;
  readonly capabilities: { pkce: boolean; refreshTokens: boolean; publish: boolean };

  /** Whether OAuth client credentials are present in the environment. */
  isConfigured(): boolean;
  /** Rules, tightened/relaxed for a specific account (e.g. TikTok creator limits, X Premium). */
  getRules(account?: ConnectedAccount | null): PlatformRules;
  validate(content: TargetContent, media?: MediaInfo, account?: ConnectedAccount | null): ValidationResult;
  publish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult>;
  getAuthUrl(params: AuthUrlParams): string;
  handleCallback(params: CallbackParams): Promise<AccountCredentials>;
}

export type AdapterErrorCode =
  | "not_configured"
  | "not_implemented"
  | "no_account"
  | "validation_failed"
  | "auth_failed"
  | "rate_limited"
  | "upstream_error";

export class AdapterError extends Error {
  constructor(
    public readonly code: AdapterErrorCode,
    message: string,
    /** Whether the job runner should retry automatically. */
    public readonly retryable = false,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

export type { PlatformRuleOverrides };
