import { describe, expect, it } from "vitest";
import {
  MOCK_CREATOR_INFO,
  commercialLabel,
  consentText,
  normalizeCreatorInfo,
  tiktokPostInfo,
  validateTikTokSettings,
  type TikTokCreatorInfo,
} from "@/lib/platforms/tiktok";
import { validateForPlatform } from "@/lib/platforms/validate";

const codes = (settings: unknown, creator?: TikTokCreatorInfo, duration?: number) =>
  validateTikTokSettings(settings, creator, duration).map((i) => i.code);

const creator: TikTokCreatorInfo = { ...MOCK_CREATOR_INFO, privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"], duetDisabled: true };

describe("TikTok posting settings", () => {
  it("requires an explicit privacy choice (no default)", () => {
    expect(codes({})).toEqual(["tiktok_privacy_required"]);
    expect(codes({ privacyLevel: "nonsense" })).toEqual(["tiktok_privacy_required"]);
    expect(codes({ privacyLevel: "PUBLIC_TO_EVERYONE" })).toEqual([]);
  });

  it("checks the choice against creator_info options and disabled interactions", () => {
    expect(codes({ privacyLevel: "FOLLOWER_OF_CREATOR" }, creator)).toEqual(["tiktok_privacy_not_allowed"]);
    expect(codes({ privacyLevel: "SELF_ONLY", allowDuet: true }, creator)).toEqual(["tiktok_interaction_disabled"]);
    expect(codes({ privacyLevel: "SELF_ONLY" }, creator, 601)).toEqual(["tiktok_duration_exceeded"]);
  });

  it("commercial disclosure: must pick a type; branded content can't be private", () => {
    const on = (c: object, privacyLevel = "PUBLIC_TO_EVERYONE") => ({ privacyLevel, commercial: { enabled: true, ...c } });
    expect(codes(on({ yourBrand: false, brandedContent: false }))).toEqual(["tiktok_commercial_incomplete"]);
    expect(codes(on({ yourBrand: true }))).toEqual([]);
    expect(codes(on({ brandedContent: true }, "SELF_ONLY"))).toEqual(["tiktok_branded_private"]);
    expect(codes(on({ yourBrand: true }, "SELF_ONLY"))).toEqual([]); // own brand may be private
  });

  it("labels and consent text follow the disclosure", () => {
    expect(commercialLabel({})).toBeNull();
    expect(commercialLabel({ commercial: { enabled: true, yourBrand: true } })).toBe("Promotional content");
    expect(commercialLabel({ commercial: { enabled: true, yourBrand: true, brandedContent: true } })).toBe("Paid partnership");
    expect(consentText({})).toBe("By posting, you agree to TikTok's Music Usage Confirmation.");
    expect(consentText({ commercial: { enabled: true, brandedContent: true } })).toMatch(/Branded Content Policy and Music Usage/);
  });

  it("maps to post_info: interactions off unless allowed, creator limits win", () => {
    expect(tiktokPostInfo({ privacyLevel: "SELF_ONLY", allowComment: true, allowDuet: true }, creator)).toEqual({
      privacy_level: "SELF_ONLY",
      disable_comment: false,
      disable_duet: true, // creator disabled duets
      disable_stitch: true,
      brand_organic_toggle: false,
      brand_content_toggle: false,
    });
  });

  it("normalizes creator_info and ignores unknown privacy options", () => {
    expect(
      normalizeCreatorInfo({
        creator_nickname: "Maker",
        creator_username: "maker",
        privacy_level_options: ["PUBLIC_TO_EVERYONE", "SOMETHING_NEW"],
        stitch_disabled: true,
        max_video_post_duration_sec: 300,
      }),
    ).toMatchObject({ nickname: "Maker", username: "maker", privacyLevelOptions: ["PUBLIC_TO_EVERYONE"], stitchDisabled: true, maxVideoPostDurationSec: 300 });
  });

  it("is part of platform validation only when settings are provided", () => {
    const content = { title: "", caption: "hi", hashtags: [] };
    expect(validateForPlatform({ platform: "tiktok", content }).ok).toBe(true); // text-only check
    const r = validateForPlatform({ platform: "tiktok", content, settings: {} });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatchObject({ field: "settings", code: "tiktok_privacy_required" });
    // Other platforms ignore TikTok settings.
    expect(validateForPlatform({ platform: "x", content, settings: {} }).ok).toBe(true);
  });
});
