"""Text counting, hashtag handling and truncation the way each platform counts characters."""

from __future__ import annotations

import regex

from .rules import CountMode

ELLIPSIS = "…"

_GRAPHEME = regex.compile(r"\X")
_EMOJI = regex.compile(r"\p{Extended_Pictographic}")
_URL = regex.compile(r"https?://[^\s]+")
#: X counts every URL as 23 characters (t.co wrapping).
X_URL_WEIGHT = 23
#: Code point ranges X weights as 1; everything else counts as 2.
_X_LIGHT_RANGES = ((0, 4351), (8192, 8205), (8208, 8223), (8242, 8247))

HASHTAG_RE = regex.compile(r"(^|[^\p{L}\p{N}_&#/])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)")
_TRAILING_TAGS = regex.compile(r"(\s*(?:#[\p{L}\p{N}_]+\s*)+)\Z")


def graphemes(text: str) -> list[str]:
    return _GRAPHEME.findall(text)


def _x_weight_of_segment(segment: str) -> int:
    if _EMOJI.search(segment):
        return 2
    weight = 0
    for ch in segment:
        cp = ord(ch)
        weight += 1 if any(lo <= cp <= hi for lo, hi in _X_LIGHT_RANGES) else 2
    return weight


def _x_weight(text: str) -> int:
    return sum(_x_weight_of_segment(g) for g in graphemes(text))


def count_text(text: str, mode: CountMode = "codepoints") -> int:
    """Length of ``text`` as counted by the platform."""
    if mode == "utf16":
        return len(text.encode("utf-16-le")) // 2
    if mode == "codepoints":
        return len(text)
    total = 0
    last = 0
    for m in _URL.finditer(text):
        total += _x_weight(text[last : m.start()]) + X_URL_WEIGHT
        last = m.end()
    return total + _x_weight(text[last:])


def extract_hashtags(text: str) -> list[str]:
    """Hashtags found in text, without "#", de-duplicated case-insensitively, in order of appearance."""
    seen: set[str] = set()
    out: list[str] = []
    for m in HASHTAG_RE.finditer(text):
        tag = m.group(2)
        if tag.lower() not in seen:
            seen.add(tag.lower())
            out.append(tag)
    return out


def normalize_hashtags(tags: list[str]) -> list[str]:
    """Strip "#", whitespace, empties and case-insensitive duplicates."""
    seen: set[str] = set()
    out: list[str] = []
    for raw in tags:
        tag = regex.sub(r"\s+", "", regex.sub(r"^#+", "", str(raw).strip()))
        if not tag or tag.lower() in seen:
            continue
        seen.add(tag.lower())
        out.append(tag)
    return out


def remove_hashtags(text: str, tags: list[str]) -> str:
    """Remove the given hashtags (case-insensitive) from text, tidying leftover whitespace."""
    if not tags:
        return text
    drop = {t.lower() for t in tags}
    out = HASHTAG_RE.sub(lambda m: m.group(1) if m.group(2).lower() in drop else m.group(0), text)
    out = regex.sub(r"[ \t]{2,}", " ", out)
    out = regex.sub(r"[ \t]+$", "", out, flags=regex.MULTILINE)
    out = regex.sub(r"\n{3,}", "\n\n", out)
    return out.strip()


def split_trailing_hashtags(text: str) -> tuple[str, str]:
    """Split text into (body, trailing block made only of hashtags/whitespace)."""
    m = _TRAILING_TAGS.search(text)
    if not m or m.start() == 0:
        return text, ""
    return text[: m.start()], m.group(0)


def _cut_to_budget(text: str, budget: int, mode: CountMode) -> str:
    out = []
    used = 0
    for g in graphemes(text):
        cost = count_text(g, mode)
        if used + cost > budget:
            break
        out.append(g)
        used += cost
    return "".join(out)


def truncate_text(
    text: str,
    limit: int,
    mode: CountMode = "codepoints",
    *,
    ellipsis: str = ELLIPSIS,
    preserve_trailing_hashtags: bool = False,
) -> str:
    """Truncate to fit ``limit`` under ``mode``, preferring a word boundary and appending an ellipsis.

    Never splits grapheme clusters (emoji, combining marks). With ``preserve_trailing_hashtags``, a
    trailing hashtag block is kept intact when it uses at most half the budget.
    """
    if count_text(text, mode) <= limit:
        return text

    if preserve_trailing_hashtags:
        body, trailing = split_trailing_hashtags(text)
        trailing_cost = count_text(trailing, mode)
        if trailing and trailing_cost <= limit / 2:
            return truncate_text(body, limit - trailing_cost, mode, ellipsis=ellipsis) + trailing

    budget = limit - count_text(ellipsis, mode)
    if budget <= 0:
        return _cut_to_budget(text, limit, mode)

    # Per-grapheme costs can under-count context-dependent weights (X URLs), so re-check and shrink.
    while True:
        cut = _cut_to_budget(text, budget, mode)
        # Back off to a word boundary unless that would throw away too much text.
        ends_on_boundary = bool(regex.match(r"\s", text[len(cut) :]))
        bm = regex.search(r"\s\S*\Z", cut)
        boundary = bm.start() if bm else -1
        if ends_on_boundary:
            base = cut
        elif boundary > len(cut) * 0.6:
            base = cut[:boundary]
        else:
            base = cut
        result = regex.sub(r"[\s.,;:!?\-–—]+\Z", "", base) + ellipsis
        over = count_text(result, mode) - limit
        if over <= 0 or budget <= 1:
            return result
        budget -= over
