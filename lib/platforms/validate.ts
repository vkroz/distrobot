import type { MediaInfo, PlatformId, Post, PostTarget, TargetContent } from "@/lib/types";
import {
  getRules,
  parseAspectRatio,
  type Orientation,
  type PlatformRuleOverrides,
  type PlatformRules,
  type TextRule,
} from "./rules";
import { countText, extractHashtags, normalizeHashtags, removeHashtags, truncateText } from "./text";

export type Severity = "error" | "warning" | "info";
export type IssueField = "title" | "caption" | "hashtags" | "media";

export type IssueCode =
  | "title_required"
  | "title_too_long"
  | "title_ignored"
  | "forbidden_chars"
  | "caption_too_long"
  | "caption_folded"
  | "too_many_hashtags"
  | "many_hashtags"
  | "unsupported_format"
  | "file_too_large"
  | "file_too_small"
  | "too_long"
  | "too_short"
  | "aspect_ratio_out_of_range"
  | "orientation_mismatch"
  | "resolution_too_low"
  | "classified_short_form"
  | "media_metadata_missing";

export interface ValidationIssue {
  severity: Severity;
  code: IssueCode;
  field: IssueField;
  message: string;
  limit?: number;
  actual?: number;
}

interface AdaptationBase {
  description: string;
  /** True when the adaptation only touches text and can be applied without media processing. */
  automatic: boolean;
}

export type Adaptation =
  | (AdaptationBase & { type: "truncate_title"; title: string })
  | (AdaptationBase & { type: "derive_title"; title: string })
  | (AdaptationBase & { type: "strip_forbidden_chars"; field: "title" | "caption"; value: string })
  | (AdaptationBase & { type: "truncate_caption"; caption: string; hashtags: string[] })
  | (AdaptationBase & { type: "trim_hashtags"; caption: string; hashtags: string[] })
  | (AdaptationBase & { type: "reframe"; from: Orientation; targetAspectRatio: string; mode: "crop" | "pad" })
  | (AdaptationBase & { type: "trim_duration"; maxDurationSec: number })
  | (AdaptationBase & { type: "compress"; maxFileSizeBytes: number })
  | (AdaptationBase & { type: "transcode"; mimeType: string });

export interface ValidationInput {
  platform: PlatformId;
  content: TargetContent;
  /** Omit to validate text only (e.g. while drafting before upload). */
  media?: MediaInfo;
  overrides?: PlatformRuleOverrides;
}

export interface ValidationResult {
  platform: PlatformId;
  ok: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  infos: ValidationIssue[];
  adaptations: Adaptation[];
  /** What would actually be sent: caption with inline hashtags appended, or separate tags. */
  effective: { title: string | null; caption: string; tags: string[] };
  orientation: Orientation | null;
  shortForm: boolean;
}

// ---------------------------------------------------------------------------
// Content resolution
// ---------------------------------------------------------------------------

/** Merge post defaults with a target's overrides. */
export function resolveTargetContent(
  post: Pick<Post, "title" | "caption" | "hashtags">,
  target?: Pick<PostTarget, "titleOverride" | "captionOverride" | "hashtagsOverride"> | null,
): TargetContent {
  return {
    title: target?.titleOverride ?? post.title,
    caption: target?.captionOverride ?? post.caption,
    hashtags: normalizeHashtags(target?.hashtagsOverride ?? post.hashtags),
  };
}

/** Hashtags from the explicit list that aren't already written inline in the caption. */
function hashtagsToAppend(content: TargetContent): string[] {
  const inline = new Set(extractHashtags(content.caption).map((t) => t.toLowerCase()));
  return normalizeHashtags(content.hashtags).filter((t) => !inline.has(t.toLowerCase()));
}

function hashtagSuffix(content: TargetContent): string {
  const extra = hashtagsToAppend(content);
  if (extra.length === 0) return "";
  const sep = content.caption.trim() ? "\n\n" : "";
  return sep + extra.map((t) => `#${t}`).join(" ");
}

