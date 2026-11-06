"""Validation engine: checks content + media against a platform's rules and suggests adaptations."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from ..models import MediaInfo, TargetContent
from .rules import PlatformRules, RuleOverrides, TextRule, get_rules, parse_aspect_ratio
from .text import count_text, extract_hashtags, normalize_hashtags, remove_hashtags, truncate_text
from .tiktok import TikTokCreatorInfo, validate_tiktok_settings


@dataclass
class ValidationIssue:
    severity: str  # error | warning | info
    code: str
    field: str  # title | caption | hashtags | media | settings
    message: str
    limit: float | None = None
    actual: float | None = None


@dataclass
class Effective:
    """What would actually be sent: caption with inline hashtags appended, or separate tags."""

    title: str | None
    caption: str
    tags: list[str]


@dataclass
class ValidationResult:
    platform: str
    ok: bool
    errors: list[ValidationIssue]
    warnings: list[ValidationIssue]
    infos: list[ValidationIssue]
    #: Adaptations are API-shaped dicts tagged by "type" (camelCase keys), e.g.
    #: {"type": "truncate_title", "title": ..., "automatic": True, "description": ...}.
    adaptations: list[dict[str, Any]]
    effective: Effective
    orientation: str | None
    short_form: bool


# ---------------------------------------------------------------------------
# Content resolution
# ---------------------------------------------------------------------------


def resolve_target_content(post: Any, target: Any = None) -> TargetContent:
    """Merge post defaults (title/caption/hashtags) with a target's ``*_override`` fields."""

    def get(obj: Any, name: str) -> Any:
        return obj.get(name) if isinstance(obj, dict) else getattr(obj, name, None)

    title_o = get(target, "title_override") if target is not None else None
    caption_o = get(target, "caption_override") if target is not None else None
    tags_o = get(target, "hashtags_override") if target is not None else None
    return TargetContent(
        title=title_o if title_o is not None else (get(post, "title") or ""),
        caption=caption_o if caption_o is not None else (get(post, "caption") or ""),
        hashtags=normalize_hashtags(tags_o if tags_o is not None else (get(post, "hashtags") or [])),
    )


def _hashtags_to_append(content: TargetContent) -> list[str]:
    """Hashtags from the explicit list that aren't already written inline in the caption."""
    inline = {t.lower() for t in extract_hashtags(content.caption)}
    return [t for t in normalize_hashtags(content.hashtags) if t.lower() not in inline]


def _hashtag_suffix(content: TargetContent) -> str:
    extra = _hashtags_to_append(content)
    if not extra:
        return ""
    sep = "\n\n" if content.caption.strip() else ""
    return sep + " ".join(f"#{t}" for t in extra)


def compose_content(content: TargetContent, rules: PlatformRules) -> Effective:
    """Build the text/tags actually sent to the platform."""
    title = content.title.strip() if rules.title.supported else None
    caption = content.caption.strip()
    if rules.hashtags.placement == "tags":
        tags = normalize_hashtags(extract_hashtags(content.caption) + list(content.hashtags))
        return Effective(title=title, caption=caption, tags=tags)
    return Effective(title=title, caption=(caption + _hashtag_suffix(replace(content, caption=caption))).strip(), tags=[])


def _all_hashtags(content: TargetContent) -> list[str]:
    return normalize_hashtags(extract_hashtags(content.caption) + list(content.hashtags))


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def js_num(n: float) -> str:
    """Format a number like JavaScript's default ``String(n)`` for typical values (45 → "45", 0.5 → "0.5")."""
    return str(int(n)) if float(n).is_integer() else repr(float(n))


def classify_orientation(width: float, height: float) -> str:
    ratio = width / height
    if ratio < 0.8:
        return "vertical"
    if ratio > 1.25:
        return "horizontal"
    return "square"


def format_bytes(n: float) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    v = float(n)
    i = 0
    while v >= 1024 and i < len(units) - 1:
        v /= 1024
        i += 1
    return f"{js_num(v) if v.is_integer() else f'{v:.1f}'} {units[i]}"


