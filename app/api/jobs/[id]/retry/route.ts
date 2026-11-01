import { getDb } from "@/lib/db";
import { getJob, retryJob } from "@/lib/db/repo";
import { errorJson, json } from "@/lib/http";
import { ensureWorker } from "@/lib/jobs/worker";

/** Re-queue a failed job immediately (grants one more attempt). */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = getDb();
  const job = getJob(db, id);
  if (!job) return errorJson("Not found", 404);
  if (job.status !== "failed") return errorJson(`Only failed jobs can be retried (job is ${job.status})`, 409);
  const updated = retryJob(db, id);
  ensureWorker().kick();
  return json({ job: updated });
}
