"""TikTok Content Posting API — Direct Post (FILE_UPLOAD).

  1. POST /v2/post/publish/creator_info/query/ → privacy options, interaction limits, max duration
     (the same call backs the compose screen's creator info via ``query_creator_info``)
  2. POST /v2/post/publish/video/init/          → publish_id, upload_url
  3. PUT upload_url (Content-Range per chunk)
  4. POST /v2/post/publish/status/fetch/        → poll until PUBLISH_COMPLETE
Docs: https://developers.tiktok.com/doc/content-posting-api-reference-direct-post
Privacy level, interaction toggles and commercial disclosure come from the user's explicit choices in
``settings`` (see platforms/tiktok.py) — TikTok requires no defaults.
Shapes follow the public docs but are unverified against the live API.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from ...models import ConnectedAccount
from ...platforms.rules import RuleOverrides
from ...platforms.tiktok import (
    TIKTOK_PRIVACY_LABELS,
    TikTokCreatorInfo,
    normalize_creator_info,
    parse_tiktok_settings,
    tiktok_post_info,
    validate_tiktok_settings,
)
from ...platforms.validate import ValidationResult
from ..base import BaseAdapter, Profile, client_scope
from ..http import bearer, poll_until, read_file_chunk, request, request_json
from ..oauth import OAuthConfig
from ..types import AdapterError, DoPublishResult, PublishContext, PublishRequest

API = "https://open.tiktokapis.com"
MB = 1024 * 1024


def tiktok_chunks(size: int, chunk_size: int = 10 * MB, min_chunk_size: int = 5 * MB) -> tuple[int, int]:
    """Split ``size`` into TikTok-compliant chunks: equal chunks, the last one absorbing the remainder.
    Returns (chunk_size, count)."""
    if size <= max(min_chunk_size, chunk_size):
        return size, 1
    return chunk_size, size // chunk_size


class TikTokAdapter(BaseAdapter):
    platform = "tiktok"
    oauth_config = OAuthConfig(
        authorize_url="https://www.tiktok.com/v2/auth/authorize/",
        token_url="https://open.tiktokapis.com/v2/oauth/token/",
        scopes=("user.info.basic", "video.upload", "video.publish"),
        scope_separator=",",
        client_id_env="TIKTOK_CLIENT_KEY",
        client_secret_env="TIKTOK_CLIENT_SECRET",
        client_id_param="client_key",
    )

    def __init__(
        self,
        chunk_size: int = 10 * MB,
        min_chunk_size: int = 5 * MB,
        poll_interval_ms: float = 5000,
        poll_timeout_ms: float = 10 * 60_000,
    ):
        self.chunk_size = chunk_size
        self.min_chunk_size = min_chunk_size
        self.poll_interval_ms = poll_interval_ms
        self.poll_timeout_ms = poll_timeout_ms

    def rule_overrides(self, account: ConnectedAccount | None = None) -> RuleOverrides | None:
        """creator_info.max_video_post_duration_sec is cached in account metadata at connect/refresh time."""
        mx = (account.metadata or {}).get("maxVideoPostDurationSec") if account else None
        return {"video": {"max_duration_sec": mx}} if isinstance(mx, (int, float)) else None

    async def fetch_profile(self, token: dict[str, Any], client: httpx.AsyncClient) -> Profile:
        data = await self.get_json(
            client, "https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,avatar_url,username", token["access_token"]
        )
        u = data["data"]["user"]
        return Profile(u["open_id"], u["display_name"], {"username": u["username"]} if u.get("username") else {})

    async def _call(self, client: httpx.AsyncClient, path: str, token: str, body: Any) -> Any:
        res = await request_json(
            client, "POST", f"{API}{path}", platform=self.display_name,
            headers={**bearer(token), "Content-Type": "application/json; charset=UTF-8"}, json=body or {},
        )
        err = res.get("error") if isinstance(res, dict) else None
        if err and err.get("code") != "ok":
            code = err.get("code")
            retryable = code in ("rate_limit_exceeded", "internal_error")
            raise AdapterError(
                "auth_failed" if code == "access_token_invalid" else "rate_limited" if retryable else "upstream_error",
                f"TikTok {path}: {code} {err.get('message') or ''}".strip(),
                retryable,
            )
        return res.get("data")

    async def query_creator_info(self, account: ConnectedAccount, client: httpx.AsyncClient | None = None) -> TikTokCreatorInfo:
        """creator_info/query for the compose screen (and pre-publish checks)."""
        async with client_scope(client) as c:
            raw = await self._call(c, "/v2/post/publish/creator_info/query/", account.access_token, {})
        return normalize_creator_info(raw or {})

    async def do_publish(self, req: PublishRequest, ctx: PublishContext, validation: ValidationResult) -> DoPublishResult:
        client = ctx.client
        account = ctx.account
        token = account.access_token
        warnings: list[str] = []
        cp = req.checkpoint if isinstance(req.checkpoint, dict) else None

        if not (cp and cp.get("uploaded")):
            creator = await self.query_creator_info(account, client)
            # Re-check the user's choices against the creator's current constraints (they can change).
            issues = validate_tiktok_settings(req.settings, creator, req.media.duration_sec)
            if issues:
                raise AdapterError("validation_failed", " ".join(i.message for i in issues))
            settings = parse_tiktok_settings(req.settings)
            post_info = tiktok_post_info(settings, creator)

            size = os.path.getsize(req.media_path)
            chunk_size, count = tiktok_chunks(size, self.chunk_size, self.min_chunk_size)
            init = await self._call(
                client,
                "/v2/post/publish/video/init/",
                token,
                {
                    "post_info": {"title": validation.effective.caption, **post_info},
                    "source_info": {"source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk_size, "total_chunk_count": count},
                },
            )
            cp = {"publishId": init["publish_id"], "uploaded": False}
            if creator.username:
                cp["username"] = creator.username
            if settings.privacy_level == "SELF_ONLY":
                warnings.append(f'Posted with TikTok visibility "{TIKTOK_PRIVACY_LABELS["SELF_ONLY"]}".')
            ctx.checkpoint(cp)

            for i in range(count):
                start = i * chunk_size
                end = size - 1 if i == count - 1 else start + chunk_size - 1
                chunk = read_file_chunk(req.media_path, start, end - start + 1)
                await request(
                    client, "PUT", init["upload_url"], platform=self.display_name,
                    headers={
                        "Content-Type": req.media.mime_type or "video/mp4",
                        "Content-Length": str(len(chunk)),
                        "Content-Range": f"bytes {start}-{end}/{size}",
                    },
                    content=chunk,
                )
                ctx.progress("uploading", (end + 1) / size)
            cp = {**cp, "uploaded": True}
            ctx.checkpoint(cp)

        ctx.progress("processing")
        publish_id = cp["publishId"]

        async def check() -> dict[str, Any] | None:
            st = await self._call(client, "/v2/post/publish/status/fetch/", token, {"publish_id": publish_id})
            if st.get("status") == "FAILED":
                ctx.checkpoint(None)
                raise AdapterError("upstream_error", f"TikTok rejected the post: {st.get('fail_reason') or 'unknown reason'}")
            return st if st.get("status") == "PUBLISH_COMPLETE" else None

        status = await poll_until(check, interval_ms=self.poll_interval_ms, timeout_ms=self.poll_timeout_ms, platform=self.display_name)

        ids = status.get("publicaly_available_post_id") or []
        post_id = ids[0] if ids else None
        username = cp.get("username") or (account.metadata or {}).get("username")
        if post_id and username:
            return DoPublishResult(f"https://www.tiktok.com/@{username}/video/{post_id}", str(post_id), warnings)
        warnings.append("TikTok did not return a public post id yet (the post may be private or under review).")
        return DoPublishResult(f"https://www.tiktok.com/@{username}" if username else "https://www.tiktok.com/", publish_id, warnings)
