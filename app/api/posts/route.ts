import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { errorJson, json } from "@/lib/http";
import { ensureWorker } from "@/lib/jobs/worker";
import { ComposeError, composePost, listPostSummaries, parseComposeInput } from "@/lib/services/posts";

/** List recent posts with targets and their latest job. */
export async function GET() {
  await connection();
  ensureWorker();
  return json({ posts: listPostSummaries(getDb()) });
}

/** Create a post (+targets) and, for action=publish, enqueue jobs. See ComposeInput. */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return errorJson("Invalid JSON", 400);
  }
  try {
    const result = composePost(getDb(), parseComposeInput(body));
    if (result.jobs.length > 0) ensureWorker().kick();
    return json(result, 201);
  } catch (err) {
    if (err instanceof ComposeError) return errorJson(err.message, err.status, { validation: err.validation });
    throw err;
  }
}
