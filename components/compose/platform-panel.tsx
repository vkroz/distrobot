"use client";

import Link from "next/link";
import { useState } from "react";
import { parseAspectRatio, type PlatformRules } from "@/lib/platforms/rules";
import { countText, extractHashtags } from "@/lib/platforms/text";
import {
  applyTextAdaptations,
  classifyOrientation,
  type Adaptation,
  type ValidationIssue,
  type ValidationResult,
} from "@/lib/platforms/validate";
import type { PlatformStatus } from "@/lib/services/posts";
import type { MediaInfo, TargetContent, Visibility } from "@/lib/types";
import { Badge, PlatformIcon, btn, cx, formatBytes, formatDuration, inputCls } from "../ui";
import { HashtagInput } from "./hashtag-input";

/** Per-platform overrides; null = inherit from the post. */
export interface Override {
  title: string | null;
  caption: string | null;
  hashtags: string[] | null;
}

export const EMPTY_OVERRIDE: Override = { title: null, caption: null, hashtags: null };

const sameTags = (a: string[], b: string[]) => a.length === b.length && a.every((t, i) => t === b[i]);

/** Turn adapted content back into overrides relative to the post defaults. */
export function contentToOverride(next: TargetContent, base: TargetContent): Override {
  return {
    title: next.title === base.title ? null : next.title,
    caption: next.caption === base.caption ? null : next.caption,
    hashtags: sameTags(next.hashtags, base.hashtags) ? null : next.hashtags,
  };
}

export function PlatformStatusBadge({ status }: { status?: PlatformStatus }) {
  if (!status) return <Badge>…</Badge>;
  if (status.dryRun) return <Badge tone="amber">Dry-run</Badge>;
  if (status.accounts.length) return <Badge tone="green">{status.accounts[0].displayName}</Badge>;
  return (
    <Link href="/accounts">
      <Badge tone="red">Not connected</Badge>
    </Link>
  );
}

const SEVERITY: Record<ValidationIssue["severity"], { icon: string; cls: string }> = {
  error: { icon: "✕", cls: "text-red-700 dark:text-red-400" },
  warning: { icon: "!", cls: "text-amber-700 dark:text-amber-400" },
  info: { icon: "i", cls: "text-neutral-500 dark:text-neutral-400" },
};

function IssueList({ result }: { result: ValidationResult }) {
  const issues = [...result.errors, ...result.warnings, ...result.infos];
  if (!issues.length) return <p className="text-xs text-emerald-600 dark:text-emerald-400">✓ Meets all requirements</p>;
  return (
    <ul className="space-y-1">
      {issues.map((i, idx) => (
        <li key={idx} className={cx("flex gap-2 text-xs leading-snug", SEVERITY[i.severity].cls)}>
          <span className="mt-px inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full bg-current/10 text-[9px] font-bold">
            {SEVERITY[i.severity].icon}
          </span>
          <span>{i.message}</span>
        </li>
      ))}
    </ul>
  );
}

function frameRatio(rules: PlatformRules, result: ValidationResult, info?: MediaInfo): number {
  if (result.shortForm) return 9 / 16;
  const pref = rules.video.preferredOrientation;
  if (pref === "vertical") return 9 / 16;
  if (pref === "horizontal") return 16 / 9;
  if (info?.width && info.height) {
    const r = info.width / info.height;
    const min = rules.video.minAspectRatio ?? 0;
    const max = rules.video.maxAspectRatio ?? Infinity;
    return Math.min(Math.max(r, min), max);
  }
  return parseAspectRatio(rules.video.recommendedAspectRatios[0] ?? "16:9");
}

