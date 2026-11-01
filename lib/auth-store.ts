import { getDb, type DB } from "@/lib/db";

/**
 * Server-side session revocation for the stateless session cookie: logout records the time, and
 * any session issued before it is rejected. Single admin → logout signs out every device.
 */
const KEY = "sessions_valid_after";

export function sessionsValidAfter(db: DB = getDb()): number {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(KEY) as { value: string } | undefined;
    return row ? Number(row.value) || 0 : 0;
  } catch {
    return 0;
  }
}

export function revokeAllSessions(db: DB = getDb(), now = Date.now()): void {
  db.prepare(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(KEY, String(now));
}
