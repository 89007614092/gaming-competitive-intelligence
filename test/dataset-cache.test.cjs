// Step 2b — dataset loader unit tests.
//
// Covers the behaviours the HTTP contract tests can't see:
//   - a known dataset loads and matches a direct parse
//   - an unknown name returns null (never throws)
//   - a missing/corrupt file returns null (never throws)
//   - the cache is tamper-proof: each call returns an isolated clone, so a
//     caller that mutates its copy can never corrupt the shared cache (R2)
//   - an mtime change forces a fresh re-read, so on-disk edits are picked up
//     without a process restart (R1 — fixes the old stale-cache bug)
//
// risks.json is mutated on disk during two of these tests; it is always
// restored (per-test finally + suite after) so the working tree stays clean.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { getDataset, clearDatasetCache } = require("../lib/datasets");

const RISKS_FILE = path.join(__dirname, "..", "data", "risks.json");
let originalRisks = null;

test.before(() => {
  originalRisks = fs.readFileSync(RISKS_FILE, "utf8");
});

test.after(() => {
  if (originalRisks !== null) fs.writeFileSync(RISKS_FILE, originalRisks);
});

test("getDataset returns parsed data matching a direct read", () => {
  clearDatasetCache("risks");
  const d = getDataset("risks");
  assert.ok(d && typeof d === "object");
  assert.deepStrictEqual(d, JSON.parse(originalRisks));
});

test("getDataset returns null for an unknown dataset name", () => {
  assert.strictEqual(getDataset("no-such-dataset"), null);
});

test("getDataset returns null (never throws) on a corrupt file", () => {
  clearDatasetCache("risks");
  fs.writeFileSync(RISKS_FILE, "{ not valid json");
  try {
    assert.strictEqual(getDataset("risks"), null);
  } finally {
    fs.writeFileSync(RISKS_FILE, originalRisks);
  }
});

test("cache is tamper-proof: each call returns an isolated clone", () => {
  clearDatasetCache("risks");
  const snapshot = JSON.stringify(getDataset("risks"));
  const tampered = getDataset("risks");
  tampered.__poison = "x";
  if (Array.isArray(tampered.risks)) tampered.risks.push({ injected: true });
  const again = getDataset("risks");
  // The stored cache was never handed out, so a fresh read is pristine.
  assert.strictEqual(JSON.stringify(again), snapshot);
  assert.ok(!("__poison" in again));
  if (Array.isArray(again.risks)) {
    assert.ok(!again.risks.some((r) => r && r.injected === true));
  }
});

test("mtime change forces a fresh re-read (no stale cache)", () => {
  clearDatasetCache("risks");
  const before = getDataset("risks");
  const parsed = JSON.parse(originalRisks);
  parsed.__mtime_marker = Date.now();
  fs.writeFileSync(RISKS_FILE, JSON.stringify(parsed));
  try {
    const after = getDataset("risks");
    assert.strictEqual(after.__mtime_marker, parsed.__mtime_marker);
    assert.notDeepStrictEqual(after, before);
  } finally {
    fs.writeFileSync(RISKS_FILE, originalRisks);
  }
});

test("clearDatasetCache forces a fresh read on the next call", () => {
  clearDatasetCache("risks");
  const a = getDataset("risks");
  assert.ok(a && typeof a === "object");
  a.__x = 1; // mutate the returned clone
  clearDatasetCache("risks");
  const b = getDataset("risks");
  assert.ok(!("__x" in b)); // pristine after explicit clear
});
