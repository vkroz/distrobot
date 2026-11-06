"""Instagram API with Instagram Login — Reels via resumable upload.

  1. POST /{ig-user-id}/media (media_type=REELS, upload_type=resumable, caption) → container id
  2. POST rupload.facebook.com/ig-api-upload/{ver}/{container} (headers offset, file_size) with bytes
  3. GET /{container}?fields=status_code → poll until FINISHED
  4. POST /{ig-user-id}/media_publish?creation_id=… → media id
  5. GET /{media-id}?fields=permalink
Docs: https://developers.facebook.com/docs/instagram-platform/content-publishing
Shapes follow the public docs but are unverified against the live API.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlencode

import httpx

from ...platforms.validate import ValidationResult
from ..base import BaseAdapter, Profile
from ..http import poll_until, read_file_chunk, request, request_json
from ..oauth import OAuthConfig
from ..types import AdapterError, DoPublishResult, PublishContext, PublishRequest


def _version() -> str:
    return os.environ.get("INSTAGRAM_GRAPH_VERSION") or "v23.0"


class InstagramAdapter(BaseAdapter):
    platform = "instagram"
    oauth_config = OAuthConfig(
        authorize_url="https://www.instagram.com/oauth/authorize",
        token_url="https://api.instagram.com/oauth/access_token",
        scopes=("instagram_business_basic", "instagram_business_content_publish"),
        scope_separator=",",
        client_id_env="INSTAGRAM_APP_ID",
        client_secret_env="INSTAGRAM_APP_SECRET",
    )

    def __init__(self, poll_interval_ms: float = 5000, poll_timeout_ms: float = 10 * 60_000):
        self.poll_interval_ms = poll_interval_ms
        self.poll_timeout_ms = poll_timeout_ms

    async def fetch_profile(self, token: dict[str, Any], client: httpx.AsyncClient) -> Profile:
        me = await self.get_json(client, "https://graph.instagram.com/me?fields=user_id,username", token["access_token"])
        return Profile(str(me["user_id"]), me["username"])

    async def _post(self, client: httpx.AsyncClient, url: str, params: dict[str, str]) -> Any:
        return await request_json(client, "POST", url, platform=self.display_name, data=params)

    async def _get(self, client: httpx.AsyncClient, url: str, token: str) -> Any:
        sep = "&" if "?" in url else "?"
        return await request_json(client, "GET", f"{url}{sep}{urlencode({'access_token': token})}", platform=self.display_name)

    async def do_publish(self, req: PublishRequest, ctx: PublishContext, validation: ValidationResult) -> DoPublishResult:
        client = ctx.client
        token = ctx.account.access_token
        ig_user = ctx.account.external_id
        graph = f"https://graph.instagram.com/{_version()}"
        cp = req.checkpoint if isinstance(req.checkpoint, dict) else None

        if not cp:
            params = {
                "media_type": "REELS",
                "upload_type": "resumable",
                "caption": validation.effective.caption,
                "share_to_feed": "false" if req.settings.get("shareToFeed") is False else "true",
                "access_token": token,
            }
            if isinstance(req.settings.get("thumbOffsetMs"), (int, float)):
                params["thumb_offset"] = str(req.settings["thumbOffsetMs"])
            container = await self._post(client, f"{graph}/{ig_user}/media", params)
            cp = {"containerId": container["id"], "uploaded": False}
            ctx.checkpoint(cp)

        if not cp.get("uploaded"):
            # Reels are capped at 300 MB, so a single request is acceptable here.
            size = os.path.getsize(req.media_path)
            data = read_file_chunk(req.media_path, 0, size)
            await request(
                client, "POST", f"https://rupload.facebook.com/ig-api-upload/{_version()}/{cp['containerId']}",
                platform=self.display_name, headers={"Authorization": f"OAuth {token}", "offset": "0", "file_size": str(size)},
                content=data,
            )
            cp = {**cp, "uploaded": True}
            ctx.checkpoint(cp)
            ctx.progress("uploading", 1)

        ctx.progress("processing")
        container_id = cp["containerId"]

        async def check() -> dict[str, Any] | None:
            st = await self._get(client, f"{graph}/{container_id}?fields=status_code,status", token)
            code = st.get("status_code")
            if code == "ERROR":
                ctx.checkpoint(None)
                raise AdapterError("upstream_error", f"Instagram could not process the video: {st.get('status') or 'ERROR'}")
            if code == "EXPIRED":
                # Container lifetime ran out; start over with a fresh container on retry.
                ctx.checkpoint(None)
                raise AdapterError("upstream_error", "Instagram media container expired", True)
            return st if code in ("FINISHED", "PUBLISHED") else None

        await poll_until(check, interval_ms=self.poll_interval_ms, timeout_ms=self.poll_timeout_ms, platform=self.display_name)

        published = await self._post(client, f"{graph}/{ig_user}/media_publish", {"creation_id": container_id, "access_token": token})
        ctx.checkpoint(None)
        warnings: list[str] = []
        url = None
        try:
            url = (await self._get(client, f"{graph}/{published['id']}?fields=permalink", token)).get("permalink")
        except Exception:  # noqa: BLE001 — permalink is best-effort
            warnings.append("Published, but could not fetch the Instagram permalink.")
        return DoPublishResult(url, published["id"], warnings)
