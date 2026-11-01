import { getAdapter as defaultGetAdapter, type PlatformAdapter } from "@/lib/adapters";
import { transaction, type DB } from "@/lib/db";
import {
  createPost,
  enqueuePublish,
  getMedia,
  getPost,
  listAccounts,
  listJobs,
  listPosts,
  listTargets,
  upsertTarget,
} from "@/lib/db/repo";
import { dryRunModeFromEnv, shouldDryRun, type DryRunMode } from "@/lib/jobs/runner";
import { getRules } from "@/lib/platforms/rules";
import { resolveTargetContent, type ValidationResult } from "@/lib/platforms/validate";
import {
  isPlatformId,
  VISIBILITIES,
  type ConnectedAccount,
  type Media,
  type PlatformId,
  type Post,
  type PostTarget,
  type PublishJob,
  type Visibility,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

export interface ComposeTargetInput {
  platform: PlatformId;
  accountId?: string | null;
  titleOverride?: string | null;
  captionOverride?: string | null;
  hashtagsOverride?: string[] | null;
  settings?: Record<string, unknown>;
}

export interface ComposeInput {
  title: string;
  caption: string;
  hashtags: string[];
  mediaId: string;
  thumbnailId?: string | null;
  visibility: Visibility;
  /** ISO timestamp; omitted/null = publish now. */
  scheduledAt?: string | null;
  targets: ComposeTargetInput[];
  /** "draft" saves only; "publish" validates strictly and enqueues jobs. */
  action: "draft" | "publish";
  /** Force dry-run for this post's jobs. */
  dryRun?: boolean;
}

export class ComposeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly validation?: ValidationResult[],
  ) {
    super(message);
  }
}

const str = (v: unknown, max = 100_000) => (typeof v === "string" ? v.slice(0, max) : "");
const optStr = (v: unknown) => (typeof v === "string" ? v : null);
const strArr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** Parse untrusted JSON into ComposeInput (throws ComposeError 400). */
export function parseComposeInput(body: unknown): ComposeInput {
  if (!body || typeof body !== "object") throw new ComposeError("Body must be a JSON object", 400);
  const b = body as Record<string, unknown>;
  if (typeof b.mediaId !== "string" || !b.mediaId) throw new ComposeError("mediaId is required", 400);
  const visibility = (VISIBILITIES as readonly string[]).includes(String(b.visibility)) ? (b.visibility as Visibility) : "public";
  let scheduledAt: string | null = null;
  if (b.scheduledAt) {
    const t = Date.parse(String(b.scheduledAt));
    if (Number.isNaN(t)) throw new ComposeError("scheduledAt is not a valid date", 400);
    scheduledAt = new Date(t).toISOString();
  }
  if (!Array.isArray(b.targets) || b.targets.length === 0) throw new ComposeError("Select at least one platform", 400);
  const seen = new Set<string>();
  const targets: ComposeTargetInput[] = b.targets.map((raw) => {
    const t = (raw ?? {}) as Record<string, unknown>;
    if (!isPlatformId(t.platform)) throw new ComposeError(`Unknown platform: ${String(t.platform)}`, 400);
    if (seen.has(t.platform)) throw new ComposeError(`Duplicate platform: ${t.platform}`, 400);
    seen.add(t.platform);
    return {
      platform: t.platform,
      accountId: optStr(t.accountId),
      titleOverride: optStr(t.titleOverride),
      captionOverride: optStr(t.captionOverride),
      hashtagsOverride: Array.isArray(t.hashtagsOverride) ? strArr(t.hashtagsOverride) : null,
      settings: t.settings && typeof t.settings === "object" ? (t.settings as Record<string, unknown>) : {},
    };
  });
  return {
    title: str(b.title, 1000),
    caption: str(b.caption),
    hashtags: strArr(b.hashtags),
    mediaId: b.mediaId,
    thumbnailId: optStr(b.thumbnailId),
    visibility,
    scheduledAt,
    targets,
    action: b.action === "draft" ? "draft" : "publish",
    dryRun: b.dryRun === true,
  };
}

export interface ComposeDeps {
  getAdapter?: (p: PlatformId) => PlatformAdapter;
  now?: Date;
}

export interface ComposeResult {
  post: Post;
  targets: PostTarget[];
  jobs: PublishJob[];
  validation: ValidationResult[];
}

/**
 * Create a post + per-platform targets; when publishing, validate every target (errors block)
 * and enqueue one job per target. Platforms with native scheduling get their job immediately.
 */
