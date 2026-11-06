import pytest

from creator_publisher.models import PLATFORM_IDS, MediaInfo, TargetContent
from creator_publisher.platforms.rules import MB, PLATFORM_RULES, get_rules, parse_aspect_ratio
from creator_publisher.platforms.text import (
    count_text,
    extract_hashtags,
    normalize_hashtags,
    remove_hashtags,
    split_trailing_hashtags,
    truncate_text,
)
from creator_publisher.platforms.validate import (
    apply_text_adaptations,
    classify_orientation,
    compose_content,
    requirement_rows,
    resolve_target_content,
    validate_for_platform,
)

VERTICAL = MediaInfo("video/mp4", 50 * MB, 45, 1080, 1920)
HORIZONTAL = MediaInfo("video/mp4", 50 * MB, 45, 1920, 1080)


def content(**kw):
    return TargetContent(**{"title": "My video", "caption": "Check this out", "hashtags": [], **kw})


def codes(r):
    return [i.code for i in r.errors + r.warnings + r.infos]


# --- text ------------------------------------------------------------------


def test_count_modes():
    assert count_text("héllo") == 5
    assert count_text("😀") == 1
    assert count_text("😀", "utf16") == 2
    assert count_text("hello", "x-weighted") == 5
    assert count_text("see https://example.com/a/very/long/path/that/goes/on", "x-weighted") == 4 + 23
    assert count_text("👨‍👩‍👧", "x-weighted") == 2  # ZWJ family is one grapheme
    assert count_text("日本", "x-weighted") == 4


def test_hashtags():
    assert extract_hashtags("Hi #Travel and #food #travel. Not a#tag, not #123, url.com/#frag") == ["Travel", "food"]
    assert extract_hashtags("#café #日本") == ["café", "日本"]
    assert normalize_hashtags(["#a", "a", " b ", "##c", "", "A"]) == ["a", "b", "c"]
    assert remove_hashtags("Great day #one #two #three", ["two", "THREE"]) == "Great day #one"
    assert split_trailing_hashtags("Body text\n\n#a #b") == ("Body text", "\n\n#a #b")
    assert split_trailing_hashtags("#only #tags") == ("#only #tags", "")


def test_truncate():
    assert truncate_text("short", 10) == "short"
    assert truncate_text("The quick brown fox jumps over the lazy dog", 20) == "The quick brown fox…"
    assert truncate_text("a" * 50, 10) == "a" * 9 + "…"
    out = truncate_text("👍🏽" * 10, 5)
    assert count_text(out) <= 5 and set(out.replace("…", "").replace("👍🏽", "")) == set()
    text = ("word " * 40).strip() + "\n\n#travel #food"
    out = truncate_text(text, 60, preserve_trailing_hashtags=True)
    assert out.endswith("\n\n#travel #food") and count_text(out) <= 60
    out = truncate_text("x " * 140 + "https://a.co more text after the link", 280, "x-weighted")
    assert count_text(out, "x-weighted") <= 280


# --- rules -----------------------------------------------------------------


def test_rules_and_overrides():
    assert set(PLATFORM_RULES) == set(PLATFORM_IDS)
    assert parse_aspect_ratio("9:16") == pytest.approx(0.5625)
    with pytest.raises(ValueError):
        parse_aspect_ratio("x")
    r = get_rules("x", {"caption": {"max_length": 25_000}})
    assert r.caption.max_length == 25_000 and PLATFORM_RULES["x"].caption.max_length == 280
    assert PLATFORM_RULES["linkedin"].video.max_file_size_bytes == 500 * MB


# --- validation ------------------------------------------------------------


@pytest.mark.parametrize("platform", PLATFORM_IDS)
def test_happy_path(platform):
    r = validate_for_platform(platform, content(), VERTICAL)
    assert r.errors == [] and r.ok


def test_title_rules():
    r = validate_for_platform("youtube", content(title="word " * 30))
    assert "title_too_long" in codes(r)
    a = next(a for a in r.adaptations if a["type"] == "truncate_title")
    assert count_text(a["title"]) <= 100

    r = validate_for_platform("youtube", content(title="", caption="Sunset in Lisbon #travel\nMore details here"))
    assert "title_required" in codes(r)
    assert next(a for a in r.adaptations if a["type"] == "derive_title")["title"] == "Sunset in Lisbon"

    r = validate_for_platform("tiktok", content())
    assert r.ok and "title_ignored" in codes(r) and r.effective.title is None

    r = validate_for_platform("youtube", content(title="A <b> title"))
    assert "forbidden_chars" in codes(r)
    assert apply_text_adaptations(content(title="A <b> title"), r.adaptations).title == "A b title"

    r = validate_for_platform("facebook", content(title="x" * 150))
    assert r.ok and "title_long" in codes(r)