function Preview({
  rules,
  result,
  info,
  videoUrl,
  thumbUrl,
  visibility,
  scheduledAt,
}: {
  rules: PlatformRules;
  result: ValidationResult;
  info?: MediaInfo;
  videoUrl?: string;
  thumbUrl?: string;
  visibility: Visibility;
  scheduledAt: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const ratio = frameRatio(rules, result, info);
  const { effective } = result;
  return (
    <div className="space-y-2">
      <div className="flex justify-center rounded-lg bg-neutral-100 p-2 dark:bg-neutral-950">
        <div
          className="relative overflow-hidden rounded-md bg-black"
          style={{ aspectRatio: String(ratio), height: ratio < 1 ? 220 : undefined, width: ratio >= 1 ? "100%" : undefined, maxHeight: 220 }}
        >
          {videoUrl ? (
            <video src={`${videoUrl}#t=0.1`} poster={thumbUrl} muted playsInline preload="metadata" className="h-full w-full object-contain" />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[11px] text-neutral-500">
              {rules.video.recommendedAspectRatios[0]}
            </div>
          )}
          <span className="absolute bottom-1 right-1 rounded bg-black/60 px-1 text-[10px] text-white">
            {result.shortForm ? rules.shortForm?.name : rules.video.recommendedAspectRatios.join(" · ")}
          </span>
        </div>
      </div>
      <div className="space-y-1 text-sm">
        {effective.title !== null && <p className="line-clamp-2 font-semibold leading-snug">{effective.title || <span className="text-neutral-400">No title</span>}</p>}
        {effective.caption ? (
          <p className={cx("whitespace-pre-wrap break-words text-xs text-neutral-700 dark:text-neutral-300", !expanded && "line-clamp-4")}>
            {effective.caption}
          </p>
        ) : (
          <p className="text-xs text-neutral-400">No {rules.caption.label.toLowerCase()}</p>
        )}
        {effective.caption.split("\n").length > 4 || effective.caption.length > 200 ? (
          <button type="button" onClick={() => setExpanded((e) => !e)} className="text-[11px] font-medium text-neutral-500 hover:underline">
            {expanded ? "Show less" : "Show more"}
          </button>
        ) : null}
        {effective.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {effective.tags.map((t) => (
              <span key={t} className="rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                {t}
              </span>
            ))}
          </div>
        )}
        <p className="pt-1 text-[11px] capitalize text-neutral-500">
          {visibility}
          {scheduledAt && <> · goes live {new Date(scheduledAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</>}
        </p>
      </div>
    </div>
  );
}

type Level = "ok" | "warn" | "err" | "na";
const LEVEL_CLS: Record<Level, string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  warn: "text-amber-600 dark:text-amber-400",
  err: "text-red-600 dark:text-red-400",
  na: "text-neutral-400",
};

function Requirements({ rules, result, info }: { rules: PlatformRules; result: ValidationResult; info?: MediaInfo }) {
  const { effective } = result;
  const mode = rules.caption.countMode ?? "codepoints";
  const capLen = countText(effective.caption, mode);
  const capMax = rules.caption.maxLength ?? Infinity;
  const titleLen = effective.title !== null ? countText(effective.title, rules.title.countMode ?? "codepoints") : 0;
  const tagCount = rules.hashtags.placement === "tags" ? effective.tags.length : extractHashtags(effective.caption).length;
  const v = rules.video;
  const orientation = info?.width && info.height ? classifyOrientation(info.width, info.height) : null;

  const rows: Array<{ label: string; value: string; level: Level }> = [];
  rows.push(
    rules.title.supported
      ? {
          label: rules.title.label,
          value: `${titleLen} / ${rules.title.maxLength ?? "∞"}${rules.title.required ? " · required" : ""}`,
          level: rules.title.maxLength && titleLen > rules.title.maxLength ? "err" : rules.title.required && !titleLen ? "err" : "ok",
        }
      : { label: "Title", value: "not used", level: "na" },
  );
  rows.push({
    label: rules.caption.label,
    value: `${capLen.toLocaleString()} / ${capMax.toLocaleString()}${mode === "x-weighted" ? " weighted" : ""}${
      rules.caption.recommendedMaxLength ? ` · folds at ${rules.caption.recommendedMaxLength}` : ""
    }`,
    level: capLen > capMax ? "err" : rules.caption.recommendedMaxLength && capLen > rules.caption.recommendedMaxLength ? "warn" : "ok",
  });
  rows.push({
    label: rules.hashtags.placement === "tags" ? "Tags" : "Hashtags",
    value: `${tagCount} / ${rules.hashtags.max ?? "∞"}${rules.hashtags.recommendedMax ? ` · ≤${rules.hashtags.recommendedMax} recommended` : ""}`,
    level:
      rules.hashtags.max !== undefined && tagCount > rules.hashtags.max
        ? "err"
        : rules.hashtags.recommendedMax !== undefined && tagCount > rules.hashtags.recommendedMax
          ? "warn"
          : "ok",
  });
  const d = info?.durationSec;
  rows.push({
    label: "Duration",
    value: `${d !== undefined ? formatDuration(d) : "?"} · ${v.minDurationSec ? formatDuration(v.minDurationSec) : "0s"}–${
      v.maxDurationSec ? formatDuration(v.maxDurationSec) : "no limit"
    }`,
    level: d === undefined ? "na" : (v.maxDurationSec && d > v.maxDurationSec) || (v.minDurationSec && d < v.minDurationSec) ? "err" : "ok",
  });
  const size = info?.sizeBytes;
  rows.push({
    label: "File size",
    value: `${size !== undefined ? formatBytes(size) : "?"} · max ${v.maxFileSizeBytes ? formatBytes(v.maxFileSizeBytes) : "plan-based"}`,
    level: size === undefined ? "na" : v.maxFileSizeBytes && size > v.maxFileSizeBytes ? "err" : "ok",
  });
  const aspectIssue = [...result.errors, ...result.warnings].find((i) => i.code === "aspect_ratio_out_of_range" || i.code === "orientation_mismatch");
  rows.push({
    label: "Aspect",
    value: `${orientation ?? "?"} · ${v.recommendedAspectRatios.join(", ")} recommended`,
    level: !orientation ? "na" : aspectIssue ? (aspectIssue.severity === "error" ? "err" : "warn") : "ok",
  });

  return (
    <dl className="divide-y divide-neutral-100 text-xs dark:divide-neutral-800">
      {rows.map((r) => (
        <div key={r.label} className="flex items-baseline justify-between gap-3 py-1.5">
          <dt className="shrink-0 text-neutral-500">{r.label}</dt>
          <dd className={cx("text-right tabular-nums", LEVEL_CLS[r.level])}>{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function OverrideField({ custom, onReset, label, children }: { custom: boolean; onReset: () => void; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-neutral-700 dark:text-neutral-300">{label}</span>
        {custom ? (
          <span className="flex items-center gap-1">
            <Badge tone="violet">custom</Badge>
            <button type="button" onClick={onReset} className={btn.ghost}>
              Reset
            </button>
          </span>
        ) : (
          <Badge>inherited</Badge>
        )}
      </div>
      {children}
    </div>
  );
}

export function PlatformPanel({
  rules,
  result,
  base,
  override,
  onOverride,
  status,
  info,
  videoUrl,
  thumbUrl,
  visibility,
  scheduledAt,
}: {
  rules: PlatformRules;
  result: ValidationResult;
  base: TargetContent;
  override: Override;
  onOverride: (o: Override) => void;
  status?: PlatformStatus;
  info?: MediaInfo;
  videoUrl?: string;
  thumbUrl?: string;
  visibility: Visibility;
  scheduledAt: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const current: TargetContent = {
    title: override.title ?? base.title,
    caption: override.caption ?? base.caption,
    hashtags: override.hashtags ?? base.hashtags,
  };
  const apply = (adaptations: Adaptation[]) => onOverride(contentToOverride(applyTextAdaptations(current, adaptations), base));
  const automatic = result.adaptations.filter((a) => a.automatic);
  const manual = result.adaptations.filter((a) => !a.automatic);
  const customCount = [override.title, override.caption, override.hashtags].filter((v) => v !== null).length;
  const thumbSupported = status?.capabilities.thumbnail ?? false;

  return (
    <div
      className={cx(
        "flex flex-col rounded-xl border bg-white shadow-sm dark:bg-neutral-900",
        result.errors.length ? "border-red-300 dark:border-red-900" : "border-neutral-200 dark:border-neutral-800",
      )}
    >
      <div className="flex items-center gap-3 border-b border-neutral-100 px-4 py-3 dark:border-neutral-800">
        <PlatformIcon platform={rules.platform} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{rules.displayName}</span>
            {customCount > 0 && <Badge tone="violet">{customCount} custom</Badge>}
          </div>
          <div className="mt-0.5">
            <PlatformStatusBadge status={status} />
          </div>
        </div>
        {result.errors.length ? (
          <Badge tone="red">
            {result.errors.length} error{result.errors.length > 1 ? "s" : ""}
          </Badge>
        ) : result.warnings.length ? (
          <Badge tone="amber">
            {result.warnings.length} warning{result.warnings.length > 1 ? "s" : ""}
          </Badge>
        ) : (
          <Badge tone="green">Ready</Badge>
        )}
      </div>

      <div className="space-y-4 p-4">
        <Preview
          rules={rules}
          result={result}
          info={info}
          videoUrl={videoUrl}
          thumbUrl={thumbSupported ? thumbUrl : undefined}
          visibility={visibility}
          scheduledAt={scheduledAt}
        />

        <IssueList result={result} />

        {result.adaptations.length > 0 && (
          <div className="space-y-2 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-950">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Suggested fixes</span>
              {automatic.length > 1 && (
                <button type="button" className={btn.small} onClick={() => apply(automatic)}>
                  Apply all
                </button>
              )}
            </div>
            <ul className="space-y-1.5">
              {automatic.map((a, i) => (
                <li key={`a${i}`} className="flex items-center justify-between gap-2 text-xs">
                  <span>{a.description}</span>
                  <button type="button" className={btn.small} onClick={() => apply([a])}>
                    Apply
                  </button>
                </li>
              ))}
              {manual.map((a, i) => (
                <li key={`m${i}`} className="flex items-center justify-between gap-2 text-xs text-neutral-500">
                  <span>{a.description}</span>
                  <span className="shrink-0 text-[11px] italic">needs video processing</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Requirements</p>
          <Requirements rules={rules} result={result} info={info} />
        </div>

        <div className="border-t border-neutral-100 pt-3 dark:border-neutral-800">
          <button type="button" onClick={() => setEditing((e) => !e)} className="flex w-full items-center justify-between text-sm font-medium">
            <span>Customize for {rules.displayName}</span>
            <span className="text-neutral-400">{editing ? "▴" : "▾"}</span>
          </button>
          {editing && (
            <div className="mt-3 space-y-3">
              {rules.title.supported && (
                <OverrideField label={rules.title.label} custom={override.title !== null} onReset={() => onOverride({ ...override, title: null })}>
                  <input className={inputCls} value={current.title} onChange={(e) => onOverride({ ...override, title: e.target.value })} />
                </OverrideField>
              )}
              <OverrideField label={rules.caption.label} custom={override.caption !== null} onReset={() => onOverride({ ...override, caption: null })}>
                <textarea
                  className={cx(inputCls, "min-h-24")}
                  value={current.caption}
                  onChange={(e) => onOverride({ ...override, caption: e.target.value })}
                />
              </OverrideField>
              <OverrideField
                label={rules.hashtags.placement === "tags" ? "Tags" : "Hashtags"}
                custom={override.hashtags !== null}
                onReset={() => onOverride({ ...override, hashtags: null })}
              >
                <HashtagInput
                  value={current.hashtags}
                  onChange={(tags) => onOverride({ ...override, hashtags: tags })}
                  max={rules.hashtags.max}
                  recommendedMax={rules.hashtags.recommendedMax}
                />
              </OverrideField>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
