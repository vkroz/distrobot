import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const db = getDb();
  const row = db.prepare("SELECT MAX(version) AS version FROM schema_migrations").get() as { version: number };
  return NextResponse.json({ ok: true, schemaVersion: row.version });
}
