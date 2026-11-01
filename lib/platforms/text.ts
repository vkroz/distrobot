import type { CountMode } from "./rules";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EMOJI_RE = /\p{Extended_Pictographic}/u;
const URL_RE = /https?:\/\/[^\s]+/g;
/** X counts every URL as 23 characters (t.co wrapping). */
const X_URL_WEIGHT = 23;
/** Code point ranges X weights as 1; everything else counts as 2. */
const X_LIGHT_RANGES: Array<[number, number]> = [
  [0, 4351],
  [8192, 8205],
  [8208, 8223],
  [8242, 8247],
];

export const ELLIPSIS = "…";

function xWeightOfSegment(segment: string): number {
  if (EMOJI_RE.test(segment)) return 2;
  let weight = 0;
  for (const ch of segment) {
    const cp = ch.codePointAt(0)!;
    weight += X_LIGHT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi) ? 1 : 2;
  }
  return weight;
}

function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (s) => s.segment);
}

/** Length of `text` as counted by the platform. */
export function countText(text: string, mode: CountMode = "codepoints"): number {
  switch (mode) {
    case "utf16":
      return text.length;
    case "codepoints":
      return [...text].length;
    case "x-weighted": {
      let total = 0;
      let last = 0;
      for (const m of text.matchAll(URL_RE)) {
        total += graphemes(text.slice(last, m.index)).reduce((n, g) => n + xWeightOfSegment(g), 0);
        total += X_URL_WEIGHT;
        last = m.index + m[0].length;
      }
      total += graphemes(text.slice(last)).reduce((n, g) => n + xWeightOfSegment(g), 0);
      return total;
    }
  }
}

const HASHTAG_RE = /(^|[^\p{L}\p{N}_&#/])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu;

/** Hashtags found in text, without "#", de-duplicated case-insensitively, in order of appearance. */
export function extractHashtags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(HASHTAG_RE)) {
    const tag = m[2];
    if (!seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out;
}

/** Normalize user-entered hashtags: strip "#", whitespace, empties and case-insensitive duplicates. */
export function normalizeHashtags(tags: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().replace(/^#+/, "").replace(/\s+/g, "");
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
  }
  return out;
}

/** Remove the given hashtags (case-insensitive) from text, tidying leftover whitespace. */
export function removeHashtags(text: string, tags: string[]): string {
  if (tags.length === 0) return text;
  const drop = new Set(tags.map((t) => t.toLowerCase()));
  return text
    .replace(HASHTAG_RE, (match, prefix: string, tag: string) => (drop.has(tag.toLowerCase()) ? prefix : match))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split text into body and a trailing block made only of hashtags/whitespace. */
export function splitTrailingHashtags(text: string): { body: string; trailing: string } {
  const m = text.match(/(\s*(?:#[\p{L}\p{N}_]+\s*)+)$/u);
  if (!m || m.index === undefined || m.index === 0) return { body: text, trailing: "" };
  return { body: text.slice(0, m.index), trailing: m[0] };
}

export interface TruncateOptions {
  ellipsis?: string;
  /** Keep a trailing hashtag block intact when it uses at most half the budget. */
  preserveTrailingHashtags?: boolean;
}

/**
 * Truncate text to fit `limit` under `mode`, preferring a word boundary and appending an ellipsis.
 * Never splits grapheme clusters (emoji, combining marks).
 */
export function truncateText(text: string, limit: number, mode: CountMode = "codepoints", opts: TruncateOptions = {}): string {
  if (countText(text, mode) <= limit) return text;
  const ellipsis = opts.ellipsis ?? ELLIPSIS;

  if (opts.preserveTrailingHashtags) {
    const { body, trailing } = splitTrailingHashtags(text);
    const trailingCost = countText(trailing, mode);
    if (trailing && trailingCost <= limit / 2) {
      return truncateText(body, limit - trailingCost, mode, { ellipsis }) + trailing;
    }
  }

  let budget = limit - countText(ellipsis, mode);
  if (budget <= 0) return cutToBudget(text, limit, mode);

  // Per-grapheme costs can under-count context-dependent weights (X URLs), so re-check and shrink.
  for (;;) {
    const cut = cutToBudget(text, budget, mode);
    // Back off to a word boundary unless that would throw away too much text.
    const endsOnBoundary = /^\s/.test(text.slice(cut.length));
    const boundary = cut.search(/\s\S*$/);
    const base = endsOnBoundary ? cut : boundary > cut.length * 0.6 ? cut.slice(0, boundary) : cut;
    const result = base.replace(/[\s.,;:!?\-–—]+$/u, "") + ellipsis;
    const over = countText(result, mode) - limit;
    if (over <= 0 || budget <= 1) return result;
    budget -= over;
  }
}

function cutToBudget(text: string, budget: number, mode: CountMode): string {
  let out = "";
  let used = 0;
  for (const g of graphemes(text)) {
    const cost = countText(g, mode);
    if (used + cost > budget) break;
    out += g;
    used += cost;
  }
  return out;
}
