"""YouTube Data API v3.

Upload flow (https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol):
  1. POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status (JSON metadata)
     → 200 + ``Location: <session URI>``
  2. PUT <session URI> in chunks (multiples of 256 KiB) with ``Content-Range: bytes a-b/total``
     → 308 Resume Incomplete (+ ``Range: bytes=0-n``) until the final 200/201 with the video resource.
  3. Interrupted? PUT <session URI> with ``Content-Range: bytes */total`` to learn the offset.
  4. Optional: POST /upload/youtube/v3/thumbnails/set?videoId=… with the image bytes.
Scheduling: status.privacyStatus=private + status.publishAt (YouTube flips it public at that time).
"""

from __future__ import annotations

import os
import re
from typing import Any
from urllib.parse import quote, urlencode

import httpx

from ...models import iso, now_utc, parse_iso
from ...platforms.validate import ValidationResult
from ..base import BaseAdapter, Profile
from ..http import bearer, read_file_chunk, request, request_json
from ..oauth import OAuthConfig
from ..types import DoPublishResult, PublishContext, PublishRequest, Thumbnail

UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/videos"
THUMBNAIL_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set"
CHUNK_GRANULARITY = 256 * 1024
MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024
MAX_TAGS_CHARS = 500


def fit_tags(tags: list[str], budget: int = MAX_TAGS_CHARS) -> list[str]:
    """Keep tags within YouTube's 500-character budget (tags with spaces count their quotes; commas separate)."""
    out: list[str] = []
    used = 0
    for tag in tags:
        cost = len(tag) + (2 if re.search(r"\s", tag) else 0) + (1 if out else 0)
        if used + cost > budget:
            break
        out.append(tag)
        used += cost
    return out


def next_offset_from_range(range_header: str | None) -> int:
    """"bytes=0-524287" → next offset 524288; missing header → 0."""
    m = re.search(r"bytes=\d+-(\d+)", range_header or "")
    return int(m.group(1)) + 1 if m else 0


