"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PLATFORM_RULES } from "@/lib/platforms/rules";
import { countText } from "@/lib/platforms/text";
import { resolveTargetContent, validateForPlatform, type ValidationResult } from "@/lib/platforms/validate";
import type { PlatformStatus } from "@/lib/services/posts";
import { PLATFORM_IDS, VISIBILITIES, type PlatformId, type TargetContent, type Visibility } from "@/lib/types";
import { Badge, Card, Field, PlatformIcon, btn, cx, inputCls } from "../ui";
import { HashtagInput } from "./hashtag-input";
import { ThumbnailPicker, VideoPicker } from "./media-picker";
import { EMPTY_OVERRIDE, PlatformPanel, PlatformStatusBadge, type Override } from "./platform-panel";
import { useUpload } from "./use-upload";

const DEFAULT_SELECTED: PlatformId[] = ["youtube", "tiktok", "instagram"];

const VISIBILITY_LABEL: Record<Visibility, { label: string; hint: string }> = {
  public: { label: "Public", hint: "Everyone can see it" },
  unlisted: { label: "Unlisted", hint: "Anyone with the link (falls back to private where unsupported)" },
  private: { label: "Private", hint: "Only you" },
};

/** `YYYY-MM-DDTHH:mm` in local time, for datetime-local inputs. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

interface SubmitError {
  message: string;
  validation?: ValidationResult[];
}

export function Composer() {
  const router = useRouter();
  const video = useUpload("video");
  const thumb = useUpload("image");

  const [title, setTitle] = useState("");
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [selected, setSelected] = useState<PlatformId[]>(DEFAULT_SELECTED);
  const [overrides, setOverrides] = useState<Partial<Record<PlatformId, Override>>>({});
  const [statuses, setStatuses] = useState<Partial<Record<PlatformId, PlatformStatus>>>({});
  const [dryRunMode, setDryRunMode] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<null | "draft" | "publish">(null);
  const [submitError, setSubmitError] = useState<SubmitError | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data: { dryRunMode: string; platforms: PlatformStatus[] }) => {
        if (cancelled) return;
        setDryRunMode(data.dryRunMode);
        setStatuses(Object.fromEntries(data.platforms.map((p) => [p.platform, p])));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const base: TargetContent = useMemo(() => ({ title, caption, hashtags }), [title, caption, hashtags]);
  const info = video.state?.info;
  const scheduledAt = scheduleEnabled && scheduleLocal ? new Date(scheduleLocal).toISOString() : null;

  const results = useMemo(() => {
    const out = {} as Record<PlatformId, ValidationResult>;
    for (const p of selected) {
      const o = overrides[p] ?? EMPTY_OVERRIDE;
      out[p] = validateForPlatform({
        platform: p,
        content: resolveTargetContent(base, { titleOverride: o.title, captionOverride: o.caption, hashtagsOverride: o.hashtags }),
        media: info,
      });
    }
    return out;
  }, [selected, overrides, base, info]);

  const errorCount = selected.reduce((n, p) => n + results[p].errors.length, 0);
  const warningCount = selected.reduce((n, p) => n + results[p].warnings.length, 0);
  const uploading = video.state?.status === "uploading" || video.state?.status === "probing" || thumb.state?.status === "uploading";
  const mediaId = video.state?.media?.id ?? null;
  const scheduleInvalid = scheduleEnabled && (!scheduleLocal || Date.parse(scheduledAt!) < Date.now());

  const blockers: string[] = [];
  if (!video.state) blockers.push("Add a video");
  else if (video.state.status === "error") blockers.push("Video upload failed");
  else if (!mediaId) blockers.push("Waiting for upload to finish");
  if (thumb.state?.status === "error") blockers.push("Thumbnail upload failed — remove or replace it");
  if (!selected.length) blockers.push("Select at least one platform");
  if (errorCount) blockers.push(`Fix ${errorCount} error${errorCount > 1 ? "s" : ""}`);
  if (scheduleInvalid) blockers.push("Pick a future schedule time");

  const togglePlatform = (p: PlatformId) =>
    setSelected((s) => (s.includes(p) ? s.filter((x) => x !== p) : PLATFORM_IDS.filter((x) => x === p || s.includes(x))));

  const strictestTitle = selected
    .map((p) => PLATFORM_RULES[p].title)
    .filter((t) => t.supported && t.maxLength)
    .reduce<number | null>((min, t) => (min === null || t.maxLength! < min ? t.maxLength! : min), null);

  async function submit(action: "draft" | "publish") {
    if (!mediaId) return;
    setSubmitting(action);
    setSubmitError(null);
    try {
      const res = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          caption,
          hashtags,
          mediaId,
          thumbnailId: thumb.state?.media?.id ?? null,
          visibility,
          scheduledAt,
          action,
          targets: selected.map((platform) => {
            const o = overrides[platform] ?? EMPTY_OVERRIDE;
            return { platform, titleOverride: o.title, captionOverride: o.caption, hashtagsOverride: o.hashtags, settings: {} };
          }),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSubmitError({ message: data.error ?? `Request failed (${res.status})`, validation: data.validation });
        return;
      }
      router.push(`/dashboard?post=${data.post.id}`);
    } catch (err) {
      setSubmitError({ message: (err as Error).message });
    } finally {
      setSubmitting(null);
    }
  }

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Compose</h1>
          <p className="mt-1 text-sm text-neutral-500">One video, every platform. Validation updates as you type.</p>
        </div>
        {dryRunMode && dryRunMode !== "off" && (
          <Badge tone="amber">
            {dryRunMode === "on" ? "Dry-run mode: nothing is actually posted" : "Unconfigured platforms run as dry-run"}
          </Badge>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Card className="p-5">
            <h2 className="mb-4 font-semibold">Video</h2>
            <VideoPicker state={video.state} onFile={video.select} onClear={video.clear} />
          </Card>

          <Card className="space-y-5 p-5">
            <h2 className="font-semibold">Details</h2>
            <Field
              label="Title"
              right={
                strictestTitle !== null && (
                  <span className={cx("text-xs tabular-nums", countText(title) > strictestTitle ? "text-red-600" : "text-neutral-500")}>
                    {countText(title)} / {strictestTitle}
                  </span>
                )
              }
              hint="Used where the platform supports titles (YouTube, Vimeo, Facebook, LinkedIn)."
            >
              <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Give your video a title" />
            </Field>
            <Field
              label="Description"
              right={<span className="text-xs tabular-nums text-neutral-500">{countText(caption).toLocaleString()} chars</span>}
              hint="Becomes the caption / post text. Per-platform limits are checked below."
            >
              <textarea
                className={cx(inputCls, "min-h-32")}
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder="What's this video about?"
              />
            </Field>
            <Field label="Hashtags / tags" hint="Appended to captions, or sent as tags on Vimeo. Enter, space or comma to add.">
              <HashtagInput value={hashtags} onChange={setHashtags} />
            </Field>
            <div className="grid gap-5 sm:grid-cols-2">
              <Field label="Visibility" hint={VISIBILITY_LABEL[visibility].hint}>
                <div className="inline-flex w-full rounded-lg border border-neutral-300 p-0.5 dark:border-neutral-700">
                  {VISIBILITIES.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setVisibility(v)}
                      className={cx(
                        "flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition",
                        visibility === v
                          ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                          : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
                      )}
                    >
                      {VISIBILITY_LABEL[v].label}
                    </button>
                  ))}
                </div>
              </Field>
              <Field
                label="Schedule"
                right={
                  <label className="flex items-center gap-2 text-xs text-neutral-600 dark:text-neutral-400">
                    <input
                      type="checkbox"
                      checked={scheduleEnabled}
                      onChange={(e) => {
                        setScheduleEnabled(e.target.checked);
                        if (e.target.checked && !scheduleLocal) setScheduleLocal(toLocalInput(new Date(Date.now() + 60 * 60_000)));
                      }}
                      className="accent-violet-600"
                    />
                    Publish later
                  </label>
                }
                hint={scheduleEnabled ? `Your time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}` : "Publishes as soon as you hit Publish."}
              >
                <input
                  type="datetime-local"
                  className={cx(inputCls, !scheduleEnabled && "opacity-50", scheduleInvalid && "border-red-400")}
                  disabled={!scheduleEnabled}
                  value={scheduleLocal}
                  min={toLocalInput(new Date())}
                  onChange={(e) => setScheduleLocal(e.target.value)}
                />
              </Field>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="p-5">
            <h2 className="mb-3 font-semibold">Thumbnail</h2>
            <ThumbnailPicker state={thumb.state} onFile={thumb.select} onClear={thumb.clear} />
          </Card>

          <Card className="p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-semibold">Platforms</h2>
              <Link href="/accounts" className="text-xs font-medium text-violet-600 hover:underline">
                Manage accounts
              </Link>
            </div>
            <div className="space-y-2">
              {PLATFORM_IDS.map((p) => {
                const on = selected.includes(p);
                const r = on ? results[p] : null;
                return (
                  <button
                    key={p}
                    type="button"
                    onClick={() => togglePlatform(p)}
                    aria-pressed={on}
                    className={cx(
                      "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition",
                      on
                        ? "border-violet-400 bg-violet-50/60 dark:border-violet-700 dark:bg-violet-950/30"
                        : "border-neutral-200 hover:bg-neutral-50 dark:border-neutral-800 dark:hover:bg-neutral-800/50",
                    )}
                  >
                    <PlatformIcon platform={p} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{PLATFORM_RULES[p].displayName}</span>
                      <span className="mt-0.5 block">
                        <PlatformStatusBadge status={statuses[p]} />
                      </span>
                    </span>
                    {r && (r.errors.length ? <Badge tone="red">{r.errors.length}</Badge> : r.warnings.length ? <Badge tone="amber">{r.warnings.length}</Badge> : <Badge tone="green">✓</Badge>)}
                    <span
                      className={cx(
                        "flex h-5 w-5 shrink-0 items-center justify-center rounded border text-xs",
                        on ? "border-violet-600 bg-violet-600 text-white" : "border-neutral-300 dark:border-neutral-600",
                      )}
                    >
                      {on && "✓"}
                    </span>
                  </button>
                );
              })}
            </div>
          </Card>

          <Card className="sticky top-20 space-y-4 p-5">
            <div className="flex items-center justify-between text-sm">
              <span className="font-semibold">Ready to go?</span>
              <span className="flex gap-1">
                {errorCount > 0 && <Badge tone="red">{errorCount} error{errorCount === 1 ? "" : "s"}</Badge>}
                {warningCount > 0 && <Badge tone="amber">{warningCount} warning{warningCount === 1 ? "" : "s"}</Badge>}
              </span>
            </div>
            {blockers.length > 0 && (
              <ul className="space-y-1 text-xs text-neutral-500">
                {blockers.map((b) => (
                  <li key={b}>• {b}</li>
                ))}
              </ul>
            )}
            {submitError && (
              <div className="rounded-lg bg-red-50 p-3 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                <p className="font-medium">{submitError.message}</p>
                {submitError.validation
                  ?.filter((v) => !v.ok)
                  .map((v) => (
                    <div key={v.platform} className="mt-2">
                      <p className="font-medium">{PLATFORM_RULES[v.platform].displayName}</p>
                      <ul className="ml-3 list-disc">
                        {v.errors.map((e, i) => (
                          <li key={i}>{e.message}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
              </div>
            )}
            <div className="flex flex-col gap-2 sm:flex-row lg:flex-col xl:flex-row">
              <button
                type="button"
                className={cx(btn.secondary, "flex-1")}
                disabled={!mediaId || uploading || !selected.length || submitting !== null}
                onClick={() => submit("draft")}
              >
                {submitting === "draft" ? "Saving…" : "Save draft"}
              </button>
              <button
                type="button"
                className={cx(btn.primary, "flex-1")}
                disabled={blockers.length > 0 || uploading || submitting !== null}
                onClick={() => submit("publish")}
              >
                {submitting === "publish"
                  ? "Submitting…"
                  : scheduleEnabled
                    ? `Schedule ${selected.length} post${selected.length === 1 ? "" : "s"}`
                    : `Publish to ${selected.length} platform${selected.length === 1 ? "" : "s"}`}
              </button>
            </div>
          </Card>
        </div>
      </div>

      {selected.length > 0 && (
        <section className="space-y-4">
          <div className="flex items-end justify-between">
            <div>
              <h2 className="text-lg font-semibold">Previews & requirements</h2>
              <p className="text-sm text-neutral-500">How each platform will receive your post. Fixes apply as per-platform overrides.</p>
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {selected.map((p) => (
              <PlatformPanel
                key={p}
                rules={PLATFORM_RULES[p]}
                result={results[p]}
                base={base}
                override={overrides[p] ?? EMPTY_OVERRIDE}
                onOverride={(o) => setOverrides((all) => ({ ...all, [p]: o }))}
                status={statuses[p]}
                info={info}
                videoUrl={video.state?.objectUrl}
                thumbUrl={thumb.state?.objectUrl}
                visibility={visibility}
                scheduledAt={scheduledAt}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
