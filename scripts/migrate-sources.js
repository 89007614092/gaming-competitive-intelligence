"use strict";

// One-off + re-runnable migration that creates the `sources` table backing
// Thread D (shared, team-side ingestion: watch-URL + report-upload).
//
//   node scripts/migrate-sources.js
//
// Requires DATABASE_URL (Supabase connection string) in the environment.
// The table is created if it does not yet exist, so no manual SQL is needed.
// Idempotent: safe to run repeatedly (CREATE TABLE IF NOT EXISTS only).

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set — cannot migrate.");
  process.exit(1);
}

let pg;
try {
  pg = require("pg");
} catch {
  console.error("pg is not installed. Run `npm install` first.");
  process.exit(1);
}

// family: 4 forces IPv4 resolution (Render free-tier has no IPv6 egress, and
// some Supabase hosts resolve to AAAA records).
const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5, family: 4 });

async function main() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      url           TEXT,
      title         TEXT,
      added_by      TEXT,
      added_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_fetched  TIMESTAMPTZ,
      content_hash  TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      content       TEXT,
      citation_id   TEXT,
      citations     JSONB
    );
  `);
  console.log("sources table ready.");
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
