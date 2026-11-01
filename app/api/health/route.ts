import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { getWorker } from "@/lib/jobs/worker";

export async function GET() {
  await connection(); // never prerender: reads live DB state
  const db = getDb();
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
  const worker = getWorker();
  // Public endpoint: expose liveness only (no job ids / lease owner).
  const { running, holdsLease, active } = worker.status();
  return Response.json({ ok: true, schemaVersion: row.version, worker: { running, holdsLease, busy: active.length > 0 } });
}
