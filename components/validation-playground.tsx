"use client";

import { useMemo, useState } from "react";
import { PLATFORM_RULES } from "@/lib/platforms/rules";
import { applyTextAdaptations, validateForPlatform, type ValidationResult } from "@/lib/platforms/validate";
import { PLATFORM_IDS, type MediaInfo, type PlatformId, type TargetContent } from "@/lib/types";

const SEVERITY_STYLE = {
  error: "text-red-600 dark:text-red-400",
  warning: "text-amber-600 dark:text-amber-400",
  info: "text-neutral-500",
} as const;

function num(v: string): number | undefined {
  const n = Number(v);
  return v.trim() && Number.isFinite(n) ? n : undefined;
}

export function ValidationPlayground() {
  const [title, setTitle] = useState("My trip to Lisbon");
  const [caption, setCaption] = useState("Three days of tiles, trams and pastéis de nata. Full guide in the description!");
  const [hashtags, setHashtags] = useState("travel lisbon portugal");
  const [duration, setDuration] = useState("75");
  const [width, setWidth] = useState("1920");
  const [height, setHeight] = useState("1080");
  const [sizeMb, setSizeMb] = useState("120");
  const [overrides, setOverrides] = useState<Partial<Record<PlatformId, TargetContent>>>({});

  const base: TargetContent = { title, caption, hashtags: hashtags.split(/[\s,]+/).filter(Boolean) };
  const media: MediaInfo = {
    mimeType: "video/mp4",
    durationSec: num(duration),
    width: num(width),
    height: num(height),
    sizeBytes: num(sizeMb) !== undefined ? num(sizeMb)! * 1024 * 1024 : undefined,
  };

  const results = useMemo(
    () => PLATFORM_IDS.map((p) => validateForPlatform({ platform: p, content: overrides[p] ?? base, media })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [title, caption, hashtags, duration, width, height, sizeMb, overrides],
  );

  const input = "w-full rounded border border-neutral-300 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900";

  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-[22rem_1fr]">
      <div className="space-y-3">
        <label className="block text-sm">Title<input className={input} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="block text-sm">Caption<textarea className={input} rows={5} value={caption} onChange={(e) => setCaption(e.target.value)} /></label>
        <label className="block text-sm">Hashtags<input className={input} value={hashtags} onChange={(e) => setHashtags(e.target.value)} /></label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-sm">Duration (s)<input className={input} value={duration} onChange={(e) => setDuration(e.target.value)} /></label>
          <label className="block text-sm">Size (MB)<input className={input} value={sizeMb} onChange={(e) => setSizeMb(e.target.value)} /></label>
          <label className="block text-sm">Width<input className={input} value={width} onChange={(e) => setWidth(e.target.value)} /></label>
          <label className="block text-sm">Height<input className={input} value={height} onChange={(e) => setHeight(e.target.value)} /></label>
        </div>
        {Object.keys(overrides).length > 0 && (
          <button className="text-sm text-blue-600 hover:underline" onClick={() => setOverrides({})}>Reset per-platform fixes</button>
        )}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {results.map((r) => (
          <ResultCard
            key={r.platform}
            result={r}
            overridden={!!overrides[r.platform]}
            onApply={() =>
              setOverrides((o) => ({ ...o, [r.platform]: applyTextAdaptations(o[r.platform] ?? base, r.adaptations) }))
            }
          />
        ))}
      </div>
    </div>
  );
}

function ResultCard({ result: r, overridden, onApply }: { result: ValidationResult; overridden: boolean; onApply: () => void }) {
  const issues = [...r.errors, ...r.warnings, ...r.infos];
  const hasAutomatic = r.adaptations.some((a) => a.automatic);
  return (
    <div className="rounded-lg border border-neutral-200 p-3 text-sm dark:border-neutral-800">
      <div className="flex items-center justify-between">
        <span className="font-medium">{PLATFORM_RULES[r.platform].displayName}</span>
        <span className={r.ok ? "text-green-600" : "text-red-600"}>{r.ok ? "Ready" : `${r.errors.length} error(s)`}</span>
      </div>
      {overridden && <p className="text-xs text-blue-600">Using adapted text</p>}
      <ul className="mt-2 space-y-1">
        {issues.map((i, idx) => (
          <li key={idx} className={SEVERITY_STYLE[i.severity]}>• {i.message}</li>
        ))}
      </ul>
      {r.adaptations.length > 0 && (
        <div className="mt-2 border-t border-neutral-200 pt-2 dark:border-neutral-800">
          <p className="text-xs uppercase text-neutral-500">Suggested</p>
          <ul className="mt-1 space-y-1">
            {r.adaptations.map((a, idx) => (
              <li key={idx}>
                {a.description}
                {!a.automatic && <span className="text-xs text-neutral-400"> (needs video processing)</span>}
              </li>
            ))}
          </ul>
          {hasAutomatic && (
            <button className="mt-2 rounded bg-neutral-900 px-2 py-1 text-xs text-white dark:bg-neutral-100 dark:text-neutral-900" onClick={onApply}>
              Apply text fixes
            </button>
          )}
        </div>
      )}
    </div>
  );
}
