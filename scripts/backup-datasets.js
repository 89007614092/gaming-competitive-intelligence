"use strict";

// Snapshot every row of `datasets` into `datasets_backups`, inside Supabase.
//
// Why inside the database rather than a file: Render's disk is ephemeral, so a
// copy written there dies with the container. Keeping the snapshot in Postgres
// makes it durable and restorable with a single UPDATE, and needs no local
// tooling (no pg_dump, no egress).
//
//   node scripts/backup-datasets.js
//   node scripts/backup-datasets.js --note "before durable integrate"
//
// Re-runnable: each run appends a new snapshot; nothing is ever overwritten.

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set — cannot back up.");
  process.exit(1);
}

let pg;
try {
  pg = require("pg");
} catch {
  console.error("pg is not installed. Run `npm install` first.");
  process.exit(1);
}

const { makePool } = require("../lib/dbPool");
const pool = makePool(pg, DATABASE_URL, { max: 5 });

const noteArg = process.argv.indexOf("--note");
const NOTE = noteArg !== -1 && process.argv[noteArg + 1]
  ? process.argv[noteArg + 1]
  : `manual-${new Date().toISOString().slice(0, 10)}`;

async function main() {
  // Idempotent: safe whether or not the table already exists.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS datasets_backups (
      id                BIGSERIAL PRIMARY KEY,
      name              TEXT NOT NULL,
      data              JSONB NOT NULL,
      updated_by        TEXT,
      version           INTEGER,
      source_updated_at TIMESTAMPTZ,
      snapshot_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      note              TEXT
    );
  `);

  const { rows: existing } = await pool.query("SELECT count(*)::int AS n FROM datasets");
  if (!existing[0].n) {
    console.error("`datasets` is empty — nothing to back up.");
    await pool.end();
    process.exit(1);
  }

  await pool.query(
    `INSERT INTO datasets_backups (name, data, updated_by, version, source_updated_at, note)
     SELECT name, data, updated_by, version, updated_at, $1 FROM datasets`,
    [NOTE]
  );

  const { rows } = await pool.query(
    `SELECT name, version, snapshot_at FROM datasets_backups WHERE note = $1 ORDER BY id`,
    [NOTE]
  );

  console.log(`\nBacked up ${rows.length} dataset(s) with note "${NOTE}":\n`);
  for (const r of rows) {
    console.log(`  ${r.name.padEnd(22)} v${r.version}  ${r.snapshot_at.toISOString()}`);
  }
  console.log("\nRestore with (adjust the note to match):");
  console.log(`  UPDATE datasets d SET data = b.data, updated_by = b.updated_by,`);
  console.log(`         version = b.version, updated_at = now()`);
  console.log(`  FROM datasets_backups b WHERE d.name = b.name AND b.note = '${NOTE}';`);

  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
