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

function getDataset(name) {
  const file = DATASET_FILE[name];
  if (!file) return null;
  const p = path.join(__dirname, "..", "data", file);
  try {
    const st = fs.statSync(p);
    const cached = datasetCache[name];
    if (cached && cached.mtime === st.mtimeMs) {
      return structuredClone(cached.data);
    }
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    datasetCache[name] = { mtime: st.mtimeMs, data };
    return structuredClone(data);
  } catch {
    return null;
  }
}

// Explicit invalidation. Called by the integrate path after it rewrites a data
// file, so the very next read is guaranteed fresh even if the write's mtime
// lands inside the same millisecond tick as the prior cache entry.
function clearDatasetCache(name) {
  if (name) delete datasetCache[name];
  else for (const k of Object.keys(datasetCache)) delete datasetCache[k];
}

module.exports = { getDataset, clearDatasetCache, DATASET_FILE };
