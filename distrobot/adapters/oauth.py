"""Generic OAuth2 authorization-code flow with optional PKCE."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl

import httpx


@dataclass(frozen=True)
class OAuthConfig:
    authorize_url: str
    token_url: str
    scopes: tuple[str, ...]
    client_id_env: str
    client_secret_env: str
    scope_separator: str = " "
    #: Query/body param name for the client id (TikTok uses ``client_key``).
    client_id_param: str = "client_id"
    #: How client credentials are sent to the token endpoint: "body" or "basic".
    token_auth: str = "body"
    pkce: bool = False
    extra_auth_params: dict[str, str] = field(default_factory=dict)


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def create_pkce_pair() -> tuple[str, str]:
    """Returns (verifier, S256 challenge)."""
    verifier = _b64url(secrets.token_bytes(32))
    return verifier, _b64url(hashlib.sha256(verifier.encode()).digest())


def create_state() -> str:
    return _b64url(secrets.token_bytes(16))


def read_client_credentials(cfg: OAuthConfig) -> tuple[str, str] | None:
    cid = os.environ.get(cfg.client_id_env)
    secret = os.environ.get(cfg.client_secret_env)
    return (cid, secret) if cid and secret else None


def build_auth_url(cfg: OAuthConfig, client_id: str, *, state: str, redirect_uri: str, code_challenge: str | None = None) -> str:
    parts = urlsplit(cfg.authorize_url)
    params = dict(parse_qsl(parts.query))
    params.update(
        {
            cfg.client_id_param: client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri,
            "scope": cfg.scope_separator.join(cfg.scopes),
            "state": state,
        }
    )
    if code_challenge:
        params["code_challenge"] = code_challenge
        params["code_challenge_method"] = "S256"
    params.update(cfg.extra_auth_params)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(params), parts.fragment))


async def _token_request(cfg: OAuthConfig, creds: tuple[str, str], body: dict[str, str], client: httpx.AsyncClient) -> dict[str, Any]:
    client_id, client_secret = creds
    headers = {"Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"}
    body = dict(body)
    if cfg.token_auth == "basic":
        headers["Authorization"] = "Basic " + base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        # Some providers (X) still want client_id in the body.
        body[cfg.client_id_param] = client_id
    else:
        body[cfg.client_id_param] = client_id
        body["client_secret"] = client_secret
    res = await client.post(cfg.token_url, headers=headers, content=urlencode(body))
    if not res.is_success:
        raise RuntimeError(f"Token request failed ({res.status_code}): {res.text[:500]}")
    data = json.loads(res.text)
    # Some providers nest the token under `data`.
    token = data if data.get("access_token") else data.get("data")
    if not isinstance(token, dict) or not token.get("access_token"):
        raise RuntimeError("Token response missing access_token")
    return token


async def exchange_code(
    cfg: OAuthConfig, creds: tuple[str, str], *, code: str, redirect_uri: str, code_verifier: str | None, client: httpx.AsyncClient
) -> dict[str, Any]:
    body = {"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri}
    if code_verifier:
        body["code_verifier"] = code_verifier
    return await _token_request(cfg, creds, body, client)


async def refresh_token(cfg: OAuthConfig, creds: tuple[str, str], refresh: str, client: httpx.AsyncClient) -> dict[str, Any]:
    return await _token_request(cfg, creds, {"grant_type": "refresh_token", "refresh_token": refresh}, client)
