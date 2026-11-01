"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PLATFORM_RULES } from "@/lib/platforms/rules";
import type { ValidationResult } from "@/lib/platforms/validate";
import type { PostSummary, TargetSummary } from "@/lib/services/posts";
import type { JobStatus, PostStatus } from "@/lib/types";
import { Badge, Card, PlatformIcon, btn, cx, formatDateTime, formatDuration, inputCls, relativeTime, type Tone } from "../ui";
import { MonthCalendar, UpcomingList } from "./schedule";

const POST_TONE: Record<PostStatus, Tone> = {
  draft: "neutral",
  scheduled: "violet",
  publishing: "blue",
  published: "green",
  partial: "amber",
  failed: "red",
};

const JOB_TONE: Record<JobStatus, Tone> = { queued: "neutral", uploading: "blue", published: "green", failed: "red" };

/** In flight = uploading, or queued and due within a few seconds (scheduled/backoff jobs far out don't count). */
const isActive = (p: PostSummary, now = Date.now()) =>
  p.targets.some(
    (t) =>
      t.job &&
      (t.job.status === "uploading" ||
        (t.job.status === "queued" && (!t.job.nextRunAt || Date.parse(t.job.nextRunAt) <= now + 5000))),
  );
const hasPending = (p: PostSummary) => p.targets.some((t) => t.job?.status === "queued");

function TargetRow({ target, onRetry, retrying }: { target: TargetSummary; onRetry: (jobId: string) => void; retrying: boolean }) {
  const job = target.job;
  const name = PLATFORM_RULES[target.platform].displayName;
  const waiting = job?.status === "queued" && job.nextRunAt && Date.parse(job.nextRunAt) > Date.now();
  const payload = (job?.resultPayload ?? null) as { warnings?: string[]; dryRun?: boolean; scheduledAt?: string | null } | null;
  // Natively scheduled (e.g. YouTube publishAt): uploaded now, goes public later.
  const goesLiveAt =
    job?.status === "published" && payload?.scheduledAt && Date.parse(payload.scheduledAt) > Date.now() ? payload.scheduledAt : null;
  const isDryRunLink = job?.resultUrl?.startsWith("/dry-run/");

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:flex-wrap sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <PlatformIcon platform={target.platform} size="sm" />
        <span className="w-28 shrink-0 text-sm font-medium">{name}</span>
        {!job ? (
          <Badge>{target.enabled ? "draft" : "disabled"}</Badge>
        ) : (
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
            <Badge tone={waiting && job.attempts === 0 ? "violet" : JOB_TONE[job.status]}>
              {waiting && job.attempts === 0 ? "scheduled" : waiting ? "retrying" : job.status}
            </Badge>
            {job.dryRun || payload?.dryRun || isDryRunLink ? <Badge tone="amber">dry-run</Badge> : null}
            {goesLiveAt && (
              <span className="text-xs text-violet-600" title={formatDateTime(goesLiveAt)}>
                uploaded · goes live {relativeTime(goesLiveAt)}
              </span>
            )}
            {job.status === "uploading" && (
              <div className="flex items-center gap-2">
                <div className="h-1.5 w-28 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800">
                  <div
                    className="h-full rounded-full bg-blue-500 transition-all"
                    style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }}
                  />
                </div>
                <span className="text-xs tabular-nums text-neutral-500">{Math.round((job.progress ?? 0) * 100)}%</span>
              </div>
            )}
            {waiting && job.nextRunAt && (
              <span className="text-xs text-neutral-500" title={formatDateTime(job.nextRunAt)}>
                {job.attempts === 0 ? "runs" : "next attempt"} {relativeTime(job.nextRunAt)}
              </span>
            )}
            {job.attempts > 0 && (
              <span className="text-xs tabular-nums text-neutral-400">
                attempt {job.attempts}/{job.maxAttempts}
              </span>
            )}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 pl-8 sm:pl-0">
        {job?.resultUrl &&
          (isDryRunLink ? (
            <Link href={job.resultUrl} className="text-xs font-medium text-amber-600 hover:underline">
              dry-run preview →
            </Link>
          ) : (
            <a href={job.resultUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-violet-600 hover:underline">
              View on {name} ↗
            </a>
          ))}
        {job?.status === "failed" && (
          <button type="button" className={btn.small} disabled={retrying} onClick={() => onRetry(job.id)}>
            {retrying ? "Retrying…" : "Retry"}
          </button>
        )}
      </div>
      {(job?.error && job.status !== "published") || (payload?.warnings && payload.warnings.length > 0) ? (
        <div className="basis-full space-y-0.5 pl-8 sm:pl-11">
          {job?.error && job.status !== "published" && (
            <p className={cx("text-xs", job.status === "failed" ? "text-red-600 dark:text-red-400" : "text-amber-600")}>{job.error}</p>
          )}
          {payload?.warnings?.map((w, i) => (
            <p key={i} className="text-xs text-amber-600 dark:text-amber-400">
              ⚠ {w}
            </p>
          ))}
        </div>
      ) : null}
    </li>
  );
}

