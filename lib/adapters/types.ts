import type { PlatformRuleOverrides, PlatformRules } from "@/lib/platforms/rules";
import type { ValidationResult } from "@/lib/platforms/validate";
import type { ConnectedAccount, Media, MediaInfo, PlatformId, TargetContent, Visibility } from "@/lib/types";

export interface PublishRequest {
  jobId: string;
  content: TargetContent;
  media: Media;
  /** Absolute path to the video file on local disk. */
  mediaPath: string;
  /** Optional custom thumbnail (image) on local disk. */
  thumbnail?: { path: string; mimeType: string; sizeBytes: number } | null;
  visibility: Visibility;
  /** ISO time the post should go live. Only set for adapters with `capabilities.nativeScheduling`. */
  scheduledAt?: string | null;
  /** Platform-specific target settings (privacy, category, page id, ...). */
  settings: Record<string, unknown>;
  /** Resume state saved by a previous attempt via `ctx.saveCheckpoint`. */
  checkpoint?: unknown;
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
  /** Simulated latency for dry-run publishes (ms). */
  simulatedDelayMs?: number;
  signal?: AbortSignal;
  onProgress?: (p: PublishProgress) => void;
  /** Persist resume state (e.g. an upload session URL) so a retry can continue. */
  saveCheckpoint?: (data: unknown) => void;
  fetch?: typeof fetch;
}

export interface PublishResult {
  url: string | null;
  externalId: string | null;
  dryRun: boolean;
  /** What was (or would have been) sent. */
  payload: ValidationResult["effective"] & Record<string, unknown>;
  warnings: string[];
}

/** What a concrete adapter's real upload returns (BaseAdapter adds payload/warnings/dryRun). */
export interface DoPublishResult {
  url: string | null;
  externalId: string | null;
  warnings?: string[];
  /** Extra platform-specific fields to record (e.g. YouTube publishAt). */
  extra?: Record<string, unknown>;
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

export type RefreshedTokens = Pick<ConnectedAccount, "accessToken" | "refreshToken" | "expiresAt">;

export interface AdapterCapabilities {
  pkce: boolean;
  refreshTokens: boolean;
  /** Has a real (non-dry-run) publish implementation. */
  publish: boolean;
  /** Platform schedules natively (upload now, goes live at `scheduledAt`). */
  nativeScheduling: boolean;
  /** Supports setting a custom thumbnail. */
  thumbnail: boolean;
}

export interface PlatformAdapter {
  readonly platform: PlatformId;
  readonly displayName: string;
  readonly capabilities: AdapterCapabilities;

  /** Env vars holding this platform's OAuth client credentials. */
  readonly credentialEnvVars: string[];
  /** Whether OAuth client credentials are present in the environment. */
  isConfigured(): boolean;
  /** Rules, tightened/relaxed for a specific account (e.g. TikTok creator limits, X Premium). */
  getRules(account?: ConnectedAccount | null): PlatformRules;
  /** Pass `settings` to also check platform-specific posting settings (e.g. TikTok privacy). */
  validate(
    content: TargetContent,
    media?: MediaInfo,
    account?: ConnectedAccount | null,
    settings?: Record<string, unknown>,
  ): ValidationResult;
  publish(req: PublishRequest, ctx: PublishContext): Promise<PublishResult>;
  getAuthUrl(params: AuthUrlParams): string;
  handleCallback(params: CallbackParams): Promise<AccountCredentials>;
  refreshAccessToken(account: ConnectedAccount, fetchImpl?: typeof fetch): Promise<RefreshedTokens>;
}

export type AdapterErrorCode =
  | "not_configured"
  | "not_implemented"
  | "no_account"
  | "validation_failed"
  | "auth_failed"
  | "rate_limited"
  | "quota_exceeded"
  | "upstream_error"
  | "aborted";

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
