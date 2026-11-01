import { json } from "@/lib/http";
import { ensureWorker } from "@/lib/jobs/worker";

/** Manual worker tick: process all due jobs and wait for them to finish. */
export async function POST() {
  const processed = await ensureWorker().runDue();
  return json({ processed });
}