/** Build the text/tags actually sent to the platform. */
export function composeContent(content: TargetContent, rules: PlatformRules): ValidationResult["effective"] {
  const title = rules.title.supported ? content.title.trim() : null;
  if (rules.hashtags.placement === "tags") {
    const tags = normalizeHashtags([...extractHashtags(content.caption), ...content.hashtags]);
    return { title, caption: content.caption.trim(), tags };
  }
  return { title, caption: (content.caption.trim() + hashtagSuffix({ ...content, caption: content.caption.trim() })).trim(), tags: [] };
}

function allHashtags(content: TargetContent): string[] {
  return normalizeHashtags([...extractHashtags(content.caption), ...content.hashtags]);
}

// ---------------------------------------------------------------------------
// Media helpers
// ---------------------------------------------------------------------------

export function classifyOrientation(width: number, height: number): Orientation {
  const ratio = width / height;
  if (ratio < 0.8) return "vertical";
  if (ratio > 1.25) return "horizontal";
  return "square";
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${units[i]}`;
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  const parts = h ? [`${h}h`, m ? `${m}m` : "", s ? `${s}s` : ""] : [`${m}m`, s ? `${s}s` : ""];
  return parts.filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

class Collector {
  issues: ValidationIssue[] = [];
  adaptations: Adaptation[] = [];
  add(issue: ValidationIssue) {
    this.issues.push(issue);
  }
  suggest(a: Adaptation) {
    this.adaptations.push(a);
  }
}

function stripChars(value: string, chars: string[]): string {
  let out = value;
  for (const c of chars) out = out.split(c).join("");
  return out;
}

/** Flags forbidden characters and returns the value with them removed. */
function checkForbidden(c: Collector, field: "title" | "caption", value: string, rule: TextRule): string {
  if (!rule.forbiddenChars?.length) return value;
  const found = rule.forbiddenChars.filter((ch) => value.includes(ch));
  if (found.length === 0) return value;
  const stripped = stripChars(value, found);
  c.add({
    severity: "error",
    code: "forbidden_chars",
    field,
    message: `${rule.label} contains characters not allowed: ${found.join(" ")}`,
  });
  c.suggest({
    type: "strip_forbidden_chars",
    field,
    value: stripped,
    automatic: true,
    description: `Remove ${found.join(" ")} from ${rule.label.toLowerCase()}`,
  });
  return stripped;
}

function validateTitle(c: Collector, rules: PlatformRules, content: TargetContent) {
  const rule = rules.title;
  const title = content.title.trim();
  if (!rule.supported) {
    if (title) {
      c.add({
        severity: "info",
        code: "title_ignored",
        field: "title",
        message: `${rules.displayName} has no separate title; it will not be published.`,
      });
    }
    return;
  }
  const mode = rule.countMode ?? "codepoints";
  if (!title && rule.required) {
    c.add({ severity: "error", code: "title_required", field: "title", message: `${rules.displayName} requires a ${rule.label.toLowerCase()}.` });
    const firstLine = content.caption.trim().split("\n")[0]?.trim() ?? "";
    const derived = removeHashtags(firstLine, extractHashtags(firstLine));
    if (derived) {
      c.suggest({
        type: "derive_title",
        title: rule.maxLength ? truncateText(derived, rule.maxLength, mode) : derived,
        automatic: true,
        description: "Use the first line of the caption as the title",
      });
    }
    return;
  }
  const cleanTitle = checkForbidden(c, "title", title, rule);
  const len = countText(title, mode);
  if (rule.maxLength && len > rule.maxLength) {
    c.add({
      severity: "error",
      code: "title_too_long",
      field: "title",
      message: `${rule.label} is ${len} characters; ${rules.displayName} allows ${rule.maxLength}.`,
      limit: rule.maxLength,
      actual: len,
    });
    c.suggest({
      type: "truncate_title",
      title: truncateText(cleanTitle, rule.maxLength, mode),
      automatic: true,
      description: `Shorten ${rule.label.toLowerCase()} to ${rule.maxLength} characters`,
    });
  }
}

/** Returns content after any hashtag trimming so caption truncation builds on it. */
function validateHashtags(c: Collector, rules: PlatformRules, content: TargetContent): TargetContent {
  const { max, recommendedMax } = rules.hashtags;
  const tags = allHashtags(content);
  if (max !== undefined && tags.length > max) {
    const dropped = tags.slice(max);
    const droppedSet = new Set(dropped.map((t) => t.toLowerCase()));
    const trimmed: TargetContent = {
      title: content.title,
      caption: removeHashtags(content.caption, dropped),
      hashtags: content.hashtags.filter((t) => !droppedSet.has(t.toLowerCase())),
    };
    c.add({
      severity: "error",
      code: "too_many_hashtags",
      field: "hashtags",
      message: `${tags.length} hashtags; ${rules.displayName} allows at most ${max}.`,
      limit: max,
      actual: tags.length,
    });
    c.suggest({
      type: "trim_hashtags",
      caption: trimmed.caption,
      hashtags: trimmed.hashtags,
      automatic: true,
      description: `Keep the first ${max} hashtags, drop ${dropped.length}`,
    });
    return trimmed;
  }
  if (recommendedMax !== undefined && tags.length > recommendedMax) {
    c.add({
      severity: "warning",
      code: "many_hashtags",
      field: "hashtags",
      message: `${tags.length} hashtags; ${recommendedMax} or fewer is recommended on ${rules.displayName}.`,
      limit: recommendedMax,
      actual: tags.length,
    });
  }
  return content;
}

function validateCaption(c: Collector, rules: PlatformRules, original: TargetContent, adapted: TargetContent) {
  const rule = rules.caption;
  const mode = rule.countMode ?? "codepoints";
  const effective = composeContent(original, rules).caption;
  // Operate on the hashtag-trimmed caption so later adaptations don't resurrect dropped tags.
  const cleaned = { ...adapted, caption: checkForbidden(c, "caption", adapted.caption, rule) };

  const len = countText(effective, mode);
  if (rule.maxLength && len > rule.maxLength) {
    c.add({
      severity: "error",
      code: "caption_too_long",
      field: "caption",
      message: `${rule.label} is ${len} characters (including hashtags); ${rules.displayName} allows ${rule.maxLength}.`,
      limit: rule.maxLength,
      actual: len,
    });
    c.suggest(suggestCaptionTruncation(rules, cleaned));
  } else if (rule.recommendedMaxLength && len > rule.recommendedMaxLength) {
    c.add({
      severity: "warning",
      code: "caption_folded",
      field: "caption",
      message: `Only the first ~${rule.recommendedMaxLength} characters are visible before "more" on ${rules.displayName}.`,
      limit: rule.recommendedMaxLength,
      actual: len,
    });
  }
}

function suggestCaptionTruncation(rules: PlatformRules, content: TargetContent): Adaptation {
  const limit = rules.caption.maxLength!;
  const mode = rules.caption.countMode ?? "codepoints";
  const caption = content.caption.trim();
  const description = `Shorten ${rules.caption.label.toLowerCase()} to fit ${limit} characters`;
  if (rules.hashtags.placement === "inline") {
    const suffix = hashtagSuffix({ ...content, caption });
    const suffixCost = countText(suffix, mode);
    if (suffixCost <= limit / 2) {
      // Keep appended hashtags; shorten only the body (preserving its own trailing hashtags if possible).
      const body = truncateText(caption, limit - suffixCost, mode, { preserveTrailingHashtags: true });
      return { type: "truncate_caption", caption: body, hashtags: content.hashtags, automatic: true, description };
    }
    // Hashtags alone eat most of the budget: fold them into the caption and truncate the whole thing.
    const full = composeContent(content, rules).caption;
    return { type: "truncate_caption", caption: truncateText(full, limit, mode), hashtags: [], automatic: true, description };
  }
  return {
    type: "truncate_caption",
    caption: truncateText(caption, limit, mode, { preserveTrailingHashtags: true }),
    hashtags: content.hashtags,
    automatic: true,
    description,
  };
}

function validateMedia(c: Collector, rules: PlatformRules, media: MediaInfo): { orientation: Orientation | null; shortForm: boolean } {
  const v = rules.video;
  const name = rules.displayName;

  if (media.mimeType && !v.mimeTypes.includes(media.mimeType)) {
    c.add({ severity: "error", code: "unsupported_format", field: "media", message: `${name} does not accept ${media.mimeType}.` });
    c.suggest({ type: "transcode", mimeType: "video/mp4", automatic: false, description: "Transcode to MP4 (H.264/AAC)" });
  }

  if (media.sizeBytes !== undefined) {
    if (v.maxFileSizeBytes !== undefined && media.sizeBytes > v.maxFileSizeBytes) {
      c.add({
        severity: "error",
        code: "file_too_large",
        field: "media",
        message: `File is ${formatBytes(media.sizeBytes)}; ${name} allows up to ${formatBytes(v.maxFileSizeBytes)}.`,
        limit: v.maxFileSizeBytes,
        actual: media.sizeBytes,
      });
      c.suggest({
        type: "compress",
        maxFileSizeBytes: v.maxFileSizeBytes,
        automatic: false,
        description: `Re-encode at a lower bitrate to fit ${formatBytes(v.maxFileSizeBytes)}`,
      });
    }
    if (v.minFileSizeBytes !== undefined && media.sizeBytes < v.minFileSizeBytes) {
      c.add({
        severity: "error",
        code: "file_too_small",
        field: "media",
        message: `File is ${formatBytes(media.sizeBytes)}; ${name} requires at least ${formatBytes(v.minFileSizeBytes)}.`,
        limit: v.minFileSizeBytes,
        actual: media.sizeBytes,
      });
    }
  }

  if (media.durationSec !== undefined) {
    if (v.maxDurationSec !== undefined && media.durationSec > v.maxDurationSec) {
      c.add({
        severity: "error",
        code: "too_long",
        field: "media",
        message: `Video is ${formatDuration(media.durationSec)}; ${name} allows up to ${formatDuration(v.maxDurationSec)}.`,
        limit: v.maxDurationSec,
        actual: media.durationSec,
      });
      c.suggest({
        type: "trim_duration",
        maxDurationSec: v.maxDurationSec,
        automatic: false,
        description: `Trim to ${formatDuration(v.maxDurationSec)}`,
      });
    }
    if (v.minDurationSec !== undefined && media.durationSec < v.minDurationSec) {
      c.add({
        severity: "error",
        code: "too_short",
        field: "media",
        message: `Video is ${formatDuration(media.durationSec)}; ${name} requires at least ${formatDuration(v.minDurationSec)}.`,
        limit: v.minDurationSec,
        actual: media.durationSec,
      });
    }
  }

  if (!media.width || !media.height) {
    c.add({
      severity: "info",
      code: "media_metadata_missing",
      field: "media",
      message: "Video dimensions unknown; aspect ratio checks skipped.",
    });
    return { orientation: null, shortForm: false };
  }

  const { width, height } = media;
  const ratio = width / height;
  const orientation = classifyOrientation(width, height);
  const target = v.recommendedAspectRatios[0];

  if ((v.minWidth && width < v.minWidth) || (v.minHeight && height < v.minHeight)) {
    c.add({
      severity: "error",
      code: "resolution_too_low",
      field: "media",
      message: `${width}×${height} is below ${name}'s minimum of ${v.minWidth ?? 0}×${v.minHeight ?? 0}.`,
    });
  }

  // Small epsilon so exact boundary ratios (e.g. 9:16 encoded as 1080x1920) aren't rejected by float error.
  const EPS = 1e-3;
  const outOfRange =
    (v.minAspectRatio !== undefined && ratio < v.minAspectRatio - EPS) ||
    (v.maxAspectRatio !== undefined && ratio > v.maxAspectRatio + EPS);
  if (outOfRange) {
    c.add({
      severity: "error",
      code: "aspect_ratio_out_of_range",
      field: "media",
      message: `Aspect ratio ${ratio.toFixed(2)} is outside ${name}'s allowed range.`,
      actual: ratio,
    });
    c.suggest(reframe(orientation, closestRecommended(ratio, v.recommendedAspectRatios)));
  }

  // YouTube-style short-form classification.
  const shortForm =
    !!rules.shortForm &&
    orientation !== "horizontal" &&
    media.durationSec !== undefined &&
    media.durationSec <= rules.shortForm.maxDurationSec;
  if (shortForm) {
    c.add({
      severity: "info",
      code: "classified_short_form",
      field: "media",
      message: `Will be published as a ${rules.shortForm!.name} (${orientation}, ≤ ${formatDuration(rules.shortForm!.maxDurationSec)}).`,
    });
    return { orientation, shortForm };
  }

  if (!outOfRange && v.preferredOrientation && orientation !== v.preferredOrientation && target) {
    c.add({
      severity: "warning",
      code: "orientation_mismatch",
      field: "media",
      message: `${name} is optimized for ${v.preferredOrientation} video (${target}); this video is ${orientation}.`,
    });
    c.suggest(reframe(orientation, target));
  }

  return { orientation, shortForm };
}

