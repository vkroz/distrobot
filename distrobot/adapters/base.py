"""Shared adapter behaviour: rule-based validation, dry-run, generic OAuth2 code flow + refresh.
Subclasses provide ``fetch_profile`` and ``do_publish``."""

from __future__ import annotations

import asyncio
import re
from dataclasses import asdict, dataclass, field
from datetime import timedelta
from typing import Any, ClassVar

import httpx

from ..models import ConnectedAccount, MediaInfo, TargetContent, iso, now_utc
from ..platforms.rules import PlatformRules, RuleOverrides, get_rules
from ..platforms.validate import ValidationResult, validate_for_platform
from . import oauth
from .http import make_client
from .types import (
    AccountCredentials,
    AdapterError,
    Capabilities,
    DoPublishResult,
    PublishContext,
    PublishRequest,
    PublishResult,
    RefreshedTokens,
)

DEFAULT_DRY_RUN_DELAY_MS = 1500


@dataclass
class Profile:
    external_id: str
    display_name: str
    metadata: dict[str, Any] = field(default_factory=dict)


class BaseAdapter:
    platform: ClassVar[str]
    oauth_config: ClassVar[oauth.OAuthConfig]
    #: Optional features: native_scheduling, thumbnail, refresh_tokens.
    features: ClassVar[dict[str, bool]] = {}

    @property
    def display_name(self) -> str:
        return get_rules(self.platform).display_name

    @property
    def capabilities(self) -> Capabilities:
        return Capabilities(
            pkce=self.oauth_config.pkce,
            refresh_tokens=self.features.get("refresh_tokens", True),
            publish=type(self).do_publish is not BaseAdapter.do_publish,
            native_scheduling=self.features.get("native_scheduling", False),
            thumbnail=self.features.get("thumbnail", False),
        )

    @property
    def credential_env_vars(self) -> list[str]:
        return [self.oauth_config.client_id_env, self.oauth_config.client_secret_env]

    def is_configured(self) -> bool:
        return oauth.read_client_credentials(self.oauth_config) is not None

    def rule_overrides(self, account: ConnectedAccount | None = None) -> RuleOverrides | None:
        """Override to adjust limits from account metadata."""
        return None

    def get_rules(self, account: ConnectedAccount | None = None) -> PlatformRules:
        return get_rules(self.platform, self.rule_overrides(account))

    def validate(
        self,
        content: TargetContent,
        media: MediaInfo | None = None,
        account: ConnectedAccount | None = None,
        settings: dict[str, Any] | None = None,
    ) -> ValidationResult:
        return validate_for_platform(self.platform, content, media, overrides=self.rule_overrides(account), settings=settings)

    async def publish(self, req: PublishRequest, ctx: PublishContext) -> PublishResult:
        validation = self.validate(req.content, req.media, ctx.account, req.settings)
        if not validation.ok:
            raise AdapterError("validation_failed", " ".join(e.message for e in validation.errors), False, validation.errors)
        warnings = [w.message for w in validation.warnings]
        payload = {
            **asdict(validation.effective),
            "visibility": req.visibility,
            "scheduledAt": req.scheduled_at,
            "thumbnail": bool(req.thumbnail) and self.capabilities.thumbnail,
        }
        if ctx.dry_run:
            await self._simulate_upload(ctx)
            return PublishResult(
                url=f"/dry-run/{req.job_id}", external_id=f"dry-run-{req.job_id}", dry_run=True, payload=payload, warnings=warnings
            )
        if not ctx.account:
            raise AdapterError("no_account", f"No {self.display_name} account connected.")
        async with _client_scope(ctx.client) as client:
            ctx.client = client
            result = await self.do_publish(req, ctx, validation)
        return PublishResult(
            url=result.url,
            external_id=result.external_id,
            dry_run=False,
            payload={**payload, **result.extra},
            warnings=warnings + list(result.warnings),
        )

    async def _simulate_upload(self, ctx: PublishContext) -> None:
        total = DEFAULT_DRY_RUN_DELAY_MS if ctx.simulated_delay_ms is None else ctx.simulated_delay_ms
        steps = 4
        for i in range(1, steps + 1):
            if total > 0:
                await asyncio.sleep(total / steps / 1000)
            ctx.progress("uploading", i / steps)

    async def do_publish(self, req: PublishRequest, ctx: PublishContext, validation: ValidationResult) -> DoPublishResult:
        """Real upload. Override per platform. ``ctx.account`` is guaranteed to be set."""
        raise AdapterError("not_implemented", f"Publishing to {self.display_name} is not implemented yet.")

    # -- OAuth -------------------------------------------------------------------------------

    def get_auth_url(self, *, state: str, redirect_uri: str, code_challenge: str | None = None) -> str:
        creds = oauth.read_client_credentials(self.oauth_config)
        if not creds:
            raise AdapterError("not_configured", f"{self.display_name} OAuth is not configured ({self.oauth_config.client_id_env}).")
        if self.oauth_config.pkce and not code_challenge:
            raise AdapterError("auth_failed", f"{self.display_name} requires a PKCE code challenge.")
        return oauth.build_auth_url(self.oauth_config, creds[0], state=state, redirect_uri=redirect_uri, code_challenge=code_challenge)

    async def handle_callback(
        self, *, code: str, redirect_uri: str, code_verifier: str | None = None, client: httpx.AsyncClient | None = None
    ) -> AccountCredentials:
        creds = oauth.read_client_credentials(self.oauth_config)
        if not creds:
            raise AdapterError("not_configured", f"{self.display_name} OAuth is not configured.")
        if self.oauth_config.pkce and not code_verifier:
            raise AdapterError("auth_failed", f"{self.display_name} requires a PKCE code verifier.")
        async with _client_scope(client) as c:
            try:
                token = await oauth.exchange_code(
                    self.oauth_config, creds, code=code, redirect_uri=redirect_uri, code_verifier=code_verifier, client=c
                )
            except (RuntimeError, ValueError, httpx.HTTPError) as err:
                raise AdapterError("auth_failed", str(err)) from err
            profile = await self.fetch_profile(token, c)
        scope = token.get("scope")
        return AccountCredentials(
            platform=self.platform,
            external_id=profile.external_id,
            display_name=profile.display_name,
            access_token=token["access_token"],
            refresh_token=token.get("refresh_token"),
            expires_at=_expires_at(token.get("expires_in")),
            scopes=[s for s in re.split(r"[\s,]+", scope) if s] if isinstance(scope, str) and scope else list(self.oauth_config.scopes),
            metadata=profile.metadata,
        )

    async def refresh_access_token(self, account: ConnectedAccount, client: httpx.AsyncClient | None = None) -> RefreshedTokens:
        """Standard OAuth2 refresh_token grant. Override for platforms with non-standard refresh."""
        creds = oauth.read_client_credentials(self.oauth_config)
        if not creds:
            raise AdapterError("not_configured", f"{self.display_name} OAuth is not configured.")
        if not account.refresh_token:
            raise AdapterError("auth_failed", f"{self.display_name} account has no refresh token; reconnect it.")
        async with _client_scope(client) as c:
            try:
                token = await oauth.refresh_token(self.oauth_config, creds, account.refresh_token, c)
            except (RuntimeError, ValueError, httpx.HTTPError) as err:
                raise AdapterError("auth_failed", f"Token refresh failed: {err}") from err
        return RefreshedTokens(
            access_token=token["access_token"],
            # Many providers (Google) omit the refresh token on refresh: keep the old one.
            refresh_token=token.get("refresh_token") or account.refresh_token,
            expires_at=_expires_at(token.get("expires_in")),
        )

    async def fetch_profile(self, token: dict[str, Any], client: httpx.AsyncClient) -> Profile:
        """Identify the connected account using the fresh token."""
        raise NotImplementedError

    async def get_json(self, client: httpx.AsyncClient, url: str, access_token: str) -> Any:
        try:
            res = await client.get(url, headers={"Authorization": f"Bearer {access_token}", "Accept": "application/json"})
        except httpx.HTTPError as err:
            raise AdapterError("upstream_error", f"{self.display_name} network error: {err}", True) from err
        if not res.is_success:
            status = res.status_code
            code = "rate_limited" if status == 429 else "auth_failed" if status == 401 else "upstream_error"
            raise AdapterError(code, f"{self.display_name} API {status}: {res.text[:300]}", status == 429 or status >= 500)
        return res.json()


def _expires_at(expires_in: Any) -> str | None:
    if isinstance(expires_in, (int, float)) and expires_in:
        return iso(now_utc() + timedelta(seconds=expires_in))
    return None


class _client_scope:
    """Use the given client, or create (and close) a temporary one."""

    def __init__(self, client: httpx.AsyncClient | None):
        self.given = client
        self.owned: httpx.AsyncClient | None = None

    async def __aenter__(self) -> httpx.AsyncClient:
        if self.given is not None:
            return self.given
        self.owned = make_client()
        return self.owned

    async def __aexit__(self, *exc: Any) -> None:
        if self.owned is not None:
            await self.owned.aclose()


client_scope = _client_scope
