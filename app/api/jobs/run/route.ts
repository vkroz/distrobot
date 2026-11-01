import { json } from "@/lib/http";
import { ensureWorker } from "@/lib/jobs/worker";

/** Manual worker tick: process all due jobs and wait for them to finish. */
export async function POST() {
  const worker = ensureWorker();
  const processed = await worker.runDueExclusive();
  if (processed === null) {
    return json({ processed: [], error: "Another process holds the worker lease; it will process the jobs." }, 409);
  }
  return json({ processed });
}
