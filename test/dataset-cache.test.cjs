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
// IMPORTANT (test isolation): node --test runs test FILES in parallel. This
// suite previously mutated the SHARED real data/risks.json on disk (writing a
// corrupt payload, then restoring). When api-contract.test.cjs hit
// GET /api/risks during that window, getDataset read the corrupt file and the
// contract test 500'd — a flaky, order-dependent failure unrelated to the code
// under test. We now redirect getDataset("risks") to a private, process-unique
// temp file inside data/, so this suite never touches the shared dataset the
// other suites read. The assertions below are unchanged in intent.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const datasetsMod = require("../lib/datasets");
const { getDataset, clearDatasetCache } = datasetsMod;

const DATA_DIR = path.join(__dirname, "..", "data");
const REAL_RISKS_PATH = datasetsMod.DATASET_FILE.risks;
// Process-unique file so concurrent test processes can never collide.
const ISOLATED_NAME = `risks.isolated.${process.pid}.json`;
const RISKS_FILE = path.join(DATA_DIR, ISOLATED_NAME);

// Redirect the "risks" dataset to our isolated file for the whole suite.
// (DATASET_FILE is a shared object but its properties are mutable; this only
// affects THIS test process, so other suites keep using the real file.)
datasetsMod.DATASET_FILE.risks = ISOLATED_NAME;

let originalRisks = null;

test.before(() => {
  // Seed the isolated file with valid content (copied from the real dataset so
  // the "matches a direct read" assertion stays meaningful).
  const seed = fs.readFileSync(path.join(DATA_DIR, REAL_RISKS_PATH), "utf8");
  fs.writeFileSync(RISKS_FILE, seed);
  originalRisks = seed;
});

test.after(() => {
  // Restore the mapping and remove our temp file so the working tree stays clean.
  datasetsMod.DATASET_FILE.risks = REAL_RISKS_PATH;
  try {
    fs.unlinkSync(RISKS_FILE);
  } catch (_) {
    /* already gone */
  }
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
