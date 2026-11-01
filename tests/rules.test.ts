import { describe, expect, it } from "vitest";
import { GB, MB, PLATFORM_RULES, getRules, parseAspectRatio } from "@/lib/platforms/rules";
import { PLATFORM_IDS } from "@/lib/types";

describe("PLATFORM_RULES", () => {
  it("defines rules for every platform", () => {
    expect(Object.keys(PLATFORM_RULES).sort()).toEqual([...PLATFORM_IDS].sort());
    for (const id of PLATFORM_IDS) expect(PLATFORM_RULES[id].platform).toBe(id);
  });

  it.each(PLATFORM_IDS)("%s rules are internally consistent", (id) => {
    const r = PLATFORM_RULES[id];
    expect(r.caption.supported).toBe(true);
    // Undocumented limits are left unset rather than invented (e.g. Vimeo description).
    if (r.caption.maxLength !== undefined) expect(r.caption.maxLength).toBeGreaterThan(0);
    if (r.caption.recommendedMaxLength && r.caption.maxLength) expect(r.caption.recommendedMaxLength).toBeLessThan(r.caption.maxLength);
    // Supported titles have a hard limit or (when undocumented) a soft guideline.
    if (r.title.supported) expect(r.title.maxLength ?? r.title.recommendedMaxLength).toBeGreaterThan(0);
    if (r.hashtags.max && r.hashtags.recommendedMax) expect(r.hashtags.recommendedMax).toBeLessThanOrEqual(r.hashtags.max);
    const v = r.video;
    if (v.minDurationSec && v.maxDurationSec) expect(v.minDurationSec).toBeLessThan(v.maxDurationSec);
    if (v.minAspectRatio && v.maxAspectRatio) expect(v.minAspectRatio).toBeLessThan(v.maxAspectRatio);
    expect(v.mimeTypes).toContain("video/mp4");
    expect(v.recommendedAspectRatios.length).toBeGreaterThan(0);
    for (const ar of v.recommendedAspectRatios) {
      const ratio = parseAspectRatio(ar);
      if (v.minAspectRatio) expect(ratio).toBeGreaterThanOrEqual(v.minAspectRatio - 1e-9);
      if (v.maxAspectRatio) expect(ratio).toBeLessThanOrEqual(v.maxAspectRatio + 1e-9);
    }
    expect(r.docsUrl).toMatch(/^https:\/\//);
  });

  it("captures key known limits", () => {
    expect(PLATFORM_RULES.youtube.title.maxLength).toBe(100);
    expect(PLATFORM_RULES.youtube.caption.maxLength).toBe(5000);
    expect(PLATFORM_RULES.x.caption.maxLength).toBe(280);
    expect(PLATFORM_RULES.x.video.maxDurationSec).toBe(140);
    expect(PLATFORM_RULES.instagram.hashtags.max).toBe(30);
    expect(PLATFORM_RULES.instagram.video.maxFileSizeBytes).toBe(300 * MB);
    expect(PLATFORM_RULES.tiktok.caption.maxLength).toBe(2200);
    expect(PLATFORM_RULES.tiktok.video.preferredOrientation).toBe("vertical");
    expect(PLATFORM_RULES.linkedin.caption.maxLength).toBe(3000);
    expect(PLATFORM_RULES.linkedin.video.maxFileSizeBytes).toBe(500 * MB);
    expect(PLATFORM_RULES.vimeo.hashtags).toMatchObject({ max: 20, maxTagLength: 32 });
    // Not documented by the platforms → soft guidelines / not enforced, never invented hard caps.
    expect([PLATFORM_RULES.facebook.title.maxLength, PLATFORM_RULES.facebook.title.recommendedMaxLength]).toEqual([undefined, 100]);
    expect([PLATFORM_RULES.linkedin.title.maxLength, PLATFORM_RULES.linkedin.title.recommendedMaxLength]).toEqual([undefined, 200]);
    expect(PLATFORM_RULES.vimeo.caption.maxLength).toBeUndefined();
    expect(PLATFORM_RULES.vimeo.hashtags.placement).toBe("tags");
  });
});

describe("getRules", () => {
  it("returns base rules without overrides", () => {
    expect(getRules("x")).toBe(PLATFORM_RULES.x);
  });

  it("merges overrides without mutating base", () => {
    const r = getRules("x", { caption: { maxLength: 25000 } });
    expect(r.caption.maxLength).toBe(25000);
    expect(r.caption.countMode).toBe("x-weighted");
    expect(PLATFORM_RULES.x.caption.maxLength).toBe(280);
  });
});

describe("parseAspectRatio", () => {
  it("parses and rejects invalid", () => {
    expect(parseAspectRatio("9:16")).toBeCloseTo(0.5625);
    expect(() => parseAspectRatio("abc")).toThrow();
  });
});
