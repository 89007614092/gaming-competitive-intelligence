"use strict";

// Read-only pre-flight check: is Supabase's `datasets` table in sync with the
// JSON in git?
//
// Why this exists: once a dataset has a row in `datasets`, lib/datasets.js
// treats it as STICKY and authoritative — the on-disk JSON is never consulted
// again. So if the seeded row has drifted behind the repo, the live app is
// silently serving an older knowledge base. This reports that before we write
// anything.
//
//   node scripts/check-datasets.js           # compare DB vs repo
//   node scripts/check-datasets.js --local   # just print the repo baseline (no DB)
//
// Exit codes: 0 = in sync / no DB rows, 1 = drift detected (safe for scripting).

const fs = require("fs");
const path = require("path");

const { DATASET_FILE } = require("../lib/datasets");

// Entry counts per dataset shape. Must mirror the SQL CASE in the query below.
function countLocal(name, data) {
  if (Array.isArray(data.events)) return data.events.length;          // regulatory-timeline
  if (Array.isArray(data.patterns)) return data.patterns.length;      // current-use-cases
  if (data.categories && typeof data.categories === "object") {       // knowledge
    return Object.values(data.categories)
      .reduce((sum, cat) => sum + ((cat && cat.subsections) || []).length, 0);
  }
  return null;
}

function localBaselines() {
  const out = {};
  for (const [name, file] of Object.entries(DATASET_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", file), "utf8"));
      out[name] = countLocal(name, data);
    } catch (_) {
      out[name] = null;
    }
  }
  return out;
}

if (process.argv.includes("--local")) {
  console.log("Repo (git) baseline — no database contacted:\n");
  for (const [name, n] of Object.entries(localBaselines())) {
    console.log(`  ${name.padEnd(22)} ${n === null ? "-" : n}`);
  }
  process.exit(0);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set — cannot check. (Try `--local` for the repo baseline.)");
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

// Same shape logic as countLocal, expressed in SQL.
const SQL = `
  SELECT name,
         CASE name
           WHEN 'knowledge'           THEN (SELECT sum(jsonb_array_length(value->'subsections'))
                                            FROM jsonb_each(data->'categories'))
           WHEN 'regulatory-timeline' THEN jsonb_array_length(data->'events')
           WHEN 'current-use-cases'   THEN jsonb_array_length(data->'patterns')
         END AS entry_count,
         version, updated_by, updated_at
  FROM datasets
  ORDER BY name
`;

async function main() {
  let rows = [];
  try {
    const res = await pool.query(SQL);
    rows = res.rows;
  } catch (e) {
    console.error("Could not read `datasets` — has scripts/seed-datasets.js been run?");
    console.error("  " + e.message);
    await pool.end();
    process.exit(1);
  }
  await pool.end();

  const local = localBaselines();
  const byName = new Map(rows.map(r => [r.name, r]));

  console.log("\nDataset sync check (Supabase vs git)\n");
  console.log("  " + "dataset".padEnd(22) + "db".padEnd(8) + "repo".padEnd(8) + "status");
  console.log("  " + "-".repeat(58));

  let drift = 0;
  for (const [name, repoCount] of Object.entries(local)) {
    const row = byName.get(name);
    if (!row) {
      console.log(`  ${name.padEnd(22)}${"-".padEnd(8)}${String(repoCount ?? "-").padEnd(8)}NO DB ROW (disk-backed)`);
      continue;
    }
    const dbCount = row.entry_count;
    const comparable = repoCount !== null && dbCount !== null;
    const ok = comparable && dbCount === repoCount;
    if (comparable && !ok) drift += 1;
    const status = !comparable ? "not counted"
      : ok ? "in sync"
      : (dbCount < repoCount ? "DB STALE (behind repo)" : "DB AHEAD (has extra)");
    console.log(`  ${name.padEnd(22)}${String(dbCount ?? "-").padEnd(8)}${String(repoCount ?? "-").padEnd(8)}${status}`);
  }

  console.log("");
  if (drift) {
    console.log(`  ${drift} dataset(s) out of sync. Re-sync with:`);
    console.log("    node scripts/seed-datasets.js --force     # DB <- repo (overwrites DB rows)");
    console.log("  Back up first: node scripts/backup-datasets.js");
    process.exit(1);
  }
  console.log("  All comparable datasets are in sync.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