class YouTubeAdapter(BaseAdapter):
    platform = "youtube"
    features = {"native_scheduling": True, "thumbnail": True}
    oauth_config = OAuthConfig(
        authorize_url="https://accounts.google.com/o/oauth2/v2/auth",
        token_url="https://oauth2.googleapis.com/token",
        scopes=("https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"),
        client_id_env="YOUTUBE_CLIENT_ID",
        client_secret_env="YOUTUBE_CLIENT_SECRET",
        # offline + consent so Google returns a refresh token.
        extra_auth_params={"access_type": "offline", "prompt": "consent", "include_granted_scopes": "true"},
    )

    def __init__(self, chunk_size: int = 8 * 1024 * 1024):
        """``chunk_size`` is rounded down to a multiple of 256 KiB."""
        self.chunk_size = max(CHUNK_GRANULARITY, (chunk_size // CHUNK_GRANULARITY) * CHUNK_GRANULARITY)

    async def fetch_profile(self, token: dict[str, Any], client: httpx.AsyncClient) -> Profile:
        data = await self.get_json(client, "https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", token["access_token"])
        items = data.get("items") or []
        if not items:
            raise RuntimeError("No YouTube channel on this Google account")
        ch = items[0]
        return Profile(ch["id"], ch["snippet"]["title"], {"customUrl": ch["snippet"].get("customUrl")})

    def build_metadata(self, req: PublishRequest, validation: ValidationResult) -> dict[str, Any]:
        """videos.insert resource body."""
        s = req.settings
        when = parse_iso(req.scheduled_at)
        publish_at = iso(when) if when and when > now_utc() else None
        snippet: dict[str, Any] = {
            "title": validation.effective.title if validation.effective.title is not None else req.content.title,
            "description": validation.effective.caption,
            "tags": fit_tags(req.content.hashtags),
            "categoryId": s["categoryId"] if isinstance(s.get("categoryId"), str) else "22",  # People & Blogs
        }
        if isinstance(s.get("defaultLanguage"), str):
            snippet["defaultLanguage"] = s["defaultLanguage"]
        status: dict[str, Any] = {
            # publishAt requires a private video; YouTube makes it public at that time.
            "privacyStatus": "private" if publish_at else req.visibility,
            "selfDeclaredMadeForKids": s.get("madeForKids") is True,
            "embeddable": s.get("embeddable") is not False,
        }
        if publish_at:
            status["publishAt"] = publish_at
        return {"snippet": snippet, "status": status}

    async def do_publish(self, req: PublishRequest, ctx: PublishContext, validation: ValidationResult) -> DoPublishResult:
        client = ctx.client
        auth = bearer(ctx.account.access_token)
        size = os.path.getsize(req.media_path)
        metadata = self.build_metadata(req, validation)
        p = self.display_name
        content_type = req.media.mime_type or "video/*"

        # Resume a previous session if the checkpoint matches this file.
        video: dict[str, Any] | None = None
        offset = 0
        session_uri: str | None = None
        cp = req.checkpoint if isinstance(req.checkpoint, dict) else None
        if cp and cp.get("sessionUri") and cp.get("totalBytes") == size:
            res = await request(
                client, "PUT", cp["sessionUri"], platform=p, allow_statuses=(308, 404, 410),
                headers={**auth, "Content-Range": f"bytes */{size}"},
            )
            if res.status_code == 308:
                session_uri = cp["sessionUri"]
                offset = next_offset_from_range(res.headers.get("range"))
            elif res.is_success:
                session_uri = cp["sessionUri"]
                video = res.json()
            # 404/410: session expired → start over.

        if not session_uri:
            params = {"uploadType": "resumable", "part": "snippet,status"}
            if req.settings.get("notifySubscribers") is False:
                params["notifySubscribers"] = "false"
            res = await request(
                client, "POST", f"{UPLOAD_ENDPOINT}?{urlencode(params)}", platform=p,
                headers={
                    **auth,
                    "Content-Type": "application/json; charset=UTF-8",
                    "X-Upload-Content-Length": str(size),
                    "X-Upload-Content-Type": content_type,
                },
                json=metadata,
            )
            session_uri = res.headers.get("location")
            if not session_uri:
                raise RuntimeError("YouTube did not return an upload session URI")
            ctx.checkpoint({"sessionUri": session_uri, "totalBytes": size})

        while video is None:
            chunk = read_file_chunk(req.media_path, offset, min(self.chunk_size, size - offset))
            res = await request(
                client, "PUT", session_uri, platform=p, allow_statuses=(308,),
                headers={**auth, "Content-Type": content_type, "Content-Range": f"bytes {offset}-{offset + len(chunk) - 1}/{size}"},
                content=chunk,
            )
            if res.status_code == 308:
                nxt = next_offset_from_range(res.headers.get("range"))
                if nxt <= offset and chunk:
                    # Server didn't accept anything; avoid a tight loop and let the job retry from the checkpoint.
                    raise RuntimeError(f"YouTube upload made no progress at byte {offset}")
                offset = nxt
                ctx.progress("uploading", offset / size)
            else:
                video = res.json()
        ctx.progress("processing", 1)

        warnings: list[str] = []
        if req.thumbnail:
            warning = await self._set_thumbnail(client, auth, video["id"], req.thumbnail)
            if warning:
                warnings.append(warning)

        vid = video["id"]
        return DoPublishResult(
            url=f"https://www.youtube.com/shorts/{vid}" if validation.short_form else f"https://www.youtube.com/watch?v={vid}",
            external_id=vid,
            warnings=warnings,
            extra={
                "privacyStatus": metadata["status"]["privacyStatus"],
                "publishAt": metadata["status"].get("publishAt"),
                "tags": metadata["snippet"]["tags"],
                "categoryId": metadata["snippet"]["categoryId"],
            },
        )

    async def _set_thumbnail(self, client: httpx.AsyncClient, auth: dict[str, str], video_id: str, thumb: Thumbnail) -> str | None:
        """Thumbnail failures don't fail the publish (e.g. unverified channels can't set custom thumbnails)."""
        if thumb.mime_type not in ("image/jpeg", "image/png"):
            return f"Thumbnail skipped: YouTube accepts JPEG or PNG, got {thumb.mime_type}."
        with open(thumb.path, "rb") as fh:
            data = fh.read()
        if len(data) > MAX_THUMBNAIL_BYTES:
            return "Thumbnail skipped: YouTube thumbnails must be 2 MB or smaller."
        try:
            await request_json(
                client, "POST", f"{THUMBNAIL_ENDPOINT}?videoId={quote(video_id, safe='')}&uploadType=media",
                platform=self.display_name, headers={**auth, "Content-Type": thumb.mime_type}, content=data,
            )
            return None
        except Exception as err:  # noqa: BLE001 — any failure only downgrades to a warning
            return f"Video published, but setting the thumbnail failed: {err}"