function closestRecommended(ratio: number, recommended: string[]): string {
  return recommended.reduce((best, r) =>
    Math.abs(parseAspectRatio(r) - ratio) < Math.abs(parseAspectRatio(best) - ratio) ? r : best,
  );
}

function reframe(from: Orientation, targetAspectRatio: string): Adaptation {
  const targetRatio = parseAspectRatio(targetAspectRatio);
  const to = targetRatio < 0.8 ? "vertical" : targetRatio > 1.25 ? "horizontal" : "square";
  // Going narrower (e.g. 16:9 → 9:16) is usually a center crop; going wider pads with blurred bars.
  const fromRatio = from === "vertical" ? 9 / 16 : from === "horizontal" ? 16 / 9 : 1;
  const mode = targetRatio < fromRatio ? "crop" : "pad";
  return {
    type: "reframe",
    from,
    targetAspectRatio,
    mode,
    automatic: false,
    description:
      mode === "crop"
        ? `Center-crop ${from} video to ${targetAspectRatio} (${to})`
        : `Pad ${from} video to ${targetAspectRatio} (${to}) with blurred background`,
  };
}

export function validateForPlatform(input: ValidationInput): ValidationResult {
  const rules = getRules(input.platform, input.overrides);
  const content: TargetContent = {
    title: input.content.title ?? "",
    caption: input.content.caption ?? "",
    hashtags: normalizeHashtags(input.content.hashtags ?? []),
  };
  const c = new Collector();

  validateTitle(c, rules, content);
  const afterHashtags = validateHashtags(c, rules, content);
  validateCaption(c, rules, content, afterHashtags);
  const media = input.media ? validateMedia(c, rules, input.media) : { orientation: null, shortForm: false };

  const errors = c.issues.filter((i) => i.severity === "error");
  return {
    platform: input.platform,
    ok: errors.length === 0,
    errors,
    warnings: c.issues.filter((i) => i.severity === "warning"),
    infos: c.issues.filter((i) => i.severity === "info"),
    adaptations: c.adaptations,
    effective: composeContent(content, rules),
    orientation: media.orientation,
    shortForm: media.shortForm,
  };
}

/** Validate one post + media against several platforms at once. */
export function validateAll(
  post: Pick<Post, "title" | "caption" | "hashtags">,
  targets: Array<Pick<PostTarget, "platform" | "titleOverride" | "captionOverride" | "hashtagsOverride">>,
  media?: MediaInfo,
): ValidationResult[] {
  return targets.map((t) =>
    validateForPlatform({ platform: t.platform, content: resolveTargetContent(post, t), media }),
  );
}

/**
 * Apply the automatic (text-only) adaptations to content. Media adaptations
 * (reframe/trim/compress/transcode) need a processing pipeline and are ignored here.
 */
export function applyTextAdaptations(content: TargetContent, adaptations: Adaptation[]): TargetContent {
  let out = { ...content, hashtags: [...content.hashtags] };
  for (const a of adaptations) {
    switch (a.type) {
      case "truncate_title":
      case "derive_title":
        out = { ...out, title: a.title };
        break;
      case "strip_forbidden_chars":
        out = a.field === "title" ? { ...out, title: a.value } : { ...out, caption: a.value };
        break;
      case "trim_hashtags":
      case "truncate_caption":
        out = { ...out, caption: a.caption, hashtags: a.hashtags };
        break;
    }
  }
  return out;
}
