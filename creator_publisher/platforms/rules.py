"""Per-platform publishing limits.

Values reflect public API docs as best known at ``LAST_REVIEWED``. Platforms change these frequently
and some limits depend on account standing (YouTube unverified accounts, X Premium, TikTok
``creator_info``). At runtime, adapters may tighten these limits per account (see ``RuleOverrides``).
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any, Literal

LAST_REVIEWED = "2026-11"

KB = 1024
MB = 1024 * KB
GB = 1024 * MB

Orientation = Literal["vertical", "square", "horizontal"]
#: How caption length is counted by the platform.
CountMode = Literal["codepoints", "utf16", "x-weighted"]


@dataclass(frozen=True)
class TextRule:
    supported: bool
    label: str
    required: bool = False
    max_length: int | None = None
    #: Soft limit: exceeding produces a warning (e.g. text hidden behind "more").
    recommended_max_length: int | None = None
    count_mode: CountMode = "codepoints"
    #: Characters the platform rejects in this field.
    forbidden_chars: tuple[str, ...] = ()


@dataclass(frozen=True)
class HashtagRule:
    #: "inline": appended to the caption text. "tags": sent as a separate tag list.
    placement: Literal["inline", "tags"]
    #: Hard limit: exceeding is an error.
    max: int | None = None
    #: Soft limit: exceeding is a warning.
    recommended_max: int | None = None
    #: Max characters per tag (tag-list platforms).
    max_tag_length: int | None = None


@dataclass(frozen=True)
class VideoRule:
    mime_types: tuple[str, ...]
    #: Orientation the platform's feed is designed for; None = any works well.
    preferred_orientation: Orientation | None
    recommended_aspect_ratios: tuple[str, ...]
    min_duration_sec: float | None = None
    #: None = no documented limit.
    max_duration_sec: float | None = None
    min_file_size_bytes: int | None = None
    max_file_size_bytes: int | None = None
    #: Allowed width/height ratio range (inclusive). Outside is an error.
    min_aspect_ratio: float | None = None
    max_aspect_ratio: float | None = None
    min_width: int | None = None
    min_height: int | None = None


@dataclass(frozen=True)
class ShortForm:
    max_duration_sec: float
    name: str


@dataclass(frozen=True)
class PlatformRules:
    platform: str
    display_name: str
    docs_url: str
    title: TextRule
    caption: TextRule
    hashtags: HashtagRule
    video: VideoRule
    #: YouTube Shorts-style classification for vertical/square short videos.
    short_form: ShortForm | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)


#: Partial overrides: {"title": {...}, "caption": {...}, "hashtags": {...}, "video": {...}} (snake_case keys).
RuleOverrides = dict[str, dict[str, Any]]

MP4 = "video/mp4"
MOV = "video/quicktime"
WEBM = "video/webm"

PLATFORM_RULES: dict[str, PlatformRules] = {
    "youtube": PlatformRules(
        platform="youtube",
        display_name="YouTube",
        docs_url="https://developers.google.com/youtube/v3/docs/videos/insert",
        title=TextRule(supported=True, required=True, max_length=100, forbidden_chars=("<", ">"), label="Title"),
        caption=TextRule(supported=True, max_length=5000, count_mode="codepoints", forbidden_chars=("<", ">"), label="Description"),
        hashtags=HashtagRule(placement="inline", max=60, recommended_max=3),
        video=VideoRule(
            min_duration_sec=1,
            max_duration_sec=12 * 60 * 60,
            max_file_size_bytes=256 * GB,
            mime_types=(MP4, MOV, WEBM, "video/x-msvideo", "video/x-flv", "video/mpeg", "video/3gpp", "video/x-ms-wmv"),
            preferred_orientation="horizontal",
            recommended_aspect_ratios=("16:9",),
        ),
        short_form=ShortForm(max_duration_sec=180, name="YouTube Short"),
        notes=(
            "Unverified accounts are limited to 15-minute videos.",
            "More than 60 hashtags causes YouTube to ignore all hashtags; the first 3 appear above the title.",
            "Vertical or square videos up to 3 minutes are classified as Shorts.",
            "Title and description may not contain '<' or '>'.",
        ),
    ),
    "tiktok": PlatformRules(
        platform="tiktok",
        display_name="TikTok",
        docs_url="https://developers.tiktok.com/doc/content-posting-api-reference-direct-post",
        title=TextRule(supported=False, label="Title"),
        # post_info.title: "The maximum length is 2200 in UTF-16 runes."
        caption=TextRule(supported=True, max_length=2200, count_mode="utf16", label="Caption"),
        hashtags=HashtagRule(placement="inline", recommended_max=5),
        video=VideoRule(
            min_duration_sec=3,
            max_duration_sec=10 * 60,
            max_file_size_bytes=4 * GB,
            mime_types=(MP4, WEBM, MOV),
            preferred_orientation="vertical",
            recommended_aspect_ratios=("9:16",),
            min_width=360,
            min_height=360,
        ),
        notes=(
            "Actual max duration is per-creator (creator_info.max_video_post_duration_sec); adapters should override.",
            "Unaudited API clients can only post privately (SELF_ONLY).",
        ),
    ),
    "instagram": PlatformRules(
        platform="instagram",
        display_name="Instagram Reels",
        docs_url="https://developers.facebook.com/docs/instagram-platform/content-publishing",
        title=TextRule(supported=False, label="Title"),
        caption=TextRule(supported=True, max_length=2200, recommended_max_length=125, count_mode="codepoints", label="Caption"),
        hashtags=HashtagRule(placement="inline", max=30, recommended_max=5),
        video=VideoRule(
            min_duration_sec=3,
            max_duration_sec=15 * 60,
            max_file_size_bytes=300 * MB,
            mime_types=(MP4, MOV),
            preferred_orientation="vertical",
            recommended_aspect_ratios=("9:16",),
            min_aspect_ratio=0.01,
            max_aspect_ratio=10,
        ),
        notes=(
            "Requires an Instagram professional (Business/Creator) account.",
            "Captions are truncated after ~125 characters in the feed.",
            "Max 20 @mentions per caption.",
            "Non-9:16 videos are cropped in the Reels tab.",
        ),
    ),
    "x": PlatformRules(
        platform="x",
        display_name="X",
        docs_url="https://docs.x.com/x-api/media/upload-media",
        title=TextRule(supported=False, label="Title"),
        # 280 weighted chars (URLs = 23, CJK/emoji = 2): https://docs.x.com/fundamentals/counting-characters
        caption=TextRule(supported=True, max_length=280, count_mode="x-weighted", label="Post text"),
        hashtags=HashtagRule(placement="inline", recommended_max=2),
        video=VideoRule(
            min_duration_sec=0.5,
            max_duration_sec=140,
            max_file_size_bytes=512 * MB,
            mime_types=(MP4, MOV),
            preferred_orientation=None,
            recommended_aspect_ratios=("16:9", "1:1", "9:16"),
            min_aspect_ratio=1 / 3,
            max_aspect_ratio=3,
            min_width=32,
            min_height=32,
        ),
        notes=(
            "Premium accounts allow longer posts (25,000) and longer videos; override per account.",
            "URLs count as 23 characters; emoji and CJK characters count as 2.",
        ),
    ),
    "facebook": PlatformRules(
        platform="facebook",
        display_name="Facebook",
        docs_url="https://developers.facebook.com/docs/video-api/guides/publishing",
        # Graph API documents NO length limit for video title/description; 100 for the title is a
        # third-party convention → soft warning only.
        title=TextRule(supported=True, recommended_max_length=100, label="Title"),
        # 63,206 is widely cited for Facebook post text but is NOT stated in Meta's docs (community-sourced).
        caption=TextRule(supported=True, max_length=63206, recommended_max_length=500, count_mode="codepoints", label="Description"),
        hashtags=HashtagRule(placement="inline", recommended_max=3),
        video=VideoRule(
            min_duration_sec=1,
            max_duration_sec=240 * 60,
            max_file_size_bytes=10 * GB,
            mime_types=(MP4, MOV),
            preferred_orientation=None,
            recommended_aspect_ratios=("16:9", "9:16", "1:1", "4:5"),
            min_aspect_ratio=9 / 16,
            max_aspect_ratio=16 / 9,
        ),
        notes=(
            "Publishes to a Facebook Page (personal profiles are not supported by the API).",
            "Video title/description limits are not documented by Meta: the 100-char title is a soft guideline "
            "and the 63,206-char description cap is community-sourced.",
            "Reels use a separate endpoint with 3–90s duration and 9:16 only (not modeled yet).",
        ),
    ),
    "linkedin": PlatformRules(
        platform="linkedin",
        display_name="LinkedIn",
        docs_url="https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api",
        # Posts API content.media.title: no documented limit; 200 is an app-chosen soft cap.
        title=TextRule(supported=True, recommended_max_length=200, label="Video title"),
        # 3,000: https://www.linkedin.com/help/linkedin/answer/86780
        caption=TextRule(supported=True, max_length=3000, recommended_max_length=210, count_mode="codepoints", label="Post text"),
        hashtags=HashtagRule(placement="inline", recommended_max=5),
        video=VideoRule(
            min_duration_sec=3,
            max_duration_sec=30 * 60,
            # Videos API: 3 s – 30 min, 75 KB – 500 MB, MP4
            min_file_size_bytes=75 * KB,
            max_file_size_bytes=500 * MB,
            mime_types=(MP4,),
            preferred_orientation=None,
            recommended_aspect_ratios=("16:9", "1:1", "9:16"),
            min_aspect_ratio=1 / 2.4,
            max_aspect_ratio=2.4,
        ),
        notes=(
            "Post text is collapsed after ~210 characters.",
            "Video title limit is not documented by LinkedIn; 200 chars is a soft app guideline.",
        ),
    ),
    "vimeo": PlatformRules(
        platform="vimeo",
        display_name="Vimeo",
        docs_url="https://developer.vimeo.com/api/upload/videos",
        # 128: the title field's character counter in Vimeo's Help Center; not stated in the API spec.
        title=TextRule(supported=True, required=True, max_length=128, label="Title"),
        # Description: no documented limit → not enforced.
        caption=TextRule(supported=True, count_mode="codepoints", label="Description"),
        # 20 tags per video, 32 chars per tag (Vimeo Help Center).
        hashtags=HashtagRule(placement="tags", max=20, max_tag_length=32),
        video=VideoRule(
            mime_types=(MP4, MOV, WEBM, "video/x-msvideo", "video/x-ms-wmv", "video/x-flv", "video/mpeg"),
            preferred_orientation="horizontal",
            recommended_aspect_ratios=("16:9",),
        ),
        notes=(
            "File size and weekly/total storage limits depend on the account plan; adapters should override from /me quota.",
            "Vimeo uses tags rather than inline hashtags; hashtags are mapped to tags.",
            "Tag limits (20 tags, 32 chars each) are documented; the 128-char title comes from the Help Center UI; "
            "description length is undocumented and not enforced.",
        ),
    ),
}


def get_rules(platform: str, overrides: RuleOverrides | None = None) -> PlatformRules:
    base = PLATFORM_RULES[platform]
    if not overrides:
        return base
    return replace(
        base,
        title=replace(base.title, **overrides.get("title", {})),
        caption=replace(base.caption, **overrides.get("caption", {})),
        hashtags=replace(base.hashtags, **overrides.get("hashtags", {})),
        video=replace(base.video, **overrides.get("video", {})),
    )


def parse_aspect_ratio(ratio: str) -> float:
    """Parse "9:16" → 0.5625."""
    try:
        w, h = (float(x) for x in ratio.split(":"))
    except ValueError:
        raise ValueError(f"Invalid aspect ratio: {ratio}") from None
    if not w or not h:
        raise ValueError(f"Invalid aspect ratio: {ratio}")
    return w / h
