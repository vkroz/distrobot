"""X API v2 — chunked media upload, then create a post.

  1. POST /2/media/upload/initialize {media_type, total_bytes, media_category:"tweet_video"} → id
  2. POST /2/media/upload/{id}/append (multipart: media, segment_index) per chunk
  3. POST /2/media/upload/{id}/finalize → processing_info
  4. GET  /2/media/upload?command=STATUS&media_id=… until succeeded (honors check_after_secs)
  5. POST /2/tweets {text, media:{media_ids:[id]}}
Docs: https://docs.x.com/x-api/media/upload-media
Shapes follow the public docs but are unverified against the live API.
"""

from __future__ import annotations

import math
import os
import time
from typing import Any
from urllib.parse import quote

import httpx

from ...models import ConnectedAccount
from ...platforms.rules import RuleOverrides
from ...platforms.validate import ValidationResult
from ..base import BaseAdapter, Profile
from ..http import bearer, read_file_chunk, request, request_json, sleep_ms
from ..oauth import OAuthConfig
from ..types import AdapterError, DoPublishResult, PublishContext, PublishRequest

API = "https://api.x.com/2"
MB = 1024 * 1024


class XAdapter(BaseAdapter):
    platform = "x"
    oauth_config = OAuthConfig(
        authorize_url="https://x.com/i/oauth2/authorize",
        token_url="https://api.x.com/2/oauth2/token",
        scopes=("tweet.read", "tweet.write", "users.read", "media.write", "offline.access"),
        client_id_env="X_CLIENT_ID",
        client_secret_env="X_CLIENT_SECRET",
        token_auth="basic",
        pkce=True,
    )

    def __init__(self, chunk_size: int = 4 * MB, poll_interval_ms: float | None = None, poll_timeout_ms: float = 10 * 60_000):
        """``chunk_size``: APPEND segment size (max 5 MB). ``poll_interval_ms``: fixed poll interval
        (default: the API's check_after_secs)."""
        self.chunk_size = chunk_size
        self.poll_interval_ms = poll_interval_ms
        self.poll_timeout_ms = poll_timeout_ms

    def rule_overrides(self, account: ConnectedAccount | None = None) -> RuleOverrides | None:
        """Premium subscribers get long posts and longer videos."""
        if not account or (account.metadata or {}).get("premium") is not True:
            return None
        return {"caption": {"max_length": 25_000}, "video": {"max_duration_sec": 3 * 60 * 60}}

    async def fetch_profile(self, token: dict[str, Any], client: httpx.AsyncClient) -> Profile:
        me = await self.get_json(client, "https://api.x.com/2/users/me", token["access_token"])
        d = me["data"]
        return Profile(d["id"], f"@{d['username']}", {"name": d["name"]})

    async def _json(self, client: httpx.AsyncClient, url: str, token: str, body: Any) -> Any:
        return await request_json(
            client, "POST", url, platform=self.display_name, headers={**bearer(token), "Content-Type": "application/json"}, json=body
        )

    async def do_publish(self, req: PublishRequest, ctx: PublishContext, validation: ValidationResult) -> DoPublishResult:
        client = ctx.client
        token = ctx.account.access_token
        size = os.path.getsize(req.media_path)
        chunk_size = self.chunk_size
        segments = max(1, math.ceil(size / chunk_size))
        cp = req.checkpoint if isinstance(req.checkpoint, dict) else None

        if not cp:
            init = await self._json(
                client, f"{API}/media/upload/initialize", token,
                {"media_type": req.media.mime_type or "video/mp4", "total_bytes": size, "media_category": "tweet_video"},
            )
            cp = {"mediaId": init["data"]["id"], "nextSegment": 0, "finalized": False}
            ctx.checkpoint(cp)
        media_id = cp["mediaId"]

        i = cp["nextSegment"]
        while i < segments and not cp["finalized"]:
            chunk = read_file_chunk(req.media_path, i * chunk_size, chunk_size)
            await request(
                client, "POST", f"{API}/media/upload/{media_id}/append", platform=self.display_name,
                headers=bearer(token), data={"segment_index": str(i)}, files={"media": ("chunk", chunk, "application/octet-stream")},
            )
            cp = {**cp, "nextSegment": i + 1}
            ctx.checkpoint(cp)
            ctx.progress("uploading", min(1, ((i + 1) * chunk_size) / size))
            i += 1

        if not cp["finalized"]:
            fin = await self._json(client, f"{API}/media/upload/{media_id}/finalize", token, {})
            info = fin["data"].get("processing_info")
            cp = {**cp, "finalized": True}
            ctx.checkpoint(cp)
        else:
            info = {"state": "pending"}

        ctx.progress("processing")
        deadline = time.monotonic() + self.poll_timeout_ms / 1000
        while info and info.get("state") != "succeeded":
            if info.get("state") == "failed":
                ctx.checkpoint(None)
                msg = (info.get("error") or {}).get("message") or "failed"
                raise AdapterError("upstream_error", f"X could not process the video: {msg}")
            if time.monotonic() > deadline:
                raise AdapterError("upstream_error", "X media processing timed out", True)
            await sleep_ms(self.poll_interval_ms if self.poll_interval_ms is not None else (info.get("check_after_secs") or 5) * 1000)
            st = await request_json(
                client, "GET", f"{API}/media/upload?command=STATUS&media_id={quote(media_id, safe='')}",
                platform=self.display_name, headers=bearer(token),
            )
            info = st["data"].get("processing_info")

        tweet = await self._json(client, f"{API}/tweets", token, {"text": validation.effective.caption, "media": {"media_ids": [media_id]}})
        ctx.checkpoint(None)
        tid = tweet["data"]["id"]
        username = ctx.account.display_name.lstrip("@")
        url = f"https://x.com/{username}/status/{tid}" if username else f"https://x.com/i/web/status/{tid}"
        return DoPublishResult(url, tid)
