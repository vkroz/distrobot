"use client";

import { useEffect, useState } from "react";
import {
  TIKTOK_LINKS,
  TIKTOK_PRIVACY_LABELS,
  commercialLabel,
  consentText,
  parseTikTokSettings,
  type TikTokCreatorInfo,
  type TikTokPrivacyLevel,
  type TikTokSettings,
} from "@/lib/platforms/tiktok";
import type { ValidationIssue } from "@/lib/platforms/validate";
import { Badge, Card, PlatformIcon, cx, formatDuration, inputCls } from "../ui";

export type CreatorState =
  | { status: "loading" }
  | { status: "ok"; source: "api" | "mock"; reason?: string; accountName?: string; creator: TikTokCreatorInfo }
  | { status: "error"; error: string };

/** Fetch creator_info once TikTok is selected (TikTok requires showing it on the posting screen). */
export function useTikTokCreator(enabled: boolean): CreatorState | null {
  const [state, setState] = useState<CreatorState | null>(null);
  useEffect(() => {
    if (!enabled || state) return;
    let cancelled = false;
    setState({ status: "loading" });
    fetch("/api/tiktok/creator-info", { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok || !data.creator) setState({ status: "error", error: data.error ?? `Couldn't load TikTok creator info (${r.status})` });
        else setState({ status: "ok", source: data.source, reason: data.reason, accountName: data.account?.displayName, creator: data.creator });
      })
      .catch((err) => !cancelled && setState({ status: "error", error: (err as Error).message }));
    return () => {
      cancelled = true;
    };
    // Load once per page; `state` intentionally not a dependency trigger beyond the first fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
  return state;
}

function Toggle({
  label,
  checked,
  disabled,
  title,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (v: boolean) => void;
}) {
  return (
    <label title={title} className={cx("flex items-center gap-2 text-sm", disabled ? "cursor-not-allowed text-neutral-400" : "cursor-pointer")}>
      <input
        type="checkbox"
        className="accent-violet-600"
        checked={checked && !disabled}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      {label}
    </label>
  );
}

export function TikTokSettingsCard({
  value,
  onChange,
  creatorState,
  durationSec,
  issues,
}: {
  value: Record<string, unknown> | undefined;
  onChange: (s: TikTokSettings) => void;
  creatorState: CreatorState | null;
  durationSec?: number;
  issues: ValidationIssue[];
}) {
  const s = parseTikTokSettings(value);
  const c = s.commercial!;
  const set = (patch: Partial<TikTokSettings>) => onChange({ ...s, ...patch });
  const setCommercial = (patch: Partial<NonNullable<TikTokSettings["commercial"]>>) => set({ commercial: { ...c, ...patch } });
  const creator = creatorState?.status === "ok" ? creatorState.creator : null;
  const options = creator?.privacyLevelOptions ?? [];
  const label = commercialLabel(s);
  const brandedPrivateConflict = c.enabled && c.brandedContent;

  return (
    <Card className="space-y-5 p-5">
      <div className="flex items-center gap-3">
        <PlatformIcon platform="tiktok" />
        <div>
          <h2 className="font-semibold">TikTok posting settings</h2>
          <p className="text-xs text-neutral-500">Required by TikTok before posting. Nothing is pre-selected.</p>
        </div>
      </div>

      {/* Creator info */}
      <div className="rounded-lg bg-neutral-50 p-3 dark:bg-neutral-950">
        {!creatorState || creatorState.status === "loading" ? (
          <p className="text-sm text-neutral-500">Loading TikTok creator info…</p>
        ) : creatorState.status === "error" ? (
          <div className="text-sm text-red-700 dark:text-red-400">
            <p className="font-medium">TikTok is unavailable right now</p>
            <p className="text-xs">{creatorState.error}</p>
            <p className="mt-1 text-xs">Publishing to TikTok is disabled until creator info loads. Try again later.</p>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {creator!.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={creator!.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" />
            ) : (
              <span className="flex h-10 w-10 items-center justify-center rounded-full bg-neutral-200 text-sm font-semibold dark:bg-neutral-800">
                {creator!.nickname.slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                Posting to {creator!.nickname}
                {creator!.username && <span className="font-normal text-neutral-500"> @{creator!.username}</span>}
              </p>
              <p className="text-xs text-neutral-500">
                {creator!.maxVideoPostDurationSec ? `Max video length ${formatDuration(creator!.maxVideoPostDurationSec)}` : "Max length unknown"}
                {durationSec !== undefined && creator!.maxVideoPostDurationSec && durationSec > creator!.maxVideoPostDurationSec && (
                  <span className="text-red-600"> · your video is {formatDuration(durationSec)}</span>
                )}
              </p>
            </div>
            {creatorState.source === "mock" && (
              <Badge tone="amber" className="shrink-0">
                <span title={creatorState.reason}>mock</span>
              </Badge>
            )}
          </div>
        )}
        {creatorState?.status === "ok" && creatorState.source === "mock" && creatorState.reason && (
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-400">Mock creator info: {creatorState.reason}.</p>
        )}
      </div>

      {/* Privacy */}
      <div className="space-y-1.5">
        <label htmlFor="tt-privacy" className="text-sm font-medium">
          Who can view this video <span className="text-red-600">*</span>
        </label>
        <select
          id="tt-privacy"
          className={cx(inputCls, !s.privacyLevel && "text-neutral-400")}
          value={s.privacyLevel ?? ""}
          disabled={!creator}
          onChange={(e) => set({ privacyLevel: (e.target.value || null) as TikTokPrivacyLevel | null })}
        >
          <option value="" disabled>
            Select…
          </option>
          {options.map((o) => {
            const blocked = o === "SELF_ONLY" && brandedPrivateConflict;
            return (
              <option key={o} value={o} disabled={blocked}>
                {TIKTOK_PRIVACY_LABELS[o]}
                {blocked ? " — not available for branded content" : ""}
              </option>
            );
          })}
        </select>
        {brandedPrivateConflict && <p className="text-xs text-neutral-500">Branded content can't be private, so “Only me” is unavailable.</p>}
      </div>

      {/* Interactions */}
      <div className="space-y-2">
        <p className="text-sm font-medium">Allow users to</p>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          <Toggle
            label="Comment"
            checked={!!s.allowComment}
            disabled={!creator || creator.commentDisabled}
            title={creator?.commentDisabled ? "Comments are turned off in this creator's TikTok privacy settings" : undefined}
            onChange={(v) => set({ allowComment: v })}
          />
          <Toggle
            label="Duet"
            checked={!!s.allowDuet}
            disabled={!creator || creator.duetDisabled}
            title={creator?.duetDisabled ? "Duet is turned off in this creator's TikTok privacy settings" : undefined}
            onChange={(v) => set({ allowDuet: v })}
          />
          <Toggle
            label="Stitch"
            checked={!!s.allowStitch}
            disabled={!creator || creator.stitchDisabled}
            title={creator?.stitchDisabled ? "Stitch is turned off in this creator's TikTok privacy settings" : undefined}
            onChange={(v) => set({ allowStitch: v })}
          />
        </div>
      </div>

      {/* Commercial content disclosure */}
      <div className="space-y-2 border-t border-neutral-100 pt-4 dark:border-neutral-800">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm font-medium">Disclose video content</p>
            <p className="text-xs text-neutral-500">Turn on if this video promotes yourself, a brand, product or service.</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={c.enabled}
            disabled={!creator}
            onClick={() => setCommercial({ enabled: !c.enabled, ...(c.enabled ? { yourBrand: false, brandedContent: false } : {}) })}
            className={cx(
              "relative h-6 w-11 shrink-0 rounded-full transition disabled:opacity-40",
              c.enabled ? "bg-violet-600" : "bg-neutral-300 dark:bg-neutral-700",
            )}
          >
            <span className={cx("absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition", c.enabled ? "left-5.5" : "left-0.5")} />
          </button>
        </div>
        {c.enabled && (
          <div className="space-y-3 rounded-lg bg-neutral-50 p-3 dark:bg-neutral-950">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 accent-violet-600" checked={c.yourBrand} onChange={(e) => setCommercial({ yourBrand: e.target.checked })} />
              <span>
                <span className="font-medium">Your brand</span>
                <span className="block text-xs text-neutral-500">You are promoting yourself or your own business.</span>
              </span>
            </label>
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 accent-violet-600"
                checked={c.brandedContent}
                onChange={(e) => {
                  const checked = e.target.checked;
                  // Branded content can't be private: clear an "Only me" choice instead of silently keeping it.
                  set({
                    commercial: { ...c, brandedContent: checked },
                    ...(checked && s.privacyLevel === "SELF_ONLY" ? { privacyLevel: null } : {}),
                  });
                }}
              />
              <span>
                <span className="font-medium">Branded content</span>
                <span className="block text-xs text-neutral-500">You are promoting another brand or a third party.</span>
              </span>
            </label>
            {label ? (
              <p className="text-xs text-violet-700 dark:text-violet-300">Your video will be labeled “{label}”.</p>
            ) : (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                You need to indicate if your content promotes yourself, a third party, or both.
              </p>
            )}
          </div>
        )}
      </div>

      {issues.length > 0 && (
        <ul className="space-y-1">
          {issues.map((i) => (
            <li key={i.code} className="text-xs text-red-700 dark:text-red-400">
              ✕ {i.message}
            </li>
          ))}
        </ul>
      )}

      <TikTokConsent settings={s} />
    </Card>
  );
}

/** TikTok's required declaration, shown before the user posts. */
export function TikTokConsent({ settings, className }: { settings: unknown; className?: string }) {
  const parsed = parseTikTokSettings(settings);
  const branded = parsed.commercial?.enabled && parsed.commercial.brandedContent;
  return (
    <p className={cx("text-xs text-neutral-600 dark:text-neutral-400", className)}>
      {branded ? (
        <>
          By posting, you agree to TikTok&apos;s{" "}
          <a href={TIKTOK_LINKS.brandedContentPolicy} target="_blank" rel="noreferrer" className="underline">
            Branded Content Policy
          </a>{" "}
          and{" "}
          <a href={TIKTOK_LINKS.musicUsage} target="_blank" rel="noreferrer" className="underline">
            Music Usage Confirmation
          </a>
          .
        </>
      ) : (
        <>
          By posting, you agree to TikTok&apos;s{" "}
          <a href={TIKTOK_LINKS.musicUsage} target="_blank" rel="noreferrer" className="underline">
            Music Usage Confirmation
          </a>
          .
        </>
      )}
      <span className="sr-only"> ({consentText(settings)})</span>
    </p>
  );
}
