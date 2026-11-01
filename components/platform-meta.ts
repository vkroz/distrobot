import type { PlatformId } from "@/lib/types";

/** Presentation-only platform metadata (colors must be literal class strings for Tailwind). */
export const PLATFORM_META: Record<PlatformId, { short: string; dot: string; chip: string }> = {
  youtube: { short: "YT", dot: "bg-red-600", chip: "bg-red-600 text-white" },
  tiktok: { short: "TT", dot: "bg-neutral-900 dark:bg-white", chip: "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900" },
  instagram: { short: "IG", dot: "bg-pink-500", chip: "bg-gradient-to-br from-amber-400 via-pink-500 to-purple-600 text-white" },
  x: { short: "X", dot: "bg-neutral-700", chip: "bg-black text-white dark:bg-neutral-200 dark:text-black" },
  facebook: { short: "FB", dot: "bg-blue-600", chip: "bg-blue-600 text-white" },
  linkedin: { short: "in", dot: "bg-sky-700", chip: "bg-sky-700 text-white" },
  vimeo: { short: "V", dot: "bg-cyan-500", chip: "bg-cyan-500 text-white" },
};
