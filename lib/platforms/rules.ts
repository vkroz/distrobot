import type { PlatformId } from "@/lib/types";

/**
 * Per-platform publishing limits.
 *
 * Values reflect public API docs as best known at `LAST_REVIEWED`. Platforms change these
 * frequently and some limits depend on account standing (e.g. YouTube unverified accounts,
 * X Premium, TikTok `creator_info`). Anything marked in `notes` as approximate should be
 * re-checked against the linked docs before relying on it. At runtime, adapters may tighten
 * these limits per account (see `PlatformRuleOverrides`).
 */
export const LAST_REVIEWED = "2026-10";

export const KB = 1024;
export const MB = 1024 * KB;
export const GB = 1024 * MB;

export type Orientation = "vertical" | "square" | "horizontal";
/** How caption length is counted by the platform. */
export type CountMode = "codepoints" | "utf16" | "x-weighted";

export interface TextRule {
  supported: boolean;
  required?: boolean;
  maxLength?: number;
  /** Soft limit: exceeding produces a warning (e.g. text hidden behind "more"). */
  recommendedMaxLength?: number;
  countMode?: CountMode;
  /** Characters the platform rejects in this field. */
  forbiddenChars?: string[];
  /** Human label used in UI/messages ("Description", "Post text"...). */
  label: string;
}

export interface HashtagRule {
  /** "inline": appended to the caption text. "tags": sent as a separate tag list. */
  placement: "inline" | "tags";
  /** Hard limit: exceeding is an error (post rejected or tags ignored). */
  max?: number;
  /** Soft limit: exceeding is a warning. */
  recommendedMax?: number;
}

export interface VideoRule {
  minDurationSec?: number;
  /** `undefined` = no documented limit. */
  maxDurationSec?: number;
  minFileSizeBytes?: number;
  maxFileSizeBytes?: number;
  mimeTypes: string[];
  /** Orientation the platform's feed is designed for; `null` = any works well. */
  preferredOrientation: Orientation | null;
  recommendedAspectRatios: string[];
  /** Allowed width/height ratio range (inclusive). Outside is an error. */
  minAspectRatio?: number;
  maxAspectRatio?: number;
  minWidth?: number;
  minHeight?: number;
}

export interface PlatformRules {
  platform: PlatformId;
  displayName: string;
  docsUrl: string;
  title: TextRule;
  caption: TextRule;
  hashtags: HashtagRule;
  video: VideoRule;
  /** YouTube Shorts-style classification for vertical/square short videos. */
  shortForm?: { maxDurationSec: number; name: string };
  notes: string[];
}

export type PlatformRuleOverrides = Partial<{
  title: Partial<TextRule>;
  caption: Partial<TextRule>;
  hashtags: Partial<HashtagRule>;
  video: Partial<VideoRule>;
}>;

const MP4 = "video/mp4";
const MOV = "video/quicktime";
const WEBM = "video/webm";

