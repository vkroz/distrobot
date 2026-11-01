"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { PLATFORM_RULES } from "@/lib/platforms/rules";
import type { PostSummary, TargetSummary } from "@/lib/services/posts";
import type { JobStatus, PostStatus } from "@/lib/types";
import { Badge, Card, PlatformIcon, btn, cx, formatDateTime, formatDuration, relativeTime, type Tone } from "../ui";

const POST_TONE: Record<PostStatus, Tone> = {
  draft: "neutral",
  scheduled: "violet",
  publishing: "blue",
  published: "green",
  partial: "amber",
  failed: "red",
};

const JOB_TONE: Record<JobStatus, Tone> = { queued: "neutral", uploading: "blue", published: "green", failed: "red" };

const isActive = (p: PostSummary) => p.targets.some((t) => t.job && (t.job.status === "queued" || t.job.status === "uploading"));

function TargetRow({ target, onRetry, retrying }: { target: TargetSummary; onRetry: (jobId: string) => void; retrying: boolean }) {
  const job = target.job;
  const name = PLATFORM_RULES[target.platform].displayName;
  const waiting = job?.status === "queued" && job.nextRunAt && Date.parse(job.nextRunAt) > Date.now();
  const payload = (job?.resultPayload ?? null) as { warnings?: string[]; dryRun?: boolean } | null;
  const isDryRunLink = job?.resultUrl?.startsWith("/dry-run/");

  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
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

function PostCard({
  post,
  highlighted,
  onRetry,
  retrying,
}: {
  post: PostSummary;
  highlighted: boolean;
  onRetry: (jobId: string) => void;
  retrying: Set<string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  return (
    <div ref={ref}>
      <Card className={cx("overflow-hidden transition", highlighted && "ring-2 ring-violet-500")}>
        <div className="flex gap-4 p-4">
          <div className="flex h-20 w-32 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-neutral-100 dark:bg-neutral-800">
            {post.thumbnail ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={`/api/media/${post.thumbnail.id}`} alt="" className="h-full w-full object-cover" />
            ) : (
              <span className="text-2xl">🎬</span>
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
              Created {formatDateTime(post.createdAt)}
              {post.scheduledAt && <> · scheduled for {formatDateTime(post.scheduledAt)}</>}
              {post.media?.durationSec ? <> · {formatDuration(post.media.durationSec)}</> : null}
            </p>
          </div>
        </div>
        <ul className="divide-y divide-neutral-100 border-t border-neutral-100 px-4 dark:divide-neutral-800 dark:border-neutral-800">
          {post.targets.map((t) => (
            <TargetRow key={t.id} target={t} onRetry={onRetry} retrying={!!t.job && retrying.has(t.job.id)} />
          ))}
        </ul>
      </Card>
    </div>
  );
}

export function Dashboard({ highlight }: { highlight: string | null }) {
  const [posts, setPosts] = useState<PostSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<Set<string>>(new Set());

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

  const active = posts?.some(isActive) ?? false;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, [active, load]);

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
        <div className="space-y-4">
          {posts.map((p) => (
            <PostCard key={p.id} post={p} highlighted={p.id === highlight} onRetry={retry} retrying={retrying} />
          ))}
        </div>
      )}
    </div>
  );
}
