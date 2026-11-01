"use client";

import { useMemo, useState } from "react";
import type { PostSummary } from "@/lib/services/posts";
import type { PostStatus } from "@/lib/types";
import { Card, PlatformIcon, btn, cx, formatDateTime, relativeTime } from "../ui";

/** When a post is (or was) going live: its schedule, else first publish time, else creation time. */
export function postDate(p: PostSummary): Date {
  if (p.scheduledAt) return new Date(p.scheduledAt);
  const finished = p.targets
    .map((t) => t.job?.finishedAt)
    .filter((d): d is string => !!d)
    .sort()[0];
  return new Date(finished ?? p.createdAt);
}

export function isUpcoming(p: PostSummary, now = Date.now()): boolean {
  return (
    !!p.scheduledAt &&
    Date.parse(p.scheduledAt) > now &&
    p.targets.some((t) => t.job && (t.job.status === "queued" || t.job.status === "uploading" || t.job.status === "published"))
  );
}

const DOT: Record<PostStatus, string> = {
  draft: "bg-neutral-400",
  scheduled: "bg-violet-500",
  publishing: "bg-blue-500",
  published: "bg-emerald-500",
  partial: "bg-amber-500",
  failed: "bg-red-500",
};

export function UpcomingList({ posts, onSelect }: { posts: PostSummary[]; onSelect: (id: string) => void }) {
  const upcoming = posts.filter((p) => isUpcoming(p)).sort((a, b) => postDate(a).getTime() - postDate(b).getTime());
  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Upcoming</h2>
        <span className="text-xs text-neutral-500">{upcoming.length} scheduled</span>
      </div>
      {upcoming.length === 0 ? (
        <p className="text-sm text-neutral-500">Nothing scheduled. Pick a time in Compose to schedule a post.</p>
      ) : (
        <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
          {upcoming.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => onSelect(p.id)}
                className="flex w-full items-center gap-3 py-2 text-left hover:bg-neutral-50 dark:hover:bg-neutral-900"
              >
                <div className="w-36 shrink-0">
                  <p className="text-sm font-medium tabular-nums">{formatDateTime(p.scheduledAt)}</p>
                  <p className="text-xs text-neutral-500">{relativeTime(p.scheduledAt!)}</p>
                </div>
                <p className="min-w-0 flex-1 truncate text-sm">{p.title || p.media?.originalFilename || "Untitled"}</p>
                <div className="flex shrink-0 -space-x-1">
                  {p.targets.map((t) => (
                    <PlatformIcon key={t.id} platform={t.platform} size="sm" />
                  ))}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Monday-first 6x7 grid of dates covering `month`. */
export function monthGrid(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const offset = (first.getDay() + 6) % 7; // Monday = 0
  const start = new Date(first.getFullYear(), first.getMonth(), 1 - offset);
  return Array.from({ length: 42 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
}

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

export function MonthCalendar({ posts, onSelect }: { posts: PostSummary[]; onSelect: (id: string) => void }) {
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const byDay = useMemo(() => {
    const map = new Map<string, PostSummary[]>();
    for (const p of posts) {
      const k = dayKey(postDate(p));
      map.set(k, [...(map.get(k) ?? []), p]);
    }
    for (const list of map.values()) list.sort((a, b) => postDate(a).getTime() - postDate(b).getTime());
    return map;
  }, [posts]);
  const days = monthGrid(month);
  const today = dayKey(new Date());
  const shift = (n: number) => setMonth((m) => new Date(m.getFullYear(), m.getMonth() + n, 1));

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <div className="flex gap-1">
          <button type="button" className={btn.small} onClick={() => shift(-1)} aria-label="Previous month">
            ←
          </button>
          <button
            type="button"
            className={btn.small}
            onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
          >
            Today
          </button>
          <button type="button" className={btn.small} onClick={() => shift(1)} aria-label="Next month">
            →
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-neutral-200 bg-neutral-200 text-xs dark:border-neutral-800 dark:bg-neutral-800">
        {WEEKDAYS.map((d) => (
          <div key={d} className="bg-neutral-50 px-2 py-1 text-center font-medium text-neutral-500 dark:bg-neutral-900">
            {d}
          </div>
        ))}
        {days.map((d) => {
          const k = dayKey(d);
          const items = byDay.get(k) ?? [];
          const inMonth = d.getMonth() === month.getMonth();
          return (
            <div
              key={k}
              className={cx(
                "min-h-20 bg-white p-1 sm:min-h-24 dark:bg-neutral-950",
                !inMonth && "bg-neutral-50 text-neutral-400 dark:bg-neutral-900/60",
              )}
            >
              <div
                className={cx(
                  "mb-1 flex h-5 w-5 items-center justify-center rounded-full tabular-nums",
                  k === today && "bg-violet-600 font-semibold text-white",
                )}
              >
                {d.getDate()}
              </div>
              <ul className="space-y-0.5">
                {items.slice(0, 3).map((p) => (
                  <li key={p.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(p.id)}
                      title={`${p.title || "Untitled"} · ${p.status} · ${formatDateTime(postDate(p).toISOString())}`}
                      className="flex w-full items-center gap-1 truncate rounded px-1 py-0.5 text-left hover:bg-neutral-100 dark:hover:bg-neutral-800"
                    >
                      <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", DOT[p.status])} />
                      <span className="hidden tabular-nums text-neutral-500 sm:inline">
                        {postDate(p).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                      </span>
                      <span className="truncate">{p.title || "Untitled"}</span>
                    </button>
                  </li>
                ))}
                {items.length > 3 && <li className="px-1 text-neutral-500">+{items.length - 3} more</li>}
              </ul>
            </div>
          );
        })}
      </div>
      <div className="mt-3 flex flex-wrap gap-3 text-xs text-neutral-500">
        {(["scheduled", "publishing", "published", "partial", "failed"] as PostStatus[]).map((s) => (
          <span key={s} className="flex items-center gap-1">
            <span className={cx("h-2 w-2 rounded-full", DOT[s])} /> {s}
          </span>
        ))}
      </div>
    </Card>
  );
}
