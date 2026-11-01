import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Badge, Card, PlatformIcon, formatDateTime } from "@/components/ui";
import { getDb } from "@/lib/db";
import { getJob, getPost } from "@/lib/db/repo";
import { PLATFORM_RULES } from "@/lib/platforms/rules";

export const metadata: Metadata = { title: "Dry-run result · Creator Publisher" };

interface Payload {
  title?: string | null;
  caption?: string;
  tags?: string[];
  visibility?: string;
  scheduledAt?: string | null;
  thumbnail?: boolean;
  dryRun?: boolean;
  warnings?: string[];
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm text-neutral-500">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export default async function DryRunPage({ params }: { params: Promise<{ jobId: string }> }) {
  await connection();
  const { jobId } = await params;
  const db = getDb();
  const job = getJob(db, jobId);
  if (!job) notFound();
  const post = getPost(db, job.postId);
  const rules = PLATFORM_RULES[job.platform];
  const payload = (job.resultPayload ?? null) as Payload | null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href={`/dashboard?post=${job.postId}`} className="text-sm text-neutral-500 hover:underline">
        ← Back to dashboard
      </Link>
      <div className="flex items-center gap-3">
        <PlatformIcon platform={job.platform} />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{rules.displayName} · dry-run</h1>
          <p className="text-sm text-neutral-500">This is what would have been sent. Nothing was posted.</p>
        </div>
      </div>

      <Card className="px-5">
        <dl className="divide-y divide-neutral-100 dark:divide-neutral-800">
          <Row label="Status">
            <span className="flex flex-wrap items-center gap-2">
              <Badge tone={job.status === "published" ? "green" : job.status === "failed" ? "red" : "blue"}>{job.status}</Badge>
              <span className="text-xs text-neutral-500">
                attempt {job.attempts}/{job.maxAttempts}
                {job.finishedAt && <> · finished {formatDateTime(job.finishedAt)}</>}
              </span>
            </span>
          </Row>
          {!payload ? (
            <Row label="Payload">
              <span className="text-neutral-500">Not available yet — the job hasn&apos;t completed.</span>
            </Row>
          ) : (
            <>
              {payload.title !== null && payload.title !== undefined && <Row label={rules.title.label}>{payload.title || "—"}</Row>}
              <Row label={rules.caption.label}>
                <p className="whitespace-pre-wrap break-words">{payload.caption || "—"}</p>
              </Row>
              {payload.tags && payload.tags.length > 0 && (
                <Row label="Tags">
                  <span className="flex flex-wrap gap-1">
                    {payload.tags.map((t) => (
                      <Badge key={t}>{t}</Badge>
                    ))}
                  </span>
                </Row>
              )}
              <Row label="Visibility">
                <span className="capitalize">{payload.visibility ?? post?.visibility ?? "—"}</span>
              </Row>
              <Row label="Scheduled">{payload.scheduledAt ? formatDateTime(payload.scheduledAt) : "Immediately"}</Row>
              <Row label="Custom thumbnail">{payload.thumbnail ? "Yes" : "No"}</Row>
              {payload.warnings && payload.warnings.length > 0 && (
                <Row label="Warnings">
                  <ul className="space-y-1 text-amber-700 dark:text-amber-400">
                    {payload.warnings.map((w, i) => (
                      <li key={i}>⚠ {w}</li>
                    ))}
                  </ul>
                </Row>
              )}
            </>
          )}
        </dl>
      </Card>
    </div>
  );
}
