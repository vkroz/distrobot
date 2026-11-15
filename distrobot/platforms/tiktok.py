"""TikTok Content Posting API — required posting UX.

TikTok's audit requires the posting screen to:
 - show the creator's nickname/avatar (from creator_info/query) so users know where they post;
 - let users pick a privacy level from creator_info.privacy_level_options with NO default;
 - offer Comment / Duet / Stitch toggles, off by default, disabled when creator_info says so;
 - offer a commercial content disclosure ("Your brand" / "Branded content") and show the
   resulting label and the consent declaration before posting;
 - block branded content with "Only me" visibility.
Guidelines: https://developers.tiktok.com/doc/content-sharing-guidelines
API:        https://developers.tiktok.com/doc/content-posting-api-reference-query-creator-info
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

TIKTOK_PRIVACY_LEVELS = ("PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY")

TIKTOK_PRIVACY_LABELS = {
    "PUBLIC_TO_EVERYONE": "Everyone",
    "MUTUAL_FOLLOW_FRIENDS": "Friends",
    "FOLLOWER_OF_CREATOR": "Followers",
    "SELF_ONLY": "Only me",
}

TIKTOK_LINKS = {
    "musicUsage": "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en",
    "brandedContentPolicy": "https://www.tiktok.com/legal/page/global/bc-policy/en",
}


@dataclass
class TikTokCreatorInfo:
    """Normalized creator_info/query response."""

    nickname: str
    username: str | None
    avatar_url: str | None
    privacy_level_options: list[str]
    comment_disabled: bool
    duet_disabled: bool
    stitch_disabled: bool
    max_video_post_duration_sec: int | float | None


def normalize_creator_info(raw: dict[str, Any]) -> TikTokCreatorInfo:
    opts = raw.get("privacy_level_options") if isinstance(raw.get("privacy_level_options"), list) else []
    max_dur = raw.get("max_video_post_duration_sec")
    return TikTokCreatorInfo(
        nickname=str(raw.get("creator_nickname") or raw.get("creator_username") or "TikTok creator"),
        username=raw["creator_username"] if isinstance(raw.get("creator_username"), str) else None,
        avatar_url=raw["creator_avatar_url"] if isinstance(raw.get("creator_avatar_url"), str) else None,
        privacy_level_options=[o for o in opts if o in TIKTOK_PRIVACY_LEVELS],
        comment_disabled=raw.get("comment_disabled") is True,
        duet_disabled=raw.get("duet_disabled") is True,
        stitch_disabled=raw.get("stitch_disabled") is True,
        max_video_post_duration_sec=max_dur if isinstance(max_dur, (int, float)) and not isinstance(max_dur, bool) else None,
    )


def creator_from_api(data: Any) -> TikTokCreatorInfo | None:
    """Rebuild creator info from its camelCase API form (as sent back by the browser)."""
    if not isinstance(data, dict):
        return None
    try:
        return TikTokCreatorInfo(
            nickname=str(data.get("nickname", "")),
            username=data.get("username"),
            avatar_url=data.get("avatarUrl"),
            privacy_level_options=[o for o in data.get("privacyLevelOptions", []) if o in TIKTOK_PRIVACY_LEVELS],
            comment_disabled=data.get("commentDisabled") is True,
            duet_disabled=data.get("duetDisabled") is True,
            stitch_disabled=data.get("stitchDisabled") is True,
            max_video_post_duration_sec=data.get("maxVideoPostDurationSec")
            if isinstance(data.get("maxVideoPostDurationSec"), (int, float))
            else None,
        )
    except (TypeError, AttributeError):
        return None


#: Used in dry-run / when no TikTok account is connected.
MOCK_CREATOR_INFO = TikTokCreatorInfo(
    nickname="Demo Creator (mock)",
    username="demo.creator",
    avatar_url=None,
    privacy_level_options=list(TIKTOK_PRIVACY_LEVELS),
    comment_disabled=False,
    duet_disabled=False,
    stitch_disabled=True,
    max_video_post_duration_sec=600,
)


@dataclass
class Commercial:
    enabled: bool = False
    your_brand: bool = False
    branded_content: bool = False


@dataclass
class TikTokSettings:
    """Stored in ``post_targets.settings`` (camelCase keys) for TikTok targets."""

    #: Must be chosen explicitly by the user — never defaulted.
    privacy_level: str | None = None
    allow_comment: bool = False
    allow_duet: bool = False
    allow_stitch: bool = False
    commercial: Commercial = field(default_factory=Commercial)


def parse_tiktok_settings(raw: Any) -> TikTokSettings:
    s = raw if isinstance(raw, dict) else {}
    c = s.get("commercial") if isinstance(s.get("commercial"), dict) else {}
    return TikTokSettings(
        privacy_level=s.get("privacyLevel") if s.get("privacyLevel") in TIKTOK_PRIVACY_LEVELS else None,
        allow_comment=s.get("allowComment") is True,
        allow_duet=s.get("allowDuet") is True,
        allow_stitch=s.get("allowStitch") is True,
        commercial=Commercial(
            enabled=c.get("enabled") is True,
            your_brand=c.get("yourBrand") is True,
            branded_content=c.get("brandedContent") is True,
        ),
    )


@dataclass
class TikTokSettingsIssue:
    #: tiktok_privacy_required | tiktok_privacy_not_allowed | tiktok_interaction_disabled |
    #: tiktok_commercial_incomplete | tiktok_branded_private | tiktok_duration_exceeded
    code: str
    message: str


def validate_tiktok_settings(
    raw: Any, creator: TikTokCreatorInfo | None = None, duration_sec: float | None = None
) -> list[TikTokSettingsIssue]:
    """Validate TikTok posting settings (and creator constraints when known)."""
    s = parse_tiktok_settings(raw)
    issues: list[TikTokSettingsIssue] = []
    if not s.privacy_level:
        issues.append(TikTokSettingsIssue("tiktok_privacy_required", "Choose who can view this TikTok (no default is allowed)."))
    elif creator and creator.privacy_level_options and s.privacy_level not in creator.privacy_level_options:
        issues.append(
            TikTokSettingsIssue(
                "tiktok_privacy_not_allowed",
                f'"{TIKTOK_PRIVACY_LABELS[s.privacy_level]}" isn\'t available for this TikTok account.',
            )
        )
    if creator:
        disabled = [
            name
            for name, wanted, off in (
                ("comments", s.allow_comment, creator.comment_disabled),
                ("Duet", s.allow_duet, creator.duet_disabled),
                ("Stitch", s.allow_stitch, creator.stitch_disabled),
            )
            if wanted and off
        ]
        if disabled:
            issues.append(
                TikTokSettingsIssue(
                    "tiktok_interaction_disabled", f"This creator has turned off {', '.join(disabled)} in TikTok settings."
                )
            )
        if creator.max_video_post_duration_sec and duration_sec and duration_sec > creator.max_video_post_duration_sec:
            issues.append(
                TikTokSettingsIssue(
                    "tiktok_duration_exceeded",
                    f"This creator can post videos up to {creator.max_video_post_duration_sec:g}s.",
                )
            )
    c = s.commercial
    if c.enabled and not c.your_brand and not c.branded_content:
        issues.append(
            TikTokSettingsIssue(
                "tiktok_commercial_incomplete",
                "You need to indicate if your content promotes yourself, a third party, or both.",
            )
        )
    if c.enabled and c.branded_content and s.privacy_level == "SELF_ONLY":
        issues.append(TikTokSettingsIssue("tiktok_branded_private", "Branded content visibility can't be set to private (Only me)."))
    return issues


def commercial_label(raw: Any) -> str | None:
    """Label TikTok will show on the post for the chosen disclosure, if any."""
    c = parse_tiktok_settings(raw).commercial
    if not c.enabled:
        return None
    if c.branded_content:
        return "Paid partnership"
    if c.your_brand:
        return "Promotional content"
    return None


def consent_text(raw: Any) -> str:
    """Declaration TikTok requires to be shown before the user posts."""
    c = parse_tiktok_settings(raw).commercial
    if c.enabled and c.branded_content:
        return "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
    return "By posting, you agree to TikTok's Music Usage Confirmation."


def tiktok_post_info(raw: Any, creator: TikTokCreatorInfo | None = None) -> dict[str, Any]:
    """TikTok Direct Post ``post_info`` fields derived from settings."""
    s = raw if isinstance(raw, TikTokSettings) else parse_tiktok_settings(raw)
    c = s.commercial
    return {
        "privacy_level": s.privacy_level,
        "disable_comment": not s.allow_comment or bool(creator and creator.comment_disabled),
        "disable_duet": not s.allow_duet or bool(creator and creator.duet_disabled),
        "disable_stitch": not s.allow_stitch or bool(creator and creator.stitch_disabled),
        "brand_organic_toggle": c.enabled and c.your_brand,
        "brand_content_toggle": c.enabled and c.branded_content,
    }