export const PLATFORM_RULES: Record<PlatformId, PlatformRules> = {
  youtube: {
    platform: "youtube",
    displayName: "YouTube",
    docsUrl: "https://developers.google.com/youtube/v3/docs/videos/insert",
    title: { supported: true, required: true, maxLength: 100, forbiddenChars: ["<", ">"], label: "Title" },
    caption: { supported: true, maxLength: 5000, countMode: "codepoints", forbiddenChars: ["<", ">"], label: "Description" },
    hashtags: { placement: "inline", max: 60, recommendedMax: 3 },
    video: {
      minDurationSec: 1,
      maxDurationSec: 12 * 60 * 60,
      maxFileSizeBytes: 256 * GB,
      mimeTypes: [MP4, MOV, WEBM, "video/x-msvideo", "video/x-flv", "video/mpeg", "video/3gpp", "video/x-ms-wmv"],
      preferredOrientation: "horizontal",
      recommendedAspectRatios: ["16:9"],
    },
    shortForm: { maxDurationSec: 180, name: "YouTube Short" },
    notes: [
      "Unverified accounts are limited to 15-minute videos.",
      "More than 60 hashtags causes YouTube to ignore all hashtags; the first 3 appear above the title.",
      "Vertical or square videos up to 3 minutes are classified as Shorts.",
      "Title and description may not contain '<' or '>'.",
    ],
  },
  tiktok: {
    platform: "tiktok",
    displayName: "TikTok",
    docsUrl: "https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
    title: { supported: false, label: "Title" },
    caption: { supported: true, maxLength: 2200, countMode: "utf16", label: "Caption" },
    hashtags: { placement: "inline", recommendedMax: 5 },
    video: {
      minDurationSec: 3,
      maxDurationSec: 10 * 60,
      maxFileSizeBytes: 4 * GB,
      mimeTypes: [MP4, WEBM, MOV],
      preferredOrientation: "vertical",
      recommendedAspectRatios: ["9:16"],
      minWidth: 360,
      minHeight: 360,
    },
    notes: [
      "Actual max duration is per-creator (creator_info.max_video_post_duration_sec); adapters should override.",
      "Unaudited API clients can only post privately (SELF_ONLY).",
    ],
  },
  instagram: {
    platform: "instagram",
    displayName: "Instagram Reels",
    docsUrl: "https://developers.facebook.com/docs/instagram-platform/content-publishing",
    title: { supported: false, label: "Title" },
    caption: { supported: true, maxLength: 2200, recommendedMaxLength: 125, countMode: "codepoints", label: "Caption" },
    hashtags: { placement: "inline", max: 30, recommendedMax: 5 },
    video: {
      minDurationSec: 3,
      maxDurationSec: 15 * 60,
      maxFileSizeBytes: 300 * MB,
      mimeTypes: [MP4, MOV],
      preferredOrientation: "vertical",
      recommendedAspectRatios: ["9:16"],
      minAspectRatio: 0.01,
      maxAspectRatio: 10,
    },
    notes: [
      "Requires an Instagram professional (Business/Creator) account.",
      "Captions are truncated after ~125 characters in the feed.",
      "Max 20 @mentions per caption.",
      "Non-9:16 videos are cropped in the Reels tab.",
    ],
  },
  x: {
    platform: "x",
    displayName: "X",
    docsUrl: "https://docs.x.com/x-api/media/upload-media",
    title: { supported: false, label: "Title" },
    caption: { supported: true, maxLength: 280, countMode: "x-weighted", label: "Post text" },
    hashtags: { placement: "inline", recommendedMax: 2 },
    video: {
      minDurationSec: 0.5,
      maxDurationSec: 140,
      maxFileSizeBytes: 512 * MB,
      mimeTypes: [MP4, MOV],
      preferredOrientation: null,
      recommendedAspectRatios: ["16:9", "1:1", "9:16"],
      minAspectRatio: 1 / 3,
      maxAspectRatio: 3,
      minWidth: 32,
      minHeight: 32,
    },
    notes: [
      "Premium accounts allow longer posts (25,000) and longer videos; override per account.",
      "URLs count as 23 characters; emoji and CJK characters count as 2.",
    ],
  },
  facebook: {
    platform: "facebook",
    displayName: "Facebook",
    docsUrl: "https://developers.facebook.com/docs/video-api/guides/publishing",
    title: { supported: true, maxLength: 255, label: "Title" },
    caption: { supported: true, maxLength: 63206, recommendedMaxLength: 500, countMode: "codepoints", label: "Description" },
    hashtags: { placement: "inline", recommendedMax: 3 },
    video: {
      minDurationSec: 1,
      maxDurationSec: 240 * 60,
      maxFileSizeBytes: 10 * GB,
      mimeTypes: [MP4, MOV],
      preferredOrientation: null,
      recommendedAspectRatios: ["16:9", "9:16", "1:1", "4:5"],
      minAspectRatio: 9 / 16,
      maxAspectRatio: 16 / 9,
    },
    notes: [
      "Publishes to a Facebook Page (personal profiles are not supported by the API).",
      "Title max length is approximate; Graph API does not document it precisely.",
      "Reels use a separate endpoint with 3–90s duration and 9:16 only (not modeled yet).",
    ],
  },
  linkedin: {
    platform: "linkedin",
    displayName: "LinkedIn",
    docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api",
    title: { supported: true, maxLength: 200, label: "Video title" },
    caption: { supported: true, maxLength: 3000, recommendedMaxLength: 210, countMode: "codepoints", label: "Post text" },
    hashtags: { placement: "inline", recommendedMax: 5 },
    video: {
      minDurationSec: 3,
      maxDurationSec: 30 * 60,
      minFileSizeBytes: 75 * KB,
      maxFileSizeBytes: 5 * GB,
      mimeTypes: [MP4],
      preferredOrientation: null,
      recommendedAspectRatios: ["16:9", "1:1", "9:16"],
      minAspectRatio: 1 / 2.4,
      maxAspectRatio: 2.4,
    },
    notes: [
      "Post text is collapsed after ~210 characters.",
      "Video title max length is approximate.",
    ],
  },
  vimeo: {
    platform: "vimeo",
    displayName: "Vimeo",
    docsUrl: "https://developer.vimeo.com/api/upload/videos",
    title: { supported: true, required: true, maxLength: 128, label: "Title" },
    caption: { supported: true, maxLength: 5000, countMode: "codepoints", label: "Description" },
    hashtags: { placement: "tags", max: 20 },
    video: {
      mimeTypes: [MP4, MOV, WEBM, "video/x-msvideo", "video/x-ms-wmv", "video/x-flv", "video/mpeg"],
      preferredOrientation: "horizontal",
      recommendedAspectRatios: ["16:9"],
    },
    notes: [
      "File size and weekly/total storage limits depend on the account plan; adapters should override from /me quota.",
      "Vimeo uses tags rather than inline hashtags; hashtags are mapped to tags.",
      "Title/description/tag-count limits are approximate.",
    ],
  },
};

export function getRules(platform: PlatformId, overrides?: PlatformRuleOverrides): PlatformRules {
  const base = PLATFORM_RULES[platform];
  if (!overrides) return base;
  return {
    ...base,
    title: { ...base.title, ...overrides.title },
    caption: { ...base.caption, ...overrides.caption },
    hashtags: { ...base.hashtags, ...overrides.hashtags },
    video: { ...base.video, ...overrides.video },
  };
}

/** Parse "9:16" → 0.5625. */
export function parseAspectRatio(ratio: string): number {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) throw new Error(`Invalid aspect ratio: ${ratio}`);
  return w / h;
}