/** `YYYY-MM-DDTHH:mm` in local time, for datetime-local inputs. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const isDraft = (p: PostSummary) => p.status === "draft" && p.targets.every((t) => !t.job);

interface ActionError {
  message: string;
  validation?: ValidationResult[];
}

function PostActions({ post, onChanged }: { post: PostSummary; onChanged: (notice: string) => void }) {
  const draft = isDraft(post);
  const [busy, setBusy] = useState<null | "publish" | "schedule" | "delete">(null);
  const [error, setError] = useState<ActionError | null>(null);
  const [scheduling, setScheduling] = useState(false);
  const [when, setWhen] = useState(() => toLocalInput(new Date(post.scheduledAt && Date.parse(post.scheduledAt) > Date.now() ? post.scheduledAt : Date.now() + 3600_000)));
  const uploading = post.targets.some((t) => t.job?.status === "uploading");
  const pending = post.targets.some((t) => t.job?.status === "queued");

  async function call(kind: "publish" | "schedule" | "delete", url: string, init: RequestInit, success: string) {
    setBusy(kind);
    setError(null);
    try {
      const res = await fetch(url, init);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError({ message: data.error ?? `Request failed (${res.status})`, validation: data.validation });
        return;
      }
      setScheduling(false);
      onChanged(success);
    } catch (err) {
      setError({ message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const publish = (scheduledAt: string | null) =>
    call(
      scheduledAt ? "schedule" : "publish",
      `/api/posts/${post.id}/publish`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ scheduledAt }) },
      scheduledAt ? `Scheduled “${post.title || "Untitled"}” for ${formatDateTime(scheduledAt)}.` : `Publishing “${post.title || "Untitled"}”…`,
    );

  const remove = () => {
    const msg = draft
      ? "Delete this draft? This can't be undone."
      : pending
        ? "Delete this post? Queued and scheduled jobs will be cancelled. Already-published videos stay on the platforms."
        : "Delete this post from the history? Already-published videos stay on the platforms.";
    if (!confirm(msg)) return;
    call("delete", `/api/posts/${post.id}`, { method: "DELETE" }, draft ? "Draft deleted." : "Post deleted.");
  };

  const scheduleInvalid = !when || Date.parse(new Date(when).toISOString()) <= Date.now();

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {draft && (
          <>
            <Link href={`/compose?draft=${post.id}`} className={btn.small}>
              Edit
            </Link>
            <button type="button" className={btn.small} disabled={busy !== null} onClick={() => publish(null)}>
              {busy === "publish" ? "Publishing…" : "Publish now"}
            </button>
            <button type="button" className={btn.small} disabled={busy !== null} onClick={() => setScheduling((v) => !v)}>
              Schedule…
            </button>
          </>
        )}
        <button
          type="button"
          className={cx(btn.small, "text-red-600 dark:text-red-400")}
          disabled={busy !== null || uploading}
          title={uploading ? "Can't delete while a video is uploading" : undefined}
          onClick={remove}
        >
          {busy === "delete" ? "Deleting…" : "Delete"}
        </button>
      </div>
      {scheduling && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="datetime-local"
            className={cx(inputCls, "w-auto py-1 text-xs")}
            value={when}
            min={toLocalInput(new Date())}
            onChange={(e) => setWhen(e.target.value)}
          />
          <button
            type="button"
            className={btn.small}
            disabled={busy !== null || scheduleInvalid}
            onClick={() => publish(new Date(when).toISOString())}
          >
            {busy === "schedule" ? "Scheduling…" : "Confirm schedule"}
          </button>
          <button type="button" className={btn.ghost} onClick={() => setScheduling(false)}>
            Cancel
          </button>
        </div>
      )}
      {error && (
        <div className="rounded-lg bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
          <p className="font-medium">{error.message}</p>
          {error.validation
            ?.filter((v) => !v.ok)
            .map((v) => (
              <p key={v.platform} className="mt-1">
                <span className="font-medium">{PLATFORM_RULES[v.platform].displayName}:</span> {v.errors.map((e) => e.message).join(" ")}
              </p>
            ))}
          {draft && error.validation && (
            <Link href={`/compose?draft=${post.id}`} className="mt-1 inline-block font-medium underline">
              Fix in editor →
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function PostCard({
  post,
  highlighted,
  onRetry,
  retrying,
  onChanged,
}: {
  post: PostSummary;
  highlighted: boolean;
  onRetry: (jobId: string) => void;
  retrying: Set<string>;
  onChanged: (notice: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);
  const draft = isDraft(post);

  return (
    <div ref={ref}>
      <Card className={cx("overflow-hidden transition", highlighted && "ring-2 ring-violet-500", draft && "border-dashed")}>
        <div className="flex gap-4 p-4">
          <div className="flex h-20 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800">
            {post.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/media/${post.thumbnail.id}`} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-2xl">{draft ? "📝" : "🎬"}</span>
            )}
          </div>
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-semibold">{post.title || post.media?.originalFilename || "Untitled"}</h3>
              <Badge tone={POST_TONE[post.status]}>{post.status}</Badge>
              <Badge>{post.visibility}</Badge>
            </div>
            {post.caption && <p className="line-clamp-2 text-sm text-neutral-600 dark:text-neutral-400">{post.caption}</p>}
            <p className="text-xs text-neutral-500">
              {draft ? "Last edited" : "Created"} {formatDateTime(draft ? post.updatedAt : post.createdAt)}
              {post.scheduledAt && <> · {draft ? "planned for" : "scheduled for"} {formatDateTime(post.scheduledAt)}</>}
              {post.media?.durationSec ? <> · {formatDuration(post.media.durationSec)}</> : null}
              {draft && !post.media && <span className="text-amber-600"> · no video yet</span>}
            </p>
            <div className="pt-1">
              <PostActions post={post} onChanged={onChanged} />
            </div>
          </div>
        </div>
        {post.targets.length > 0 ? (
          <ul className="divide-y divide-neutral-100 border-t border-neutral-100 px-4 dark:divide-neutral-800 dark:border-neutral-800">
            {post.targets.map((t) => (
              <TargetRow key={t.id} target={t} onRetry={onRetry} retrying={!!t.job && retrying.has(t.job.id)} />
            ))}
          </ul>
        ) : (
          <p className="border-t border-neutral-100 px-4 py-3 text-xs text-neutral-500 dark:border-neutral-800">No platforms selected yet.</p>
        )}
      </Card>
    </div>
  );
}

export function Dashboard({ highlight, initialView = "list" }: { highlight: string | null; initialView?: "list" | "calendar" }) {
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());
  const [view, setView] = useState<"list" | "calendar">(initialView);
  const [filter, setFilter] = useState<"all" | "drafts">("all");
  const [selected, setSelected] = useState<string | null>(highlight);
  const select = (id: string) => {
    setView("list");
    setSelected(id);
  };

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/posts", { cache: "no-store" });
      if (!res.ok) throw new Error(`Failed to load posts (${res.status})`);
      const data = (await res.json()) as { posts: PostSummary[] };
      setPosts(data.posts);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const active = posts?.some((p) => isActive(p)) ?? false;
  const pending = posts?.some(hasPending) ?? false;
  useEffect(() => {
    // Fast refresh while jobs are in flight; slow refresh so scheduled/retrying jobs show up when they start.
    if (!active && !pending) return;
    const t = setInterval(load, active ? 2000 : 15000);
    return () => clearInterval(t);
  }, [active, pending, load]);

  async function runWorker() {
    setRunning(true);
    setNotice(null);
    try {
      const res = await fetch("/api/jobs/run", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `Worker run failed (${res.status})`);
      const n = (data.processed ?? []).length;
      setNotice(n ? `Processed ${n} job${n > 1 ? "s" : ""}.` : "No jobs were due.");
    } catch (err) {
      setNotice((err as Error).message);
    } finally {
      setRunning(false);
      load();
    }
  }

  async function retry(jobId: string) {
    setRetrying((s) => new Set(s).add(jobId));
    try {
      const res = await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setNotice(data.error ?? `Retry failed (${res.status})`);
      }
    } finally {
      setRetrying((s) => {
        const n = new Set(s);
        n.delete(jobId);
        return n;
      });
      load();
    }
  }

  const counts = (posts ?? []).flatMap((p) => p.targets).reduce(
    (acc, t) => {
      if (t.job) acc[t.job.status]++;
      return acc;
    },
    { queued: 0, uploading: 0, published: 0, failed: 0 } as Record<JobStatus, number>,
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Publish jobs across platforms{active && <span className="ml-1 text-blue-600">· live updating</span>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" className={btn.secondary} onClick={() => load()}>
            Refresh
          </button>
          <Link href="/compose" className={btn.secondary}>
            New post
          </Link>
          <button type="button" className={btn.primary} onClick={runWorker} disabled={running}>
            {running ? "Running…" : "Run worker now"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {(["queued", "uploading", "published", "failed"] as JobStatus[]).map((s) => (
          <Card key={s} className="p-4">
            <p className="text-xs uppercase tracking-wide text-neutral-500">{s}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{counts[s]}</p>
          </Card>
        ))}
      </div>

      {notice && <p className="rounded-lg bg-neutral-100 px-3 py-2 text-sm dark:bg-neutral-900">{notice}</p>}
      {error && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{error}</p>}

      {posts === null ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl bg-neutral-200/60 dark:bg-neutral-800/60" />
          ))}
        </div>
      ) : posts.length === 0 ? (
        <Card className="p-10 text-center">
          <p className="font-medium">No posts yet</p>
          <p className="mt-1 text-sm text-neutral-500">Compose your first multi-platform post.</p>
          <Link href="/compose" className={cx(btn.primary, "mt-4")}>
            Compose
          </Link>
        </Card>
      ) : (
        <>
          <UpcomingList posts={posts} onSelect={select} />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h2 className="text-sm font-semibold">{view === "list" ? (filter === "drafts" ? "Drafts" : "Publication history") : "Calendar"}</h2>
              {view === "list" && (
                <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 text-xs dark:border-neutral-800">
                  {(["all", "drafts"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      aria-pressed={filter === f}
                      onClick={() => setFilter(f)}
                      className={cx(
                        "rounded-md px-2 py-0.5 capitalize",
                        filter === f ? "bg-neutral-200 font-medium dark:bg-neutral-800" : "text-neutral-500",
                      )}
                    >
                      {f === "drafts" ? `Drafts (${posts.filter(isDraft).length})` : "All"}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="inline-flex rounded-lg border border-neutral-200 p-0.5 text-sm dark:border-neutral-800" role="tablist">
              {(["list", "calendar"] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                  className={cx(
                    "rounded-md px-3 py-1 capitalize",
                    view === v ? "bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900" : "text-neutral-500",
                  )}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
          {view === "calendar" ? (
            <MonthCalendar posts={posts} onSelect={select} />
          ) : (
            <div className="space-y-4">
              {(filter === "drafts" ? posts.filter(isDraft) : posts).map((p) => (
                <PostCard
                  key={p.id}
                  post={p}
                  highlighted={p.id === selected}
                  onRetry={retry}
                  retrying={retrying}
                  onChanged={(msg) => {
                    setNotice(msg);
                    load();
                  }}
                />
              ))}
              {filter === "drafts" && !posts.some(isDraft) && (
                <p className="text-sm text-neutral-500">
                  No drafts. Use <span className="font-medium">Save draft</span> in Compose to keep work in progress.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
