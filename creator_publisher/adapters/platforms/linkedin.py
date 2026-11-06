"""LinkedIn Videos API + Posts API (versioned REST).

  1. POST /rest/videos?action=initializeUpload → video URN, uploadToken, uploadInstructions[], thumbnailUploadUrl
  2. PUT each byte range to its uploadUrl (collect ETags); optional thumbnail PUT
  3. POST /rest/videos?action=finalizeUpload {video, uploadToken, uploadedPartIds}
  4. GET /rest/videos/{urn} until AVAILABLE
  5. POST /rest/posts → post URN in x-restli-id
Docs: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/videos-api
Shapes follow the public docs but are unverified against the live API.
"""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import quote

import httpx

from ...platforms.validate import ValidationResult
from ..base import BaseAdapter, Profile
from ..http import bearer, poll_until, read_file_chunk, request, request_json
from ..oauth import OAuthConfig
from ..types import AdapterError, DoPublishResult, PublishContext, PublishRequest

API = "https://api.linkedin.com/rest"


class LinkedInAdapter(BaseAdapter):
    platform = "linkedin"
    features = {"thumbnail": True}
    oauth_config = OAuthConfig(
        authorize_url="https://www.linkedin.com/oauth/v2/authorization",
        token_url="https://www.linkedin.com/oauth/v2/accessToken",
        scopes=("openid", "profile", "w_member_social"),
        client_id_env="LINKEDIN_CLIENT_ID",
        client_secret_env="LINKEDIN_CLIENT_SECRET",
    )

    def __init__(self, poll_interval_ms: float = 5000, poll_timeout_ms: float = 10 * 60_000):
        self.poll_interval_ms = poll_interval_ms
        self.poll_timeout_ms = poll_timeout_ms

    async def fetch_profile(self, token: dict[str, Any], client: httpx.AsyncClient) -> Profile:
        me = await self.get_json(client, "https://api.linkedin.com/v2/userinfo", token["access_token"])
        # Posting uses the person URN as author.
        return Profile(me["sub"], me["name"], {"authorUrn": f"urn:li:person:{me['sub']}"})

    def _headers(self, token: str) -> dict[str, str]:
        return {
            **bearer(token),
            "LinkedIn-Version": os.environ.get("LINKEDIN_API_VERSION") or "202509",
            "X-Restli-Protocol-Version": "2.0.0",
            "Content-Type": "application/json",
        }

    async def do_publish(self, req: PublishRequest, ctx: PublishContext, validation: ValidationResult) -> DoPublishResult:
        client = ctx.client
        token = ctx.account.access_token
        owner = (ctx.account.metadata or {}).get("authorUrn") or f"urn:li:person:{ctx.account.external_id}"
        p = self.display_name
        warnings: list[str] = []
        size = os.path.getsize(req.media_path)

        cp = req.checkpoint if isinstance(req.checkpoint, dict) else None
        if not cp:
            init = await request_json(
                client, "POST", f"{API}/videos?action=initializeUpload", platform=p, headers=self._headers(token),
                json={"initializeUploadRequest": {"owner": owner, "fileSizeBytes": size, "uploadCaptions": False, "uploadThumbnail": bool(req.thumbnail)}},
            )
            v = init["value"]
            cp = {
                "video": v["video"],
                "uploadToken": v.get("uploadToken") or "",
                "instructions": v["uploadInstructions"],
                "etags": [None] * len(v["uploadInstructions"]),
                "finalized": False,
            }
            ctx.checkpoint(cp)
            if req.thumbnail and v.get("thumbnailUploadUrl"):
                try:
                    with open(req.thumbnail.path, "rb") as fh:
                        thumb = fh.read()
                    await request(
                        client, "PUT", v["thumbnailUploadUrl"], platform=p,
                        headers={**bearer(token), "Content-Type": req.thumbnail.mime_type}, content=thumb,
                    )
                except Exception as err:  # noqa: BLE001 — thumbnail failure is only a warning
                    warnings.append(f"Thumbnail upload failed: {err}")

        for i, part in enumerate(cp["instructions"]):
            if cp["finalized"]:
                break
            if cp["etags"][i]:
                continue
            chunk = read_file_chunk(req.media_path, part["firstByte"], part["lastByte"] - part["firstByte"] + 1)
            res = await request(
                client, "PUT", part["uploadUrl"], platform=p,
                headers={**bearer(token), "Content-Type": "application/octet-stream"}, content=chunk,
            )
            etag = res.headers.get("etag")
            if not etag:
                raise AdapterError("upstream_error", "LinkedIn upload part returned no ETag", True)
            etags = list(cp["etags"])
            etags[i] = etag
            cp = {**cp, "etags": etags}
            ctx.checkpoint(cp)
            ctx.progress("uploading", (part["lastByte"] + 1) / size)

        if not cp["finalized"]:
            await request(
                client, "POST", f"{API}/videos?action=finalizeUpload", platform=p, headers=self._headers(token),
                json={"finalizeUploadRequest": {"video": cp["video"], "uploadToken": cp["uploadToken"], "uploadedPartIds": cp["etags"]}},
            )
            cp = {**cp, "finalized": True}
            ctx.checkpoint(cp)

        ctx.progress("processing")
        video = cp["video"]

        async def check() -> dict[str, Any] | None:
            st = await request_json(client, "GET", f"{API}/videos/{quote(video, safe='')}", platform=p, headers=self._headers(token))
            if st.get("status") == "PROCESSING_FAILED":
                ctx.checkpoint(None)
                raise AdapterError("upstream_error", "LinkedIn could not process the video")
            return st if st.get("status") == "AVAILABLE" else None

        await poll_until(check, interval_ms=self.poll_interval_ms, timeout_ms=self.poll_timeout_ms, platform=p)

        media: dict[str, Any] = {"id": video}
        if validation.effective.title:
            media = {"title": validation.effective.title, "id": video}
        res = await request(
            client, "POST", f"{API}/posts", platform=p, headers=self._headers(token),
            json={
                "author": owner,
                "commentary": validation.effective.caption,
                "visibility": "PUBLIC" if req.visibility == "public" else "CONNECTIONS",
                "distribution": {"feedDistribution": "MAIN_FEED", "targetEntities": [], "thirdPartyDistributionChannels": []},
                "content": {"media": media},
                "lifecycleState": "PUBLISHED",
                "isReshareDisabledByAuthor": False,
            },
        )
        ctx.checkpoint(None)
        if req.visibility == "unlisted":
            warnings.append("LinkedIn has no unlisted posts; shared with connections only.")
        urn = res.headers.get("x-restli-id")
        return DoPublishResult(f"https://www.linkedin.com/feed/update/{urn}" if urn else None, urn or video, warnings)
