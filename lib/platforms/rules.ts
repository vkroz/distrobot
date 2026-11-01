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
export const LAST_REVIEWED = "2026-11";

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
  /** Max characters per tag (tag-list platforms). */
  maxTagLength?: number;
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
    // post_info.title: "The maximum length is 2200 in UTF-16 runes."
    // (https://developers.tiktok.com/doc/content-posting-api-reference-direct-post)
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
    // 280 weighted chars (URLs = 23, CJK/emoji = 2): https://docs.x.com/fundamentals/counting-characters
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
    // Graph API documents NO length limit for video `title` or `description`
    // (https://developers.facebook.com/docs/graph-api/reference/page/videos/,
    //  https://developers.facebook.com/docs/graph-api/reference/video/). 100 for the title is the
    // convention used by third-party tools → soft warning only; the API's own error is authoritative.
    title: { supported: true, recommendedMaxLength: 100, label: "Title" },
    // 63,206 is widely cited for Facebook post text but is NOT stated in Meta's docs (community-sourced).
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
      "Video title/description limits are not documented by Meta: the 100-char title is a soft guideline and the 63,206-char description cap is community-sourced.",
      "Reels use a separate endpoint with 3–90s duration and 9:16 only (not modeled yet).",
    ],
  },
  linkedin: {
    platform: "linkedin",
    displayName: "LinkedIn",
    docsUrl: "https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api",
    // Posts API `content.media.title`: no documented limit
    // (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/post-api-schema).
    // 200 is an app-chosen soft cap; LinkedIn answers FIELD_LENGTH_TOO_LONG if a field is too long.
    title: { supported: true, recommendedMaxLength: 200, label: "Video title" },
    // 3,000: "The character limit for a post is 3000 characters." (https://www.linkedin.com/help/linkedin/answer/86780)
    // and "The maximum length of the text of a UGC Post is 3,000 characters."
    // (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/ugc-post-api)
    caption: { supported: true, maxLength: 3000, recommendedMaxLength: 210, countMode: "codepoints", label: "Post text" },
    hashtags: { placement: "inline", recommendedMax: 5 },
    video: {
      minDurationSec: 3,
      maxDurationSec: 30 * 60,
      // Videos API: 3 s – 30 min, 75 KB – 500 MB, MP4
      // (https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api)
      minFileSizeBytes: 75 * KB,
      maxFileSizeBytes: 500 * MB,
      mimeTypes: [MP4],
      preferredOrientation: null,
      recommendedAspectRatios: ["16:9", "1:1", "9:16"],
      minAspectRatio: 1 / 2.4,
      maxAspectRatio: 2.4,
    },
    notes: [
      "Post text is collapsed after ~210 characters.",
      "Video title limit is not documented by LinkedIn; 200 chars is a soft app guideline.",
    ],
  },
  vimeo: {
    platform: "vimeo",
    displayName: "Vimeo",
    docsUrl: "https://developer.vimeo.com/api/upload/videos",
    // 128: shown as the title field's character counter ("8/128") in Vimeo's Help Center
    // (https://help.vimeo.com/hc/en-us/articles/12426476611857); not stated in the API spec.
    title: { supported: true, required: true, maxLength: 128, label: "Title" },
    // Description: no documented limit (API spec https://github.com/vimeo/openapi has no maxLength) → not enforced.
    caption: { supported: true, countMode: "codepoints", label: "Description" },
    // "You can use up to 20 tags for each video." (https://help.vimeo.com/hc/en-us/articles/12426157049105)
    // and the API returns 403 "The total number of tags can't exceed 20." Per-tag 32 chars:
    // "Individual tags may not exceed 32 characters." (https://help.vimeo.com/hc/en-us/articles/35291502879889)
    hashtags: { placement: "tags", max: 20, maxTagLength: 32 },
    video: {
      mimeTypes: [MP4, MOV, WEBM, "video/x-msvideo", "video/x-ms-wmv", "video/x-flv", "video/mpeg"],
      preferredOrientation: "horizontal",
      recommendedAspectRatios: ["16:9"],
    },
    notes: [
      "File size and weekly/total storage limits depend on the account plan; adapters should override from /me quota.",
      "Vimeo uses tags rather than inline hashtags; hashtags are mapped to tags.",
      "Tag limits (20 tags, 32 chars each) are documented; the 128-char title comes from the Help Center UI; description length is undocumented and not enforced.",
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
