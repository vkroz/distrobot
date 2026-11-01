/**
 * TikTok Content Posting API — required posting UX (client-safe, no Node imports).
 *
 * TikTok's audit requires the posting screen to:
 *  - show the creator's nickname/avatar (from creator_info/query) so users know where they post;
 *  - let users pick a privacy level from creator_info.privacy_level_options with NO default;
 *  - offer Comment / Duet / Stitch toggles, off by default, disabled when creator_info says so;
 *  - offer a commercial content disclosure ("Your brand" / "Branded content") and show the
 *    resulting label and the consent declaration before posting;
 *  - block branded content with "Only me" visibility.
 * Guidelines: https://developers.tiktok.com/doc/content-sharing-guidelines
 * API:        https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
 */

export const TIKTOK_PRIVACY_LEVELS = [
  "PUBLIC_TO_EVERYONE",
  "MUTUAL_FOLLOW_FRIENDS",
  "FOLLOWER_OF_CREATOR",
  "SELF_ONLY",
] as const;
export type TikTokPrivacyLevel = (typeof TIKTOK_PRIVACY_LEVELS)[number];

export const TIKTOK_PRIVACY_LABELS: Record<TikTokPrivacyLevel, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

/** Stored in `post_targets.settings` for TikTok targets. */
export interface TikTokSettings {
  /** Must be chosen explicitly by the user — never defaulted. */
  privacyLevel?: TikTokPrivacyLevel | null;
  allowComment?: boolean;
  allowDuet?: boolean;
  allowStitch?: boolean;
  /** Commercial content disclosure. */
  commercial?: { enabled: boolean; yourBrand: boolean; brandedContent: boolean };
}

