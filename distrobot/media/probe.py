"""Server-side video metadata via ffprobe.

Binary lookup order (first one that runs wins): ``FFPROBE_PATH``, then ``ffprobe`` on PATH.
If none is available or the file can't be parsed, callers fall back to browser-reported values.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass
from typing import Any

#: Containers we accept for uploaded videos. ffprobe picks a demuxer from the file's *content*, so
#: without this an uploaded HLS playlist / concat list could make it open URLs or local files (SSRF).
PROBE_FORMAT_WHITELIST = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,flv,mpeg,mpegts,asf,mxf,ogg"


@dataclass
class ProbeResult:
    duration_sec: float | None = None
    #: Display dimensions (already swapped for 90°/270° rotation).
    width: int | None = None
    height: int | None = None
    codec: str | None = None
    rotation: float = 0
    format_name: str | None = None


def _positive(v: Any) -> float | None:
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    return n if n > 0 and n != float("inf") else None


def _int_or_none(v: float | None) -> int | None:
    return int(v) if v is not None else None


def parse_ffprobe_output(out: dict[str, Any]) -> ProbeResult | None:
    """Extract duration and display dimensions from ``ffprobe -show_format -show_streams -of json`` output."""
    # Skip cover-art "video" streams (attached pictures in audio files / mp4 thumbnails).
    video = next(
        (s for s in out.get("streams") or [] if s.get("codec_type") == "video" and not (s.get("disposition") or {}).get("attached_pic")),
        None,
    )
    if not video:
        return None
    rotation_raw = next((d["rotation"] for d in video.get("side_data_list") or [] if d.get("rotation") is not None), None)
    if rotation_raw is None:
        rotation_raw = (video.get("tags") or {}).get("rotate")
    try:
        rotation = float(rotation_raw) if rotation_raw is not None else 0
    except (TypeError, ValueError):
        rotation = 0
    quarter = abs(rotation) % 180 == 90
    w = _int_or_none(_positive(video.get("width")))
    h = _int_or_none(_positive(video.get("height")))
    fmt = out.get("format") or {}
    return ProbeResult(
        duration_sec=_positive(fmt.get("duration")) or _positive(video.get("duration")),
        width=h if quarter else w,
        height=w if quarter else h,
        codec=video.get("codec_name"),
        rotation=rotation,
        format_name=fmt.get("format_name"),
    )


def ffprobe_candidates(env: dict[str, str] | None = None) -> list[str]:
    env = os.environ if env is None else env
    return [c for c in (env.get("FFPROBE_PATH"), "ffprobe") if c]


def ffprobe_args(file: str) -> list[str]:
    return [
        "-v", "error",
        "-protocol_whitelist", "file",  # never touch the network
        "-format_whitelist", PROBE_FORMAT_WHITELIST,
        "-print_format", "json",
        "-show_format",
        "-show_streams",
        # "file:" prefix so a path can never be parsed as an option or another protocol.
        f"file:{os.path.abspath(file)}",
    ]


async def _run(binary: str, file: str, timeout_s: float) -> tuple[str, str]:
    """Returns ("ok", stdout) | ("missing", "") | ("failed", "")."""
    try:
        proc = await asyncio.create_subprocess_exec(
            binary, *ffprobe_args(file), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL
        )
    except (FileNotFoundError, PermissionError, NotADirectoryError):
        return "missing", ""
    try:
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout_s)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return "failed", ""
    return ("ok", stdout.decode("utf-8", "replace")) if proc.returncode == 0 else ("failed", "")


async def probe_video(file: str, *, candidates: list[str] | None = None, timeout_s: float = 15) -> ProbeResult | None:
    """Probe a video file. None when no ffprobe is available or the file isn't a readable video."""
    for binary in candidates if candidates is not None else ffprobe_candidates():
        kind, stdout = await _run(binary, file, timeout_s)
        if kind == "missing":
            continue
        if kind == "failed":
            return None
        try:
            return parse_ffprobe_output(json.loads(stdout))
        except (ValueError, AttributeError):
            return None
    return None


def merge_metadata(client: dict[str, Any], probed: ProbeResult | None) -> dict[str, Any]:
    """Prefer server-measured values; fall back field-by-field to what the browser reported.
    ``source`` is "ffprobe" when the probe produced any of duration/width/height."""
    p = probed or ProbeResult()
    merged = {
        "duration_sec": p.duration_sec if p.duration_sec is not None else client.get("duration_sec"),
        "width": p.width if p.width is not None else client.get("width"),
        "height": p.height if p.height is not None else client.get("height"),
    }
    probed_any = probed is not None and any(v is not None for v in (p.duration_sec, p.width, p.height))
    client_any = any(client.get(k) is not None for k in ("duration_sec", "width", "height"))
    return {**merged, "source": "ffprobe" if probed_any else "client" if client_any else None}
