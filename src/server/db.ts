import { Database } from "bun:sqlite";
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const MIGRATIONS_FOLDER = join(import.meta.dir, "../../drizzle");

export function openDatabase(path: string): Database {
  if (path !== ":memory:" && !path.startsWith("file::memory:")) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const raw = new Database(path, { create: true });
  raw.exec("PRAGMA foreign_keys = ON;");
  raw.exec("PRAGMA journal_mode = WAL;");
  raw.exec("PRAGMA busy_timeout = 5000;");
  return raw;
}

export function createDb(path: string) {
  if (!existsSync(MIGRATIONS_FOLDER)) {
    throw new Error(
      `Missing migrations folder at ${MIGRATIONS_FOLDER}. Run \`bun run db:generate\` first.`,
    );
  }
  const raw = openDatabase(path);
  const db = drizzle({ client: raw });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return db;
}

export type AppDb = SQLiteBunDatabase;