def test_caption_rules():
    c = content(caption="This is a long post. " * 20)
    r = validate_for_platform("x", c)
    assert not r.ok and "caption_too_long" in codes(r)
    assert validate_for_platform("x", apply_text_adaptations(c, r.adaptations)).ok

    c = content(caption=("a " * 135).strip(), hashtags=["travel", "food"])
    r = validate_for_platform("x", c)
    fixed = apply_text_adaptations(c, r.adaptations)
    assert fixed.hashtags == ["travel", "food"]
    eff = compose_content(fixed, PLATFORM_RULES["x"]).caption
    assert eff.endswith("#travel #food") and count_text(eff, "x-weighted") <= 280

    eff = compose_content(content(caption="Hello #travel", hashtags=["Travel", "food"]), PLATFORM_RULES["tiktok"])
    assert eff.caption == "Hello #travel\n\n#food"

    r = validate_for_platform("instagram", content(caption="x" * 300))
    assert r.ok and "caption_folded" in codes(r)


def test_hashtag_limits_and_tags():
    inline = " ".join(f"#in{i}" for i in range(20))
    c = content(caption=f"Hello {inline}", hashtags=[f"ex{i}" for i in range(15)])
    r = validate_for_platform("instagram", c)
    assert "too_many_hashtags" in codes(r)
    assert validate_for_platform("instagram", apply_text_adaptations(c, r.adaptations)).ok

    r = validate_for_platform("vimeo", content(caption="Nice #one", hashtags=["two", "a" * 40]))
    assert "tag_too_long" in codes(r)
    assert r.effective.tags == ["one", "two", "a" * 40]
    assert validate_for_platform("vimeo", apply_text_adaptations(content(caption="Nice #one", hashtags=["two", "a" * 40]), r.adaptations)).ok


def test_media_rules():
    assert classify_orientation(1080, 1920) == "vertical" and classify_orientation(1000, 1000) == "square"
    r = validate_for_platform("tiktok", content(), MediaInfo("video/x-msvideo", 10 * MB, 700, 200, 200))
    assert {"unsupported_format", "too_long", "resolution_too_low"} <= set(codes(r))
    r = validate_for_platform("youtube", content(), VERTICAL)
    assert r.short_form and "classified_short_form" in codes(r)
    r = validate_for_platform("tiktok", content(), HORIZONTAL)
    assert "orientation_mismatch" in codes(r)
    assert any(a["type"] == "reframe" and a["mode"] == "crop" for a in r.adaptations)
    r = validate_for_platform("x", content(), MediaInfo("video/mp4", MB, 10, 4000, 1000))
    assert "aspect_ratio_out_of_range" in codes(r)
    r = validate_for_platform("linkedin", content(), MediaInfo("video/mp4", 10 * KB_, 10, 1920, 1080))
    assert "file_too_small" in codes(r)
    r = validate_for_platform("youtube", content(), MediaInfo("video/mp4", MB, 10))
    assert "media_metadata_missing" in codes(r)


KB_ = 1024


def test_resolve_and_requirements():
    c = resolve_target_content({"title": "T", "caption": "C", "hashtags": ["#a", "a"]}, {"title_override": "X", "caption_override": None, "hashtags_override": None})
    assert (c.title, c.caption, c.hashtags) == ("X", "C", ["a"])
    r = validate_for_platform("x", content(caption="x" * 300), HORIZONTAL)
    rows = {row["label"]: row for row in requirement_rows(PLATFORM_RULES["x"], r, HORIZONTAL)}
    assert rows["Post text"]["level"] == "err" and "weighted" in rows["Post text"]["value"]
    assert rows["Title"]["level"] == "na"


def test_tiktok_settings_validation():
    from creator_publisher.platforms.tiktok import MOCK_CREATOR_INFO, commercial_label, consent_text, tiktok_post_info

    r = validate_for_platform("tiktok", content(), settings={})
    assert "tiktok_privacy_required" in codes(r)
    s = {"privacyLevel": "SELF_ONLY", "allowStitch": True, "commercial": {"enabled": True, "brandedContent": True}}
    r = validate_for_platform("tiktok", content(), MediaInfo(duration_sec=700), settings=s, tiktok_creator=MOCK_CREATOR_INFO)
    assert {"tiktok_branded_private", "tiktok_interaction_disabled", "tiktok_duration_exceeded"} <= set(codes(r))
    assert commercial_label({"commercial": {"enabled": True, "yourBrand": True}}) == "Promotional content"
    assert commercial_label(s) == "Paid partnership"
    assert "Branded Content Policy" in consent_text(s)
    info = tiktok_post_info({"privacyLevel": "PUBLIC_TO_EVERYONE", "allowComment": True}, MOCK_CREATOR_INFO)
    assert info["disable_comment"] is False and info["disable_stitch"] is True and info["brand_content_toggle"] is False
    r = validate_for_platform("tiktok", content(), settings={"commercial": {"enabled": True}, "privacyLevel": "PUBLIC_TO_EVERYONE"})
    assert "tiktok_commercial_incomplete" in codes(r)
