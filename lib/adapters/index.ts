import type { PlatformId } from "@/lib/types";
import type { PlatformAdapter } from "./types";
import { YouTubeAdapter } from "./platforms/youtube";
import { TikTokAdapter } from "./platforms/tiktok";
import { InstagramAdapter } from "./platforms/instagram";
import { XAdapter } from "./platforms/x";
import { FacebookAdapter } from "./platforms/facebook";
import { LinkedInAdapter } from "./platforms/linkedin";
import { VimeoAdapter } from "./platforms/vimeo";

export * from "./types";
export { BaseAdapter } from "./base";
export { createPkcePair, createState } from "./oauth";

function defaultAdapters(): Record<PlatformId, PlatformAdapter> {
  return {
    youtube: new YouTubeAdapter(),
    tiktok: new TikTokAdapter(),
    instagram: new InstagramAdapter(),
    x: new XAdapter(),
    facebook: new FacebookAdapter(),
    linkedin: new LinkedInAdapter(),
    vimeo: new VimeoAdapter(),
  };
}

let registry = defaultAdapters();

export function getAdapter(platform: PlatformId): PlatformAdapter {
  return registry[platform];
}

export function listAdapters(): PlatformAdapter[] {
  return Object.values(registry);
}

/** Swap an adapter (tests, mocks, alternate implementations). */
export function registerAdapter(adapter: PlatformAdapter): void {
  registry = { ...registry, [adapter.platform]: adapter };
}

export function resetAdapters(): void {
  registry = defaultAdapters();
}