/** Normalized creator_info/query response. */
export interface TikTokCreatorInfo {
  nickname: string;
  username: string | null;
  avatarUrl: string | null;
  privacyLevelOptions: TikTokPrivacyLevel[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number | null;
}

/** Raw creator_info/query `data` → TikTokCreatorInfo. */
export function normalizeCreatorInfo(raw: Record<string, unknown>): TikTokCreatorInfo {
  const opts = Array.isArray(raw.privacy_level_options) ? raw.privacy_level_options : [];
  return {
    nickname: String(raw.creator_nickname ?? raw.creator_username ?? "TikTok creator"),
    username: typeof raw.creator_username === "string" ? raw.creator_username : null,
    avatarUrl: typeof raw.creator_avatar_url === "string" ? raw.creator_avatar_url : null,
    privacyLevelOptions: opts.filter((o): o is TikTokPrivacyLevel => (TIKTOK_PRIVACY_LEVELS as readonly unknown[]).includes(o)),
    commentDisabled: raw.comment_disabled === true,
    duetDisabled: raw.duet_disabled === true,
    stitchDisabled: raw.stitch_disabled === true,
    maxVideoPostDurationSec: typeof raw.max_video_post_duration_sec === "number" ? raw.max_video_post_duration_sec : null,
  };
}

/** Used in dry-run / when no TikTok account is connected. */
export const MOCK_CREATOR_INFO: TikTokCreatorInfo = {
  nickname: "Demo Creator (mock)",
  username: "demo.creator",
  avatarUrl: null,
  privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: true,
  maxVideoPostDurationSec: 600,
};

export function parseTikTokSettings(raw: unknown): TikTokSettings {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const c = (s.commercial && typeof s.commercial === "object" ? s.commercial : {}) as Record<string, unknown>;
  return {
    privacyLevel: (TIKTOK_PRIVACY_LEVELS as readonly unknown[]).includes(s.privacyLevel)
      ? (s.privacyLevel as TikTokPrivacyLevel)
      : null,
    allowComment: s.allowComment === true,
    allowDuet: s.allowDuet === true,
    allowStitch: s.allowStitch === true,
    commercial: { enabled: c.enabled === true, yourBrand: c.yourBrand === true, brandedContent: c.brandedContent === true },
  };
}

export interface TikTokSettingsIssue {
  code:
    | "tiktok_privacy_required"
    | "tiktok_privacy_not_allowed"
    | "tiktok_interaction_disabled"
    | "tiktok_commercial_incomplete"
    | "tiktok_branded_private"
    | "tiktok_duration_exceeded";
  message: string;
}

/** Validate TikTok posting settings (and creator constraints when known). */
export function validateTikTokSettings(
  raw: unknown,
  creator?: TikTokCreatorInfo | null,
  durationSec?: number,
): TikTokSettingsIssue[] {
  const s = parseTikTokSettings(raw);
  const issues: TikTokSettingsIssue[] = [];
  if (!s.privacyLevel) {
    issues.push({ code: "tiktok_privacy_required", message: "Choose who can view this TikTok (no default is allowed)." });
  } else if (creator && creator.privacyLevelOptions.length && !creator.privacyLevelOptions.includes(s.privacyLevel)) {
    issues.push({
      code: "tiktok_privacy_not_allowed",
      message: `"${TIKTOK_PRIVACY_LABELS[s.privacyLevel]}" isn't available for this TikTok account.`,
    });
  }
  if (creator) {
    const disabled = [
      s.allowComment && creator.commentDisabled && "comments",
      s.allowDuet && creator.duetDisabled && "Duet",
      s.allowStitch && creator.stitchDisabled && "Stitch",
    ].filter(Boolean);
    if (disabled.length) {
      issues.push({
        code: "tiktok_interaction_disabled",
        message: `This creator has turned off ${disabled.join(", ")} in TikTok settings.`,
      });
    }
    if (creator.maxVideoPostDurationSec && durationSec && durationSec > creator.maxVideoPostDurationSec) {
      issues.push({
        code: "tiktok_duration_exceeded",
        message: `This creator can post videos up to ${creator.maxVideoPostDurationSec}s.`,
      });
    }
  }
  const c = s.commercial!;
  if (c.enabled && !c.yourBrand && !c.brandedContent) {
    issues.push({
      code: "tiktok_commercial_incomplete",
      message: "You need to indicate if your content promotes yourself, a third party, or both.",
    });
  }
  if (c.enabled && c.brandedContent && s.privacyLevel === "SELF_ONLY") {
    issues.push({ code: "tiktok_branded_private", message: "Branded content visibility can't be set to private (Only me)." });
  }
  return issues;
}

/** Label TikTok will show on the post for the chosen disclosure, if any. */
export function commercialLabel(raw: unknown): string | null {
  const c = parseTikTokSettings(raw).commercial!;
  if (!c.enabled) return null;
  if (c.brandedContent) return "Paid partnership";
  if (c.yourBrand) return "Promotional content";
  return null;
}

export const TIKTOK_LINKS = {
  musicUsage: "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en",
  brandedContentPolicy: "https://www.tiktok.com/legal/page/global/bc-policy/en",
};

/** Declaration TikTok requires to be shown before the user posts. */
export function consentText(raw: unknown): string {
  const c = parseTikTokSettings(raw).commercial!;
  return c.enabled && c.brandedContent
    ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
    : "By posting, you agree to TikTok's Music Usage Confirmation.";
}

/** TikTok Direct Post `post_info` fields derived from settings. */
export function tiktokPostInfo(raw: unknown, creator?: TikTokCreatorInfo | null) {
  const s = parseTikTokSettings(raw);
  const c = s.commercial!;
  return {
    privacy_level: s.privacyLevel,
    disable_comment: !s.allowComment || !!creator?.commentDisabled,
    disable_duet: !s.allowDuet || !!creator?.duetDisabled,
    disable_stitch: !s.allowStitch || !!creator?.stitchDisabled,
    brand_organic_toggle: c.enabled && c.yourBrand,
    brand_content_toggle: c.enabled && c.brandedContent,
  };
}