export function composePost(db: DB, input: ComposeInput, deps: ComposeDeps = {}): ComposeResult {
  const getAdapter = deps.getAdapter ?? defaultGetAdapter;
  const now = deps.now ?? new Date();
  const media = getMedia(db, input.mediaId);
  if (!media || media.kind !== "video") throw new ComposeError("Video not found; upload it first", 400);
  if (input.thumbnailId) {
    const thumb = getMedia(db, input.thumbnailId);
    if (!thumb || thumb.kind !== "image") throw new ComposeError("Thumbnail not found", 400);
  }
  if (input.action === "publish" && input.scheduledAt && Date.parse(input.scheduledAt) < now.getTime() - 60_000) {
    throw new ComposeError("Scheduled time is in the past", 400);
  }

  const accountFor = (t: ComposeTargetInput): ConnectedAccount | null => {
    const accounts = listAccounts(db, t.platform);
    return (t.accountId ? accounts.find((a) => a.id === t.accountId) : accounts[0]) ?? null;
  };

  const validation = input.targets.map((t) =>
    getAdapter(t.platform).validate(
      resolveTargetContent(input, { titleOverride: t.titleOverride ?? null, captionOverride: t.captionOverride ?? null, hashtagsOverride: t.hashtagsOverride ?? null }),
      media,
      accountFor(t),
    ),
  );
  if (input.action === "publish" && validation.some((v) => !v.ok)) {
    const bad = validation.filter((v) => !v.ok).map((v) => getRules(v.platform).displayName);
    throw new ComposeError(`Fix errors for ${bad.join(", ")} before publishing`, 422, validation);
  }

  return transaction(db, () => {
    const post = createPost(db, {
      title: input.title,
      caption: input.caption,
      hashtags: input.hashtags,
      mediaId: input.mediaId,
      thumbnailId: input.thumbnailId ?? null,
      visibility: input.visibility,
      scheduledAt: input.scheduledAt ?? null,
    });
    const targets = input.targets.map((t) =>
      upsertTarget(db, post.id, t.platform, {
        accountId: accountFor(t)?.id ?? null,
        titleOverride: t.titleOverride ?? null,
        captionOverride: t.captionOverride ?? null,
        hashtagsOverride: t.hashtagsOverride ?? null,
        settings: t.settings ?? {},
      }),
    );
    const jobs =
      input.action === "publish"
        ? enqueuePublish(db, post.id, {
            dryRun: input.dryRun,
            runAtFor: (t, p) =>
              p.scheduledAt && !getAdapter(t.platform).capabilities.nativeScheduling ? p.scheduledAt : now.toISOString(),
          })
        : [];
    return { post: getPost(db, post.id)!, targets, jobs, validation };
  });
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

export interface TargetSummary extends PostTarget {
  /** Latest job for this target. */
  job: PublishJob | null;
}

export interface PostSummary extends Post {
  media: Media | null;
  thumbnail: Media | null;
  targets: TargetSummary[];
}

export function getPostSummary(db: DB, id: string): PostSummary | null {
  const post = getPost(db, id);
  if (!post) return null;
  const jobs = listJobs(db, id);
  return {
    ...post,
    media: post.mediaId ? getMedia(db, post.mediaId) : null,
    thumbnail: post.thumbnailId ? getMedia(db, post.thumbnailId) : null,
    targets: listTargets(db, id).map((t) => ({
      ...t,
      // listJobs is ordered by created_at; the last one for a target is the latest attempt chain.
      job: jobs.filter((j) => j.targetId === t.id).at(-1) ?? null,
    })),
  };
}

export function listPostSummaries(db: DB, limit = 200): PostSummary[] {
  return listPosts(db, limit)
    .map((p) => getPostSummary(db, p.id))
    .filter((p): p is PostSummary => p !== null);
}

/** Account without secrets, safe to send to the browser. */
export interface PublicAccount {
  id: string;
  platform: PlatformId;
  externalId: string;
  displayName: string;
  expiresAt: string | null;
  scopes: string[];
  createdAt: string;
}

export const toPublicAccount = (a: ConnectedAccount): PublicAccount => ({
  id: a.id,
  platform: a.platform,
  externalId: a.externalId,
  displayName: a.displayName,
  expiresAt: a.expiresAt,
  scopes: a.scopes,
  createdAt: a.createdAt,
});

export interface PlatformStatus {
  platform: PlatformId;
  displayName: string;
  /** OAuth client credentials present. */
  configured: boolean;
  /** Jobs for this platform would currently run as dry-run. */
  dryRun: boolean;
  capabilities: PlatformAdapter["capabilities"];
  /** Env vars to set to enable real publishing. */
  envVars: string[];
  /** OAuth redirect URI to register with the provider. */
  redirectUri: string;
  accounts: PublicAccount[];
}

export function platformStatuses(
  db: DB,
  adapters: PlatformAdapter[],
  mode: DryRunMode = dryRunModeFromEnv(),
  baseUrl = "http://localhost:3000",
): PlatformStatus[] {
  return adapters.map((a) => ({
    platform: a.platform,
    displayName: a.displayName,
    configured: a.isConfigured(),
    dryRun: shouldDryRun(a, { dryRun: false }, mode),
    capabilities: a.capabilities,
    envVars: a.credentialEnvVars,
    redirectUri: `${baseUrl}/api/auth/${a.platform}/callback`,
    accounts: listAccounts(db, a.platform).map(toPublicAccount),
  }));
}
