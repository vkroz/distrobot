"""Vimeo — tus resumable upload.

  1. POST /me/videos {upload:{approach:"tus", size}, name, description, privacy} → uri, link, upload.upload_link
  2. PATCH upload_link per chunk (Tus-Resumable, Upload-Offset); resume via HEAD → Upload-Offset
  3. PUT /videos/{id}/tags [{name}]
Docs: https://developer.vimeo.com/api/upload/videos
Shapes follow the public docs but are unverified against the live API.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from ...models import ConnectedAccount
from ...platforms.rules import RuleOverrides
from ...platforms.validate import ValidationResult
from ..base import BaseAdapter, Profile
from ..http import bearer, read_file_chunk, request, request_json
from ..oauth import OAuthConfig
from ..types import AdapterError, DoPublishResult, PublishContext, PublishRequest

API = "https://api.vimeo.com"
ACCEPT = "application/vnd.vimeo.*+json;version=3.4"
MB = 1024 * 1024
PRIVACY = {"public": "anybody", "unlisted": "unlisted", "private": "nobody"}


class VimeoAdapter(BaseAdapter):
    platform = "vimeo"
    oauth_config = OAuthConfig(
        authorize_url="https://api.vimeo.com/oauth/authorize",
        token_url="https://api.vimeo.com/oauth/access_token",
        scopes=("public", "private", "upload", "edit"),
        client_id_env="VIMEO_CLIENT_ID",
        client_secret_env="VIMEO_CLIENT_SECRET",
        token_auth="basic",
    )

    def __init__(self, chunk_size: int = 64 * MB):
        self.chunk_size = chunk_size

    def rule_overrides(self, account: ConnectedAccount | None = None) -> RuleOverrides | None:
        """Remaining upload quota (from /me upload_quota) is cached in account metadata."""
        free = (account.metadata or {}).get("uploadQuotaFreeBytes") if account else None
        return {"video": {"max_file_size_bytes": free}} if isinstance(free, (int, float)) else None

    async def fetch_profile(self, token: dict[str, Any], client: httpx.AsyncClient) -> Profile:
        me = await self.get_json(client, "https://api.vimeo.com/me", token["access_token"])
        free = ((me.get("upload_quota") or {}).get("space") or {}).get("free")
        return Profile(me["uri"].replace("/users/", ""), me["name"], {"uploadQuotaFreeBytes": free} if isinstance(free, (int, float)) else {})

    async def do_publish(self, req: PublishRequest, ctx: PublishContext, validation: ValidationResult) -> DoPublishResult:
        client = ctx.client
        token = ctx.account.access_token
        p = self.display_name
        size = os.path.getsize(req.media_path)
        warnings: list[str] = []

        cp = req.checkpoint if isinstance(req.checkpoint, dict) else None
        offset = 0
        if cp:
            head = await request(client, "HEAD", cp["uploadLink"], platform=p, headers={"Tus-Resumable": "1.0.0"})
            offset = int(head.headers.get("upload-offset") or 0)
        else:
            created = await request_json(
                client, "POST", f"{API}/me/videos", platform=p,
                headers={**bearer(token), "Content-Type": "application/json", "Accept": ACCEPT},
                json={
                    "upload": {"approach": "tus", "size": str(size)},
                    "name": validation.effective.title if validation.effective.title is not None else req.media.original_filename,
                    "description": validation.effective.caption,
                    "privacy": {"view": PRIVACY[req.visibility]},
                },
            )
            cp = {"uri": created["uri"], "link": created["link"], "uploadLink": created["upload"]["upload_link"]}
            ctx.checkpoint(cp)

        while offset < size:
            chunk = read_file_chunk(req.media_path, offset, min(self.chunk_size, size - offset))
            res = await request(
                client, "PATCH", cp["uploadLink"], platform=p,
                headers={"Tus-Resumable": "1.0.0", "Upload-Offset": str(offset), "Content-Type": "application/offset+octet-stream"},
                content=chunk,
            )
            try:
                nxt = int(res.headers.get("upload-offset", ""))
            except ValueError:
                nxt = -1
            if nxt <= offset:
                raise AdapterError("upstream_error", "Vimeo upload did not advance; will resume on retry", True)
            offset = nxt
            ctx.progress("uploading", offset / size)

        tags = validation.effective.tags
        if tags:
            try:
                await request(
                    client, "PUT", f"{API}{cp['uri']}/tags", platform=p,
                    headers={**bearer(token), "Content-Type": "application/json", "Accept": ACCEPT}, json=[{"name": t} for t in tags],
                )
            except Exception as err:  # noqa: BLE001 — tags are best-effort
                warnings.append(f"Could not set Vimeo tags: {err}")
        ctx.checkpoint(None)
        return DoPublishResult(cp["link"], cp["uri"].replace("/videos/", ""), warnings)
