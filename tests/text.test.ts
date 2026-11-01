import { describe, expect, it } from "vitest";
import {
  countText,
  extractHashtags,
  normalizeHashtags,
  removeHashtags,
  splitTrailingHashtags,
  truncateText,
} from "@/lib/platforms/text";

describe("countText", () => {
  it("counts code points vs UTF-16 units", () => {
    expect(countText("héllo", "codepoints")).toBe(5);
    expect(countText("😀", "codepoints")).toBe(1);
    expect(countText("😀", "utf16")).toBe(2);
  });

  it("applies X weighting: URLs=23, emoji=2, CJK=2", () => {
    expect(countText("hello", "x-weighted")).toBe(5);
    expect(countText("see https://example.com/a/very/long/path/that/goes/on", "x-weighted")).toBe(4 + 23);
    expect(countText("😀", "x-weighted")).toBe(2);
    expect(countText("👨‍👩‍👧", "x-weighted")).toBe(2); // ZWJ family is one grapheme
    expect(countText("日本", "x-weighted")).toBe(4);
  });
});

describe("hashtags", () => {
  it("extracts unique hashtags in order, ignoring anchors and numbers-only", () => {
    expect(extractHashtags("Hi #Travel and #food #travel. Not a#tag, not #123, url.com/#frag")).toEqual([
      "Travel",
      "food",
    ]);
    expect(extractHashtags("#café #日本")).toEqual(["café", "日本"]);
  });

  it("normalizes user input", () => {
    expect(normalizeHashtags(["#a", "a", " b ", "##c", "", "A"])).toEqual(["a", "b", "c"]);
  });

  it("removes selected hashtags and tidies whitespace", () => {
    expect(removeHashtags("Great day #one #two #three", ["two", "THREE"])).toBe("Great day #one");
  });

  it("splits trailing hashtag block", () => {
    expect(splitTrailingHashtags("Body text\n\n#a #b")).toEqual({ body: "Body text", trailing: "\n\n#a #b" });
    expect(splitTrailingHashtags("#only #tags")).toEqual({ body: "#only #tags", trailing: "" });
  });
});

describe("truncateText", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncateText("short", 10)).toBe("short");
  });

  it("cuts at a word boundary and appends an ellipsis", () => {
    const out = truncateText("The quick brown fox jumps over the lazy dog", 20);
    expect(out).toBe("The quick brown fox…");
    expect(countText(out)).toBeLessThanOrEqual(20);
  });

  it("hard-cuts long words rather than dropping most of the text", () => {
    const out = truncateText("a".repeat(50), 10);
    expect(out).toBe("a".repeat(9) + "…");
  });

  it("never splits emoji grapheme clusters", () => {
    const out = truncateText("👍🏽".repeat(10), 5, "codepoints");
    expect(countText(out)).toBeLessThanOrEqual(5);
    expect(out.replace("…", "")).toMatch(/^(👍🏽)*$/u);
  });

  it("preserves trailing hashtags when asked", () => {
    const text = `${"word ".repeat(40).trim()}\n\n#travel #food`;
    const out = truncateText(text, 60, "codepoints", { preserveTrailingHashtags: true });
    expect(out.endsWith("\n\n#travel #food")).toBe(true);
    expect(countText(out)).toBeLessThanOrEqual(60);
  });

  it("respects X weighting including short URLs", () => {
    const text = `${"x ".repeat(140)}https://a.co more text after the link`;
    const out = truncateText(text, 280, "x-weighted");
    expect(countText(out, "x-weighted")).toBeLessThanOrEqual(280);
  });
});
