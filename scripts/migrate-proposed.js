"use strict";

// One-off + re-runnable migration that creates the `proposed_changes` table
// backing the Suggested-Updates durable store (Leg 2).
//
//   node scripts/migrate-proposed.js
//
// Requires DATABASE_URL (Supabase connection string) in the environment.
// The table is created if it does not yet exist (CREATE TABLE IF NOT EXISTS).
// Idempotent: safe to run repeatedly. On first run, if data/proposed-changes.json
// exists it is seeded into the store row so already-identified proposals are
// not lost when the app switches from disk to Supabase.

const fs = require("fs");
const path = require("path");
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
    CREATE TABLE IF NOT EXISTS proposed_changes (
      id           TEXT PRIMARY KEY,
      data         JSONB NOT NULL,
      status       TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  console.log("proposed_changes table ready.");

  // Seed from the existing on-disk store (if present) without clobbering a
  // row that may already exist from a previous migration/run.
  const file = path.join(__dirname, "..", "data", "proposed-changes.json");
  if (fs.existsSync(file)) {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      if (data && Array.isArray(data.items) && data.items.length) {
        await pool.query(
          `INSERT INTO proposed_changes (id, data, status, updated_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO NOTHING`,
          ["__store", JSON.stringify(data), "store"]
        );
        console.log(`Seeded ${data.items.length} proposed item(s) from disk.`);
      }
    } catch (e) {
      console.warn("Seed from disk skipped:", e.message);
    }
  }
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
