import { describe, expect, it } from "vitest";
import { MB } from "@/lib/platforms/rules";
import { countText } from "@/lib/platforms/text";
import {
  applyTextAdaptations,
  classifyOrientation,
  composeContent,
  resolveTargetContent,
  validateAll,
  validateForPlatform,
  type ValidationResult,
} from "@/lib/platforms/validate";
import { PLATFORM_RULES } from "@/lib/platforms/rules";
import type { MediaInfo, PlatformId, TargetContent } from "@/lib/types";
import { PLATFORM_IDS } from "@/lib/types";

const VERTICAL: MediaInfo = { mimeType: "video/mp4", sizeBytes: 50 * MB, durationSec: 45, width: 1080, height: 1920 };
const HORIZONTAL: MediaInfo = { mimeType: "video/mp4", sizeBytes: 50 * MB, durationSec: 45, width: 1920, height: 1080 };

const content = (c: Partial<TargetContent> = {}): TargetContent => ({
  title: "My video",
  caption: "Check this out",
  hashtags: [],
  ...c,
});

const codes = (r: ValidationResult) => [...r.errors, ...r.warnings, ...r.infos].map((i) => i.code);

describe("validateForPlatform: happy path", () => {
  it.each(PLATFORM_IDS)("%s accepts a simple vertical 45s mp4", (platform) => {
    const r = validateForPlatform({ platform, content: content(), media: VERTICAL });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
  });
});

describe("title", () => {
  it("errors when too long and suggests truncation", () => {
    const r = validateForPlatform({ platform: "youtube", content: content({ title: "word ".repeat(30) }) });
    expect(codes(r)).toContain("title_too_long");
    const a = r.adaptations.find((x) => x.type === "truncate_title");
    expect(a && a.type === "truncate_title" && countText(a.title)).toBeLessThanOrEqual(100);
  });

  it("requires a title on YouTube and derives one from the caption", () => {
    const r = validateForPlatform({
      platform: "youtube",
      content: content({ title: "", caption: "Sunset in Lisbon #travel\nMore details here" }),
    });
    expect(codes(r)).toContain("title_required");
    const a = r.adaptations.find((x) => x.type === "derive_title");
    expect(a).toMatchObject({ type: "derive_title", title: "Sunset in Lisbon" });
  });

  it("notes the title is ignored on platforms without titles", () => {
    const r = validateForPlatform({ platform: "tiktok", content: content() });
    expect(r.ok).toBe(true);
    expect(r.infos.map((i) => i.code)).toContain("title_ignored");
    expect(r.effective.title).toBeNull();
  });

  it("flags forbidden characters on YouTube", () => {
    const r = validateForPlatform({ platform: "youtube", content: content({ title: "A <b> title" }) });
    expect(codes(r)).toContain("forbidden_chars");
    const fixed = applyTextAdaptations(content({ title: "A <b> title" }), r.adaptations);
    expect(fixed.title).toBe("A b title");
  });
});

describe("caption", () => {
  it("errors on X when over 280 weighted chars and suggests a fitting truncation", () => {
    const caption = "This is a long post. ".repeat(20);
    const r = validateForPlatform({ platform: "x", content: content({ caption }) });
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("caption_too_long");
    const a = r.adaptations.find((x) => x.type === "truncate_caption");
    expect(a).toBeDefined();
    expect(a!.automatic).toBe(true);
    const fixed = applyTextAdaptations(content({ caption }), r.adaptations);
    const again = validateForPlatform({ platform: "x", content: fixed });
    expect(again.ok).toBe(true);
  });

  it("counts appended hashtags toward the limit and keeps them when truncating", () => {
    const c = content({ caption: "a ".repeat(135).trim(), hashtags: ["travel", "food"] });
    const r = validateForPlatform({ platform: "x", content: c });
    expect(codes(r)).toContain("caption_too_long");
    const fixed = applyTextAdaptations(c, r.adaptations);
    expect(fixed.hashtags).toEqual(["travel", "food"]);
    const eff = composeContent(fixed, PLATFORM_RULES.x).caption;
    expect(eff.endsWith("#travel #food")).toBe(true);
    expect(countText(eff, "x-weighted")).toBeLessThanOrEqual(280);
  });

  it("does not append hashtags already present inline", () => {
    const eff = composeContent(content({ caption: "Hello #travel", hashtags: ["Travel", "food"] }), PLATFORM_RULES.tiktok);
    expect(eff.caption).toBe("Hello #travel\n\n#food");
  });

  it("warns when caption will be folded", () => {
    const r = validateForPlatform({ platform: "instagram", content: content({ caption: "x".repeat(300) }) });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("caption_folded");
  });

  it("allows long captions on platforms with high limits", () => {
    const r = validateForPlatform({ platform: "youtube", content: content({ caption: "x".repeat(4000) }) });
    expect(r.ok).toBe(true);
  });
});

