"use strict";

// One-off + re-runnable seed of the shared datasets into Supabase (Postgres).
//
//   node scripts/seed-datasets.js          # insert only missing rows
//   node scripts/seed-datasets.js --force  # overwrite existing rows
//
// Requires DATABASE_URL (Supabase direct connection string) in the environment.
// The table is created if it does not yet exist, so no manual SQL is needed.

const fs = require("fs");
const path = require("path");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set — cannot seed.");
  process.exit(1);
}

let pg;
try {
  pg = require("pg");
} catch {
  console.error("pg is not installed. Run `npm install` first.");
  process.exit(1);
}

const { DATASET_FILE } = require("../lib/datasets");

const force = process.argv.includes("--force");
// family: 4 forces IPv4 resolution (Render free-tier has no IPv6 egress,
// and some Supabase hosts resolve to AAAA records).
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5, family: 4 });

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS datasets (
      name       TEXT PRIMARY KEY,
      data       JSONB NOT NULL,
      updated_by TEXT NOT NULL DEFAULT 'seed',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      version    INTEGER NOT NULL DEFAULT 1
    );
  `);

  for (const [name, file] of Object.entries(DATASET_FILE)) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", file), "utf8"));
    if (force) {
      await pool.query(
        `INSERT INTO datasets(name, data, updated_by) VALUES($1, $2::jsonb, 'seed')
         ON CONFLICT (name) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
        [name, JSON.stringify(data)]
      );
    } else {
      await pool.query(
        `INSERT INTO datasets(name, data, updated_by) VALUES($1, $2::jsonb, 'seed')
         ON CONFLICT (name) DO NOTHING`,
        [name, JSON.stringify(data)]
      );
    }
    console.log(`seeded: ${name}`);
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
