"""Facebook Pages video — chunked upload via graph-video.facebook.com.

  1. POST /{page-id}/videos upload_phase=start (file_size)        → upload_session_id, video_id, offsets
  2. POST upload_phase=transfer (start_offset, video_file_chunk)  → next offsets, until start == end
  3. POST upload_phase=finish (title, description, published, thumb)
Uses the Page access token captured at connect time (GET /me/accounts).
Docs: https://developers.facebook.com/docs/video-api/guides/publishing
Shapes follow the public docs but are unverified against the live API.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from ...platforms.validate import ValidationResult
from ..base import BaseAdapter, Profile
from ..http import read_file_chunk, request_json
from ..oauth import OAuthConfig
from ..types import AdapterError, DoPublishResult, PublishContext, PublishRequest


def _version() -> str:
    return os.environ.get("FACEBOOK_GRAPH_VERSION") or "v23.0"


class FacebookAdapter(BaseAdapter):
    platform = "facebook"
    features = {"thumbnail": True}

    @property
    def oauth_config(self) -> OAuthConfig:  # type: ignore[override]
        v = _version()
        return OAuthConfig(
            authorize_url=f"https://www.facebook.com/{v}/dialog/oauth",
            token_url=f"https://graph.facebook.com/{v}/oauth/access_token",
            scopes=("pages_show_list", "pages_read_engagement", "pages_manage_posts", "publish_video"),
            scope_separator=",",
            client_id_env="FACEBOOK_APP_ID",
            client_secret_env="FACEBOOK_APP_SECRET",
        )

    async def fetch_profile(self, token: dict[str, Any], client: httpx.AsyncClient) -> Profile:
        v = _version()
        me = await self.get_json(client, f"https://graph.facebook.com/{v}/me?fields=id,name", token["access_token"])
        accounts = await self.get_json(client, f"https://graph.facebook.com/{v}/me/accounts?fields=id,name,access_token", token["access_token"])
        pages = [{"id": p["id"], "name": p["name"], "accessToken": p["access_token"]} for p in accounts.get("data") or []]
        return Profile(me["id"], me["name"], {"pages": pages})

    async def _phase(self, client: httpx.AsyncClient, page_id: str, data: dict[str, str], files: dict | None = None) -> dict[str, Any]:
        return await request_json(
            client, "POST", f"https://graph-video.facebook.com/{_version()}/{page_id}/videos",
            platform=self.display_name, data=data, files=files,
        )

    async def do_publish(self, req: PublishRequest, ctx: PublishContext, validation: ValidationResult) -> DoPublishResult:
        client = ctx.client
        pages = (ctx.account.metadata or {}).get("pages") or []
        wanted = req.settings.get("pageId") if isinstance(req.settings.get("pageId"), str) else None
        page = next((p for p in pages if p["id"] == wanted), None) if wanted else (pages[0] if pages else None)
        if not page:
            raise AdapterError(
                "validation_failed",
                f"Facebook Page {wanted} is not available to this account." if wanted else "No Facebook Pages found for this account.",
            )
        size = os.path.getsize(req.media_path)
        warnings: list[str] = []
        token = page["accessToken"]

        cp = req.checkpoint if isinstance(req.checkpoint, dict) else None
        if not cp or cp.get("pageId") != page["id"]:
            start = await self._phase(client, page["id"], {"upload_phase": "start", "file_size": str(size), "access_token": token})
            if not start.get("upload_session_id") or not start.get("video_id"):
                raise AdapterError("upstream_error", "Facebook start phase returned no session")
            cp = {
                "pageId": page["id"],
                "sessionId": start["upload_session_id"],
                "videoId": start["video_id"],
                "startOffset": int(start.get("start_offset") or 0),
                "endOffset": int(start.get("end_offset") or 0),
            }
            ctx.checkpoint(cp)

        while cp["startOffset"] < cp["endOffset"]:
            chunk = read_file_chunk(req.media_path, cp["startOffset"], cp["endOffset"] - cp["startOffset"])
            nxt = await self._phase(
                client,
                page["id"],
                {"upload_phase": "transfer", "upload_session_id": cp["sessionId"], "start_offset": str(cp["startOffset"]), "access_token": token},
                files={"video_file_chunk": ("chunk", chunk, "application/octet-stream")},
            )
            cp = {**cp, "startOffset": int(nxt["start_offset"]), "endOffset": int(nxt["end_offset"])}
            ctx.checkpoint(cp)
            ctx.progress("uploading", min(1, cp["startOffset"] / size))

        published = req.visibility == "public"
        if not published:
            warnings.append("Facebook Pages have no unlisted/private videos; uploaded as unpublished.")
        data = {
            "upload_phase": "finish",
            "upload_session_id": cp["sessionId"],
            "access_token": token,
            "published": "true" if published else "false",
            "description": validation.effective.caption,
        }
        if validation.effective.title:
            data["title"] = validation.effective.title
        files = None
        if req.thumbnail:
            with open(req.thumbnail.path, "rb") as fh:
                files = {"thumb": ("thumb", fh.read(), req.thumbnail.mime_type)}
        fin = await self._phase(client, page["id"], data, files)
        if fin.get("success") is False:
            raise AdapterError("upstream_error", "Facebook finish phase failed", True)
        ctx.checkpoint(None)
        return DoPublishResult(
            f"https://www.facebook.com/{page['id']}/videos/{cp['videoId']}",
            cp["videoId"],
            warnings,
            {"pageId": page["id"], "pageName": page["name"]},
        )
