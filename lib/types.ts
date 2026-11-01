/** Shared domain types. Kept free of Node/DB imports so they can be used client-side. */

export const PLATFORM_IDS = [
  "youtube",
  "tiktok",
  "instagram",
  "x",
  "facebook",
  "linkedin",
  "vimeo",
] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

export function isPlatformId(value: unknown): value is PlatformId {
  return typeof value === "string" && (PLATFORM_IDS as readonly string[]).includes(value);
}

export const JOB_STATUSES = ["queued", "uploading", "published", "failed"] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const POST_STATUSES = ["draft", "scheduled", "publishing", "published", "partial", "failed"] as const;
export type PostStatus = (typeof POST_STATUSES)[number];

/** Technical metadata about the uploaded video file. All fields optional: probing may be incomplete. */
export interface MediaInfo {
  mimeType?: string;
  sizeBytes?: number;
  durationSec?: number;
  width?: number;
  height?: number;
}

export interface Media extends MediaInfo {
  id: string;
  originalFilename: string;
  storagePath: string;
  checksum: string | null;
  createdAt: string;
}

export interface Post {
  id: string;
  title: string;
  caption: string;
  hashtags: string[];
  mediaId: string | null;
  status: PostStatus;
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Per-platform destination for a post. `null` overrides fall back to the post's defaults. */
export interface PostTarget {
  id: string;
  postId: string;
  platform: PlatformId;
  accountId: string | null;
  enabled: boolean;
  titleOverride: string | null;
  captionOverride: string | null;
  hashtagsOverride: string[] | null;
  /** Platform-specific options (privacy, category, made-for-kids, etc.). */
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PublishJob {
  id: string;
  postId: string;
  targetId: string;
  platform: PlatformId;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  dryRun: boolean;
  resultUrl: string | null;
  externalId: string | null;
  error: string | null;
  nextRunAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectedAccount {
  id: string;
  platform: PlatformId;
  externalId: string;
  displayName: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
  scopes: string[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** Fully resolved content for one platform (post defaults + target overrides). */
export interface TargetContent {
  title: string;
  caption: string;
  hashtags: string[];
}
