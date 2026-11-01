import { getDb } from "@/lib/db";
import { errorJson, json } from "@/lib/http";
import { ensureWorker } from "@/lib/jobs/worker";
import { ComposeError, publishDraft } from "@/lib/services/posts";

/**
 * Publish a saved draft as-is.
 * Body (optional): `{ "scheduledAt": "<ISO>" | null }` — omit to keep the draft's schedule, null = now.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { scheduledAt?: unknown; dryRun?: unknown };
  let scheduledAt: string | null | undefined;
  if (body.scheduledAt === null) scheduledAt = null;
  else if (typeof body.scheduledAt === "string") {
    const t = Date.parse(body.scheduledAt);
    if (Number.isNaN(t)) return errorJson("scheduledAt is not a valid date", 400);
    scheduledAt = new Date(t).toISOString();
  }
  try {
    const result = publishDraft(getDb(), id, { scheduledAt, dryRun: body.dryRun === true });
    if (result.jobs.length > 0) ensureWorker().kick();
    return json(result);
  } catch (err) {
    if (err instanceof ComposeError) return errorJson(err.message, err.status, { validation: err.validation });
    throw err;
  }
}
