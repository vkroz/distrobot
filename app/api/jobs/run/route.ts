import { json } from "@/lib/http";
import { ensureWorker } from "@/lib/jobs/worker";

/** Manual worker tick: process all due jobs and wait for them to finish. */
export async function POST() {
  const worker = ensureWorker();
  if (!worker.active) {
    return json(
      { processed: [], error: "Another process holds the worker lease; it will process the jobs.", worker: worker.status() },
      409,
    );
  }
  const processed = await worker.runDue();
  return json({ processed });
}
