import { getDb } from "@/lib/db";
import { errorJson, json } from "@/lib/http";
import { ensureWorker } from "@/lib/jobs/worker";
import { ComposeError, deletePostAndOrphans, getPostSummary, parseComposeInput, updateDraft } from "@/lib/services/posts";
import { deleteStoredFile } from "@/lib/storage/local";

type Ctx = { params: Promise<{ id: string }> };

const handle = (err: unknown) => {
  if (err instanceof ComposeError) return errorJson(err.message, err.status, { validation: err.validation });
  throw err;
};

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const post = getPostSummary(getDb(), id);
  return post ? json({ post }) : errorJson("Not found", 404);
}

/** Update a draft (same body as POST /api/posts). action "publish" validates and enqueues it. */
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson("Invalid JSON", 400);
  }
  try {
    const result = updateDraft(getDb(), id, parseComposeInput(body));
    if (result.jobs.length > 0) ensureWorker().kick();
    return json(result);
  } catch (err) {
    return handle(err);
  }
}

/** Delete a post (drafts, scheduled or finished). Cancels queued jobs; refused while uploading. */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const { deletedMediaPaths } = deletePostAndOrphans(getDb(), id);
    await Promise.all(deletedMediaPaths.map((p) => deleteStoredFile(p).catch(() => undefined)));
    return json({ ok: true });
  } catch (err) {
    return handle(err);
  }
}