describe("hashtags", () => {
  it("errors above Instagram's 30 and suggests trimming", () => {
    const inline = Array.from({ length: 20 }, (_, i) => `#in${i}`).join(" ");
    const extra = Array.from({ length: 15 }, (_, i) => `ex${i}`);
    const c = content({ caption: `Hello ${inline}`, hashtags: extra });
    const r = validateForPlatform({ platform: "instagram", content: c });
    expect(codes(r)).toContain("too_many_hashtags");
    const fixed = applyTextAdaptations(c, r.adaptations);
    const again = validateForPlatform({ platform: "instagram", content: fixed });
    expect(again.errors).toEqual([]);
    // Inline tags come first so all 20 are kept; 10 of the explicit ones survive.
    expect(fixed.hashtags).toHaveLength(10);
  });

  it("warns above the recommended count", () => {
    const r = validateForPlatform({ platform: "x", content: content({ hashtags: ["a", "b", "c"] }) });
    expect(r.warnings.map((w) => w.code)).toContain("many_hashtags");
  });

  it("maps hashtags to tags on Vimeo", () => {
    const r = validateForPlatform({ platform: "vimeo", content: content({ caption: "Hi #one", hashtags: ["two"] }) });
    expect(r.effective.tags).toEqual(["one", "two"]);
    expect(r.effective.caption).toBe("Hi #one");
  });

  it("applies hashtag trimming and caption truncation together", () => {
    const tags = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    const c = content({ caption: "word ".repeat(500), hashtags: tags });
    const r = validateForPlatform({ platform: "instagram", content: c });
    expect(codes(r)).toEqual(expect.arrayContaining(["too_many_hashtags", "caption_too_long"]));
    const fixed = applyTextAdaptations(c, r.adaptations);
    expect(validateForPlatform({ platform: "instagram", content: fixed }).errors).toEqual([]);
  });
});

describe("media", () => {
  it("errors on X when video exceeds 140s and suggests trimming", () => {
    const r = validateForPlatform({ platform: "x", content: content(), media: { ...HORIZONTAL, durationSec: 200 } });
    expect(codes(r)).toContain("too_long");
    expect(r.adaptations).toContainEqual(expect.objectContaining({ type: "trim_duration", maxDurationSec: 140, automatic: false }));
  });

  it("errors when file too large for Instagram and suggests compression", () => {
    const r = validateForPlatform({ platform: "instagram", content: content(), media: { ...VERTICAL, sizeBytes: 400 * MB } });
    expect(codes(r)).toContain("file_too_large");
    expect(r.adaptations.map((a) => a.type)).toContain("compress");
  });

  it("errors when shorter than the minimum", () => {
    const r = validateForPlatform({ platform: "tiktok", content: content(), media: { ...VERTICAL, durationSec: 1 } });
    expect(codes(r)).toContain("too_short");
  });

  it("errors on unsupported format and suggests transcoding", () => {
    const r = validateForPlatform({ platform: "linkedin", content: content(), media: { ...HORIZONTAL, mimeType: "video/quicktime" } });
    expect(codes(r)).toContain("unsupported_format");
    expect(r.adaptations).toContainEqual(expect.objectContaining({ type: "transcode", mimeType: "video/mp4" }));
  });

  it("errors below LinkedIn's minimum file size", () => {
    const r = validateForPlatform({ platform: "linkedin", content: content(), media: { ...HORIZONTAL, sizeBytes: 1000 } });
    expect(codes(r)).toContain("file_too_small");
  });

  it("skips aspect checks when dimensions are unknown", () => {
    const r = validateForPlatform({ platform: "tiktok", content: content(), media: { durationSec: 30 } });
    expect(r.ok).toBe(true);
    expect(r.infos.map((i) => i.code)).toContain("media_metadata_missing");
    expect(r.orientation).toBeNull();
  });
});

