import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { MIGRATIONS } from "./schema";

export type DB = DatabaseSync;

export function openDatabase(filename: string): DB {
  if (filename !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON;");
  if (filename !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  migrate(db);
  return db;
}

export function migrate(db: DB): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const applied = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>).map((r) => r.version),
  );
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        m.version,
        m.name,
        new Date().toISOString(),
      );
    });
  }
}

const txDepth = new WeakMap<DB, number>();

/** Run `fn` atomically. Nested calls use savepoints, so inner failures roll back only their part. */
export function transaction<T>(db: DB, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  const sp = `sp_${depth}`;
  db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${sp}`);
  txDepth.set(db, depth + 1);
  try {
    const result = fn();
    db.exec(depth === 0 ? "COMMIT" : `RELEASE ${sp}`);
    return result;
  } catch (err) {
    db.exec(depth === 0 ? "ROLLBACK" : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
    throw err;
  } finally {
    txDepth.set(db, depth);
  }
}

// Reuse one connection across Next.js dev hot reloads.
const globalForDb = globalThis as unknown as { __db?: DB };

export function getDb(): DB {
  if (!globalForDb.__db) {
    globalForDb.__db = openDatabase(process.env.DATABASE_PATH ?? path.join(process.cwd(), "data", "app.db"));
  }
  return globalForDb.__db;
}
