"""Adapter registry."""

from __future__ import annotations

from .base import BaseAdapter, Profile
from .oauth import create_pkce_pair, create_state
from .platforms.facebook import FacebookAdapter
from .platforms.instagram import InstagramAdapter
from .platforms.linkedin import LinkedInAdapter
from .platforms.tiktok import TikTokAdapter
from .platforms.vimeo import VimeoAdapter
from .platforms.x import XAdapter
from .platforms.youtube import YouTubeAdapter
from .types import AdapterError, PublishContext, PublishRequest, PublishResult

__all__ = [
    "AdapterError",
    "BaseAdapter",
    "Profile",
    "PublishContext",
    "PublishRequest",
    "PublishResult",
    "create_pkce_pair",
    "create_state",
    "get_adapter",
    "list_adapters",
    "register_adapter",
    "reset_adapters",
]


def _default_adapters() -> dict[str, BaseAdapter]:
    return {
        "youtube": YouTubeAdapter(),
        "tiktok": TikTokAdapter(),
        "instagram": InstagramAdapter(),
        "x": XAdapter(),
        "facebook": FacebookAdapter(),
        "linkedin": LinkedInAdapter(),
        "vimeo": VimeoAdapter(),
    }


_registry = _default_adapters()


def get_adapter(platform: str) -> BaseAdapter:
    return _registry[platform]


def list_adapters() -> list[BaseAdapter]:
    return list(_registry.values())


def register_adapter(adapter: BaseAdapter) -> None:
    """Swap an adapter (tests, mocks, alternate implementations)."""
    _registry[adapter.platform] = adapter


def reset_adapters() -> None:
    _registry.clear()
    _registry.update(_default_adapters())