describe("orientation", () => {
  it("classifies orientation", () => {
    expect(classifyOrientation(1080, 1920)).toBe("vertical");
    expect(classifyOrientation(1920, 1080)).toBe("horizontal");
    expect(classifyOrientation(1080, 1080)).toBe("square");
    expect(classifyOrientation(1080, 1350)).toBe("square"); // 4:5
  });

  it("warns horizontal video on TikTok and suggests a 9:16 center crop", () => {
    const r = validateForPlatform({ platform: "tiktok", content: content(), media: HORIZONTAL });
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w) => w.code)).toContain("orientation_mismatch");
    expect(r.adaptations).toContainEqual(
      expect.objectContaining({ type: "reframe", from: "horizontal", targetAspectRatio: "9:16", mode: "crop" }),
    );
  });

  it("flags Instagram square video as non-vertical", () => {
    const r = validateForPlatform({ platform: "instagram", content: content(), media: { ...VERTICAL, width: 1080, height: 1080 } });
    expect(r.warnings.map((w) => w.code)).toContain("orientation_mismatch");
  });

  it("classifies short vertical YouTube video as a Short (no orientation warning)", () => {
    const r = validateForPlatform({ platform: "youtube", content: content(), media: VERTICAL });
    expect(r.shortForm).toBe(true);
    expect(r.infos.map((i) => i.code)).toContain("classified_short_form");
    expect(r.warnings).toEqual([]);
  });

  it("warns long vertical YouTube video and suggests padding to 16:9", () => {
    const r = validateForPlatform({ platform: "youtube", content: content(), media: { ...VERTICAL, durationSec: 600 } });
    expect(r.shortForm).toBe(false);
    expect(r.warnings.map((w) => w.code)).toContain("orientation_mismatch");
    expect(r.adaptations).toContainEqual(expect.objectContaining({ type: "reframe", targetAspectRatio: "16:9", mode: "pad" }));
  });

  it("does not warn on orientation-agnostic platforms", () => {
    for (const platform of ["x", "facebook", "linkedin"] as PlatformId[]) {
      for (const media of [VERTICAL, HORIZONTAL]) {
        const r = validateForPlatform({ platform, content: content(), media });
        expect(r.warnings.map((w) => w.code)).not.toContain("orientation_mismatch");
      }
    }
  });

  it("errors when aspect ratio is outside the allowed range", () => {
    const r = validateForPlatform({ platform: "x", content: content(), media: { ...HORIZONTAL, width: 4000, height: 1000 } });
    expect(codes(r)).toContain("aspect_ratio_out_of_range");
    expect(r.adaptations).toContainEqual(expect.objectContaining({ type: "reframe", targetAspectRatio: "16:9" }));
  });

  it("errors below minimum resolution", () => {
    const r = validateForPlatform({ platform: "tiktok", content: content(), media: { ...VERTICAL, width: 180, height: 320 } });
    expect(codes(r)).toContain("resolution_too_low");
  });
});

describe("overrides and resolution", () => {
  it("applies per-account overrides (X Premium)", () => {
    const caption = "x".repeat(1000);
    expect(validateForPlatform({ platform: "x", content: content({ caption }) }).ok).toBe(false);
    expect(
      validateForPlatform({ platform: "x", content: content({ caption }), overrides: { caption: { maxLength: 25000 } } }).ok,
    ).toBe(true);
  });

  it("resolves target overrides over post defaults", () => {
    const post = { title: "Post title", caption: "Post caption", hashtags: ["a"] };
    expect(resolveTargetContent(post, null)).toEqual({ title: "Post title", caption: "Post caption", hashtags: ["a"] });
    expect(
      resolveTargetContent(post, { titleOverride: null, captionOverride: "Custom", hashtagsOverride: ["#b"] }),
    ).toEqual({ title: "Post title", caption: "Custom", hashtags: ["b"] });
    // Empty-string override is respected (explicitly blank caption).
    expect(resolveTargetContent(post, { titleOverride: null, captionOverride: "", hashtagsOverride: null }).caption).toBe("");
  });

  it("validates all targets at once", () => {
    const post = { title: "T", caption: "c".repeat(300), hashtags: [] };
    const results = validateAll(
      post,
      [
        { platform: "x", titleOverride: null, captionOverride: null, hashtagsOverride: null },
        { platform: "tiktok", titleOverride: null, captionOverride: null, hashtagsOverride: null },
      ],
      VERTICAL,
    );
    expect(results.map((r) => [r.platform, r.ok])).toEqual([
      ["x", false],
      ["tiktok", true],
    ]);
  });
});
