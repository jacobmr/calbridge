#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { getDb } from "./client.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "migrations");

async function ensureMigrationsTable(db) {
  await db.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
}

async function appliedSet(db) {
  const r = await db.execute("SELECT id FROM schema_migrations");
  return new Set(r.rows.map((row) => row.id));
}

async function listFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

function splitStatements(sql) {
  const stripped = sql
    .replace(/--[^\n]*\n/g, "\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  return stripped
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function applyOne(db, file) {
  const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
  const id = file.replace(/\.sql$/, "");
  const stmts = splitStatements(sql);
  const tx = await db.transaction("write");
  try {
    for (const stmt of stmts) await tx.execute(stmt);
    await tx.execute({
      sql: "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
      args: [id, Date.now()],
    });
    await tx.commit();
  } catch (e) {
    await tx.rollback();
    throw e;
  }
}

export async function migrate({ verbose = true } = {}) {
  const db = getDb();
  await ensureMigrationsTable(db);
  const applied = await appliedSet(db);
  const files = await listFiles();
  let count = 0;
  for (const f of files) {
    const id = f.replace(/\.sql$/, "");
    if (applied.has(id)) continue;
    if (verbose) console.log(`applying ${f}`);
    await applyOne(db, f);
    count++;
  }
  if (verbose)
    console.log(
      count ? `applied ${count} migration(s)` : "no pending migrations",
    );
  return count;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  migrate().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
