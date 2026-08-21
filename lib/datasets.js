// Centralised dataset loader.
//
// Every GET /api/* dataset handler and the scan's buildExistingIndex used to
// hand-roll its own `let xCache = null` + lazy readFileSync block. That
// duplicated the load logic 8 times AND had a latent bug: once a cache was
// populated it NEVER refreshed on a disk edit (the 3 integrated datasets,
// timeline/knowledge/use-cases, were only invalidated by a manual null-assignment
// after an integrate write; the other 5 never refreshed until a process restart).
//
// This module collapses all of that into one mtime-keyed cache. getDataset:
//   - returns the parsed data, or null for an unknown name / missing / corrupt file
//     (never throws — callers already guard on null);
//   - re-reads automatically when the file's mtime changes (fixes the stale-cache
//     bug for the 5 static datasets, and backs up the manual integrate invalidation);
//   - returns a structuredClone so a caller can never mutate the cached original.

const fs = require("fs");
const path = require("path");

// Canonical dataset name -> data file. Keep in sync with the GET routes below.
const DATASET_FILE = {
  knowledge: "knowledge.json",
  network: "network.json",
  "tencent-products": "tencent-products.json",
  "current-use-cases": "current-use-cases.json",
  "gaming-trends": "gaming-trends.json",
  "regulatory-timeline": "regulatory-timeline.json",
  risks: "risks.json",
  "company-locations": "company-locations.json",
};

const datasetCache = Object.create(null);
let _dbPool = null;

function getDataset(name) {
  const file = DATASET_FILE[name];
  if (!file) return null;
  const cached = datasetCache[name];
  // DB-backed entries are authoritative and STICKY: they are never overwritten
  // by a disk re-read, because the on-disk file is only a fallback seed (it may
  // be stale after a PUT). Disk-backed entries refresh when the file's mtime
  // changes, so on-disk edits made by the integrate path are still picked up.
  if (cached && cached.source === "db") {
    return structuredClone(cached.data);
  }
  const p = path.join(__dirname, "..", "data", file);
  try {
    const st = fs.statSync(p);
    if (cached && cached.source === "disk" && cached.mtime === st.mtimeMs) {
      return structuredClone(cached.data);
    }
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    datasetCache[name] = { mtime: st.mtimeMs, source: "disk", data };
    return structuredClone(data);
  } catch {
    return null;
  }
}

// Explicit invalidation. Called by the integrate path after it rewrites a data
// file, so the very next read is guaranteed fresh even if the write's mtime
// lands inside the same millisecond tick as the prior cache entry. Drops the
// entry entirely so the next read re-reads disk (source becomes "disk").
function clearDatasetCache(name) {
  if (name) delete datasetCache[name];
  else for (const k of Object.keys(datasetCache)) delete datasetCache[k];
}

// Set a DB-authored value directly (used after a PUT). Sticky + db-backed so a
// later disk read can never shadow a successful database write.
function setDatasetCache(name, data) {
  datasetCache[name] = { mtime: Date.now(), source: "db", data: structuredClone(data) };
}

// Inject the server's pg.Pool (optionally null when DB is unavailable).
function attachDb(pool) { _dbPool = pool; }

// Shared accessor so sibling libs (e.g. lib/sources.js) can reach the same
// pool the server attached at boot. Returns null when no pool is attached
// (DB unconfigured) — callers degrade gracefully.
function getDbPool() { return _dbPool; }

// Load all rows into the cache at boot. Throws on error so the caller can log
// and fall back to disk. Each row is db-backed + sticky.
async function primeDatasetCacheFromDb() {
  if (!_dbPool) return;
  const { rows } = await _dbPool.query("SELECT name, data FROM datasets");
  for (const r of rows) {
    datasetCache[r.name] = { mtime: Date.now(), source: "db", data: r.data };
  }
}

module.exports = { getDataset, clearDatasetCache, setDatasetCache, attachDb, getDbPool, primeDatasetCacheFromDb, DATASET_FILE };
