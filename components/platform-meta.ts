import type { PlatformId } from "@/lib/types";

/** Presentation-only platform metadata (colors must be literal class strings for Tailwind). */
export const PLATFORM_META: Record<PlatformId, { short: string; dot: string; chip: string; env: string[] }> = {
  youtube: { short: "YT", dot: "bg-red-600", chip: "bg-red-600 text-white", env: ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"] },
  tiktok: { short: "TT", dot: "bg-neutral-900 dark:bg-white", chip: "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900", env: ["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"] },
  instagram: { short: "IG", dot: "bg-pink-500", chip: "bg-gradient-to-br from-amber-400 via-pink-500 to-purple-600 text-white", env: ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"] },
  x: { short: "X", dot: "bg-neutral-700", chip: "bg-black text-white dark:bg-neutral-200 dark:text-black", env: ["X_CLIENT_ID", "X_CLIENT_SECRET"] },
  facebook: { short: "FB", dot: "bg-blue-600", chip: "bg-blue-600 text-white", env: ["FACEBOOK_APP_ID", "FACEBOOK_APP_SECRET"] },
  linkedin: { short: "in", dot: "bg-sky-700", chip: "bg-sky-700 text-white", env: ["LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"] },
  vimeo: { short: "V", dot: "bg-cyan-500", chip: "bg-cyan-500 text-white", env: ["VIMEO_CLIENT_ID", "VIMEO_CLIENT_SECRET"] },
};