def format_duration(sec: float) -> str:
    if sec < 60:
        return f"{js_num(sec)}s"
    h = int(sec // 3600)
    m = int((sec % 3600) // 60)
    s = round(sec % 60)
    parts = [f"{h}h", f"{m}m" if m else "", f"{s}s" if s else ""] if h else [f"{m}m", f"{s}s" if s else ""]
    return " ".join(p for p in parts if p)


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


@dataclass
class _Collector:
    issues: list[ValidationIssue] = field(default_factory=list)
    adaptations: list[dict[str, Any]] = field(default_factory=list)

    def add(self, issue: ValidationIssue) -> None:
        self.issues.append(issue)

    def suggest(self, adaptation: dict[str, Any]) -> None:
        self.adaptations.append(adaptation)


def _check_forbidden(c: _Collector, field_name: str, value: str, rule: TextRule) -> str:
    """Flag forbidden characters and return the value with them removed."""
    if not rule.forbidden_chars:
        return value
    found = [ch for ch in rule.forbidden_chars if ch in value]
    if not found:
        return value
    stripped = value
    for ch in found:
        stripped = stripped.replace(ch, "")
    c.add(ValidationIssue("error", "forbidden_chars", field_name, f"{rule.label} contains characters not allowed: {' '.join(found)}"))
    c.suggest(
        {
            "type": "strip_forbidden_chars",
            "field": field_name,
            "value": stripped,
            "automatic": True,
            "description": f"Remove {' '.join(found)} from {rule.label.lower()}",
        }
    )
    return stripped


def _validate_title(c: _Collector, rules: PlatformRules, content: TargetContent) -> None:
    rule = rules.title
    title = content.title.strip()
    if not rule.supported:
        if title:
            c.add(
                ValidationIssue(
                    "info", "title_ignored", "title", f"{rules.display_name} has no separate title; it will not be published."
                )
            )
        return
    mode = rule.count_mode
    if not title and rule.required:
        c.add(ValidationIssue("error", "title_required", "title", f"{rules.display_name} requires a {rule.label.lower()}."))
        lines = content.caption.strip().split("\n")
        first_line = lines[0].strip() if lines else ""
        derived = remove_hashtags(first_line, extract_hashtags(first_line))
        if derived:
            c.suggest(
                {
                    "type": "derive_title",
                    "title": truncate_text(derived, rule.max_length, mode) if rule.max_length else derived,
                    "automatic": True,
                    "description": "Use the first line of the caption as the title",
                }
            )
        return
    clean = _check_forbidden(c, "title", title, rule)
    length = count_text(title, mode)
    if rule.max_length and length > rule.max_length:
        c.add(
            ValidationIssue(
                "error",
                "title_too_long",
                "title",
                f"{rule.label} is {length} characters; {rules.display_name} allows {rule.max_length}.",
                limit=rule.max_length,
                actual=length,
            )
        )
        c.suggest(
            {
                "type": "truncate_title",
                "title": truncate_text(clean, rule.max_length, mode),
                "automatic": True,
                "description": f"Shorten {rule.label.lower()} to {rule.max_length} characters",
            }
        )
    elif rule.recommended_max_length and length > rule.recommended_max_length:
        # Soft limit: the platform documents no hard cap, so warn instead of blocking.
        c.add(
            ValidationIssue(
                "warning",
                "title_long",
                "title",
                f"{rule.label} is {length} characters; {rule.recommended_max_length} or fewer is recommended on {rules.display_name}.",
                limit=rule.recommended_max_length,
                actual=length,
            )
        )
        c.suggest(
            {
                "type": "truncate_title",
                "title": truncate_text(clean, rule.recommended_max_length, mode),
                "automatic": True,
                "description": f"Shorten {rule.label.lower()} to {rule.recommended_max_length} characters",
            }
        )


def _validate_hashtags(c: _Collector, rules: PlatformRules, content: TargetContent) -> TargetContent:
    """Returns content after any hashtag trimming so caption truncation builds on it."""
    h = rules.hashtags
    if h.max_tag_length is not None:
        too_long = [t for t in _all_hashtags(content) if len(t) > h.max_tag_length]
        if too_long:
            drop = {t.lower() for t in too_long}
            content = TargetContent(
                title=content.title,
                caption=remove_hashtags(content.caption, too_long),
                hashtags=[t for t in content.hashtags if t.lower() not in drop],
            )
            listed = ", ".join(f"#{t}" for t in too_long)
            c.add(
                ValidationIssue(
                    "error",
                    "tag_too_long",
                    "hashtags",
                    f"{rules.display_name} tags can be at most {h.max_tag_length} characters: {listed}.",
                    limit=h.max_tag_length,
                )
            )
            c.suggest(
                {
                    "type": "trim_hashtags",
                    "caption": content.caption,
                    "hashtags": content.hashtags,
                    "automatic": True,
                    "description": f"Remove {len(too_long)} tag{'s' if len(too_long) > 1 else ''} longer than {h.max_tag_length} characters",
                }
            )
    tags = _all_hashtags(content)
    if h.max is not None and len(tags) > h.max:
        dropped = tags[h.max :]
        dropped_set = {t.lower() for t in dropped}
        trimmed = TargetContent(
            title=content.title,
            caption=remove_hashtags(content.caption, dropped),
            hashtags=[t for t in content.hashtags if t.lower() not in dropped_set],
        )
        c.add(
            ValidationIssue(
                "error",
                "too_many_hashtags",
                "hashtags",
                f"{len(tags)} hashtags; {rules.display_name} allows at most {h.max}.",
                limit=h.max,
                actual=len(tags),
            )
        )
        c.suggest(
            {
                "type": "trim_hashtags",
                "caption": trimmed.caption,
                "hashtags": trimmed.hashtags,
                "automatic": True,
                "description": f"Keep the first {h.max} hashtags, drop {len(dropped)}",
            }
        )
        return trimmed
    if h.recommended_max is not None and len(tags) > h.recommended_max:
        c.add(
            ValidationIssue(
                "warning",
                "many_hashtags",
                "hashtags",
                f"{len(tags)} hashtags; {h.recommended_max} or fewer is recommended on {rules.display_name}.",
                limit=h.recommended_max,
                actual=len(tags),
            )
        )
    return content


def _suggest_caption_truncation(rules: PlatformRules, content: TargetContent) -> dict[str, Any]:
    limit = rules.caption.max_length
    assert limit is not None
    mode = rules.caption.count_mode
    caption = content.caption.strip()
    description = f"Shorten {rules.caption.label.lower()} to fit {limit} characters"
    if rules.hashtags.placement == "inline":
        suffix = _hashtag_suffix(replace(content, caption=caption))
        suffix_cost = count_text(suffix, mode)
        if suffix_cost <= limit / 2:
            # Keep appended hashtags; shorten only the body (preserving its own trailing hashtags if possible).
            body = truncate_text(caption, limit - suffix_cost, mode, preserve_trailing_hashtags=True)
            return {"type": "truncate_caption", "caption": body, "hashtags": content.hashtags, "automatic": True, "description": description}
        # Hashtags alone eat most of the budget: fold them into the caption and truncate the whole thing.
        full = compose_content(content, rules).caption
        return {"type": "truncate_caption", "caption": truncate_text(full, limit, mode), "hashtags": [], "automatic": True, "description": description}
    return {
        "type": "truncate_caption",
        "caption": truncate_text(caption, limit, mode, preserve_trailing_hashtags=True),
        "hashtags": content.hashtags,
        "automatic": True,
        "description": description,
    }


def _validate_caption(c: _Collector, rules: PlatformRules, original: TargetContent, adapted: TargetContent) -> None:
    rule = rules.caption
    mode = rule.count_mode
    effective = compose_content(original, rules).caption
    # Operate on the hashtag-trimmed caption so later adaptations don't resurrect dropped tags.
    cleaned = replace(adapted, caption=_check_forbidden(c, "caption", adapted.caption, rule))
    length = count_text(effective, mode)
    if rule.max_length and length > rule.max_length:
        c.add(
            ValidationIssue(
                "error",
                "caption_too_long",
                "caption",
                f"{rule.label} is {length} characters (including hashtags); {rules.display_name} allows {rule.max_length}.",
                limit=rule.max_length,
                actual=length,
            )
        )
        c.suggest(_suggest_caption_truncation(rules, cleaned))
    elif rule.recommended_max_length and length > rule.recommended_max_length:
        c.add(
            ValidationIssue(
                "warning",
                "caption_folded",
                "caption",
                f'Only the first ~{rule.recommended_max_length} characters are visible before "more" on {rules.display_name}.',
                limit=rule.recommended_max_length,
                actual=length,
            )
        )


def _closest_recommended(ratio: float, recommended: tuple[str, ...]) -> str:
    best = recommended[0]
    for r in recommended:
        if abs(parse_aspect_ratio(r) - ratio) < abs(parse_aspect_ratio(best) - ratio):
            best = r
    return best


def _reframe(frm: str, target_aspect_ratio: str) -> dict[str, Any]:
    target = parse_aspect_ratio(target_aspect_ratio)
    to = "vertical" if target < 0.8 else "horizontal" if target > 1.25 else "square"
    # Going narrower (e.g. 16:9 → 9:16) is usually a center crop; going wider pads with blurred bars.
    from_ratio = 9 / 16 if frm == "vertical" else 16 / 9 if frm == "horizontal" else 1
    mode = "crop" if target < from_ratio else "pad"
    return {
        "type": "reframe",
        "from": frm,
        "targetAspectRatio": target_aspect_ratio,
        "mode": mode,
        "automatic": False,
        "description": f"Center-crop {frm} video to {target_aspect_ratio} ({to})"
        if mode == "crop"
        else f"Pad {frm} video to {target_aspect_ratio} ({to}) with blurred background",
    }


def _validate_media(c: _Collector, rules: PlatformRules, media: MediaInfo) -> tuple[str | None, bool]:
    v = rules.video
    name = rules.display_name

    if media.mime_type and media.mime_type not in v.mime_types:
        c.add(ValidationIssue("error", "unsupported_format", "media", f"{name} does not accept {media.mime_type}."))
        c.suggest({"type": "transcode", "mimeType": "video/mp4", "automatic": False, "description": "Transcode to MP4 (H.264/AAC)"})

    if media.size_bytes is not None:
        if v.max_file_size_bytes is not None and media.size_bytes > v.max_file_size_bytes:
            c.add(
                ValidationIssue(
                    "error",
                    "file_too_large",
                    "media",
                    f"File is {format_bytes(media.size_bytes)}; {name} allows up to {format_bytes(v.max_file_size_bytes)}.",
                    limit=v.max_file_size_bytes,
                    actual=media.size_bytes,
                )
            )
            c.suggest(
                {
                    "type": "compress",
                    "maxFileSizeBytes": v.max_file_size_bytes,
                    "automatic": False,
                    "description": f"Re-encode at a lower bitrate to fit {format_bytes(v.max_file_size_bytes)}",
                }
            )
        if v.min_file_size_bytes is not None and media.size_bytes < v.min_file_size_bytes:
            c.add(
                ValidationIssue(
                    "error",
                    "file_too_small",
                    "media",
                    f"File is {format_bytes(media.size_bytes)}; {name} requires at least {format_bytes(v.min_file_size_bytes)}.",
                    limit=v.min_file_size_bytes,
                    actual=media.size_bytes,
                )
            )

    if media.duration_sec is not None:
        if v.max_duration_sec is not None and media.duration_sec > v.max_duration_sec:
            c.add(
                ValidationIssue(
                    "error",
                    "too_long",
                    "media",
                    f"Video is {format_duration(media.duration_sec)}; {name} allows up to {format_duration(v.max_duration_sec)}.",
                    limit=v.max_duration_sec,
                    actual=media.duration_sec,
                )
            )
            c.suggest(
                {
                    "type": "trim_duration",
                    "maxDurationSec": v.max_duration_sec,
                    "automatic": False,
                    "description": f"Trim to {format_duration(v.max_duration_sec)}",
                }
            )
        if v.min_duration_sec is not None and media.duration_sec < v.min_duration_sec:
            c.add(
                ValidationIssue(
                    "error",
                    "too_short",
                    "media",
                    f"Video is {format_duration(media.duration_sec)}; {name} requires at least {format_duration(v.min_duration_sec)}.",
                    limit=v.min_duration_sec,
                    actual=media.duration_sec,
                )
            )

    if not media.width or not media.height:
        c.add(ValidationIssue("info", "media_metadata_missing", "media", "Video dimensions unknown; aspect ratio checks skipped."))
        return None, False

    width, height = media.width, media.height
    ratio = width / height
    orientation = classify_orientation(width, height)
    target = v.recommended_aspect_ratios[0] if v.recommended_aspect_ratios else None

    if (v.min_width and width < v.min_width) or (v.min_height and height < v.min_height):
        c.add(
            ValidationIssue(
                "error",
                "resolution_too_low",
                "media",
                f"{width}×{height} is below {name}'s minimum of {v.min_width or 0}×{v.min_height or 0}.",
            )
        )

    # Small epsilon so exact boundary ratios (e.g. 9:16 encoded as 1080x1920) aren't rejected by float error.
    eps = 1e-3
    out_of_range = (v.min_aspect_ratio is not None and ratio < v.min_aspect_ratio - eps) or (
        v.max_aspect_ratio is not None and ratio > v.max_aspect_ratio + eps
    )
    if out_of_range:
        c.add(
            ValidationIssue(
                "error", "aspect_ratio_out_of_range", "media", f"Aspect ratio {ratio:.2f} is outside {name}'s allowed range.", actual=ratio
            )
        )
        c.suggest(_reframe(orientation, _closest_recommended(ratio, v.recommended_aspect_ratios)))

    # YouTube-style short-form classification.
    sf = rules.short_form
    short_form = bool(sf) and orientation != "horizontal" and media.duration_sec is not None and media.duration_sec <= sf.max_duration_sec
    if short_form:
        c.add(
            ValidationIssue(
                "info",
                "classified_short_form",
                "media",
                f"Will be published as a {sf.name} ({orientation}, ≤ {format_duration(sf.max_duration_sec)}).",
            )
        )
        return orientation, True

    if not out_of_range and v.preferred_orientation and orientation != v.preferred_orientation and target:
        c.add(
            ValidationIssue(
                "warning",
                "orientation_mismatch",
                "media",
                f"{name} is optimized for {v.preferred_orientation} video ({target}); this video is {orientation}.",
            )
        )
        c.suggest(_reframe(orientation, target))

    return orientation, False


def validate_for_platform(
    platform: str,
    content: TargetContent,
    media: MediaInfo | None = None,
    *,
    overrides: RuleOverrides | None = None,
    settings: dict[str, Any] | None = None,
    tiktok_creator: TikTokCreatorInfo | None = None,
) -> ValidationResult:
    """Validate content (+ optional media) for one platform.

    ``settings``: per-target platform settings; when given, platform-specific requirements are checked
    (TikTok privacy level / commercial disclosure). Omit (None) to skip settings checks.
    """
    rules = get_rules(platform, overrides)
    content = TargetContent(
        title=content.title or "", caption=content.caption or "", hashtags=normalize_hashtags(content.hashtags or [])
    )
    c = _Collector()
    _validate_title(c, rules, content)
    after_hashtags = _validate_hashtags(c, rules, content)
    _validate_caption(c, rules, content, after_hashtags)
    orientation, short_form = _validate_media(c, rules, media) if media else (None, False)
    if platform == "tiktok" and settings is not None:
        duration = media.duration_sec if media else None
        for issue in validate_tiktok_settings(settings, tiktok_creator, duration):
            c.add(ValidationIssue("error", issue.code, "settings", issue.message))

    errors = [i for i in c.issues if i.severity == "error"]
    return ValidationResult(
        platform=platform,
        ok=not errors,
        errors=errors,
        warnings=[i for i in c.issues if i.severity == "warning"],
        infos=[i for i in c.issues if i.severity == "info"],
        adaptations=c.adaptations,
        effective=compose_content(content, rules),
        orientation=orientation,
        short_form=short_form,
    )


def apply_text_adaptations(content: TargetContent, adaptations: list[dict[str, Any]]) -> TargetContent:
    """Apply the automatic (text-only) adaptations. Media adaptations need processing and are ignored."""
    out = TargetContent(title=content.title, caption=content.caption, hashtags=list(content.hashtags))
    for a in adaptations:
        t = a.get("type")
        if t in ("truncate_title", "derive_title"):
            out = replace(out, title=a["title"])
        elif t == "strip_forbidden_chars":
            out = replace(out, title=a["value"]) if a["field"] == "title" else replace(out, caption=a["value"])
        elif t in ("trim_hashtags", "truncate_caption"):
            out = replace(out, caption=a["caption"], hashtags=list(a["hashtags"]))
    return out


def requirement_rows(rules: PlatformRules, result: ValidationResult, media: MediaInfo | None) -> list[dict[str, str]]:
    """Per-platform requirements table for the compose UI: label, value, level (ok|warn|err|na)."""
    eff = result.effective
    mode = rules.caption.count_mode
    cap_len = count_text(eff.caption, mode)
    cap_max = rules.caption.max_length
    title_len = count_text(eff.title, rules.title.count_mode) if eff.title is not None else 0
    tag_count = len(eff.tags) if rules.hashtags.placement == "tags" else len(extract_hashtags(eff.caption))
    v = rules.video
    info = media or MediaInfo()
    orientation = classify_orientation(info.width, info.height) if info.width and info.height else None
    rows: list[dict[str, str]] = []

    if rules.title.supported:
        t = rules.title
        level = "err" if (t.max_length and title_len > t.max_length) or (t.required and not title_len) else "ok"
        rows.append({"label": t.label, "value": f"{title_len} / {t.max_length or '∞'}{' · required' if t.required else ''}", "level": level})
    else:
        rows.append({"label": "Title", "value": "not used", "level": "na"})

    rec = rules.caption.recommended_max_length
    rows.append(
        {
            "label": rules.caption.label,
            "value": f"{cap_len:,} / {f'{cap_max:,}' if cap_max else '∞'}{' weighted' if mode == 'x-weighted' else ''}"
            f"{f' · folds at {rec}' if rec else ''}",
            "level": "err" if cap_max and cap_len > cap_max else "warn" if rec and cap_len > rec else "ok",
        }
    )
    h = rules.hashtags
    rows.append(
        {
            "label": "Tags" if h.placement == "tags" else "Hashtags",
            "value": f"{tag_count} / {h.max if h.max is not None else '∞'}{f' · ≤{h.recommended_max} recommended' if h.recommended_max else ''}",
            "level": "err"
            if h.max is not None and tag_count > h.max
            else "warn"
            if h.recommended_max is not None and tag_count > h.recommended_max
            else "ok",
        }
    )
    d = info.duration_sec
    rows.append(
        {
            "label": "Duration",
            "value": f"{format_duration(d) if d is not None else '?'} · "
            f"{format_duration(v.min_duration_sec) if v.min_duration_sec else '0s'}–"
            f"{format_duration(v.max_duration_sec) if v.max_duration_sec else 'no limit'}",
            "level": "na"
            if d is None
            else "err"
            if (v.max_duration_sec and d > v.max_duration_sec) or (v.min_duration_sec and d < v.min_duration_sec)
            else "ok",
        }
    )
    size = info.size_bytes
    rows.append(
        {
            "label": "File size",
            "value": f"{format_bytes(size) if size is not None else '?'} · max "
            f"{format_bytes(v.max_file_size_bytes) if v.max_file_size_bytes else 'plan-based'}",
            "level": "na" if size is None else "err" if v.max_file_size_bytes and size > v.max_file_size_bytes else "ok",
        }
    )
    aspect = next((i for i in result.errors + result.warnings if i.code in ("aspect_ratio_out_of_range", "orientation_mismatch")), None)
    rows.append(
        {
            "label": "Aspect",
            "value": f"{orientation or '?'} · {', '.join(v.recommended_aspect_ratios)} recommended",
            "level": "na" if not orientation else ("err" if aspect.severity == "error" else "warn") if aspect else "ok",
        }
    )
    return rows
