import { connection } from "next/server";
import { listAdapters } from "@/lib/adapters";
import { getDb } from "@/lib/db";
import { json } from "@/lib/http";
import { dryRunModeFromEnv } from "@/lib/jobs/runner";
import { platformStatuses } from "@/lib/services/posts";

/** Per-platform configuration status and connected accounts (no secrets). */
export async function GET() {
  await connection();
  const mode = dryRunModeFromEnv();
  return json({ dryRunMode: mode, platforms: platformStatuses(getDb(), listAdapters(), mode) });
}
