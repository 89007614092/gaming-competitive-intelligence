// Phase 3 retention policy — pure unit tests against lib/retention.js.
const test = require("node:test");
const assert = require("node:assert/strict");
const retention = require("../lib/retention");
const { computeRetentionState, rollToExcerpt, RETENTION_WINDOWS } = retention;

const DAY = retention.DAY_MS;
const YEAR = retention.YEAR_MS;
const NOW = Date.parse("2026-08-14T00:00:00Z");

function item(over = {}) {
  return { id: "x1", retentionClass: "regulatory", ingestedAt: new Date(NOW).toISOString(), ...over };
}

test("regulatory item stays full within 3 years, then purged", () => {
  const i = item();
  assert.equal(computeRetentionState(i, NOW), "full");
  assert.equal(computeRetentionState(i, NOW + 3 * YEAR - DAY), "full");
  assert.equal(computeRetentionState(i, NOW + 3 * YEAR + DAY), "purged");
});

test("use-case item stays full within 180 days, then rolls to excerpt", () => {
  const i = item({ retentionClass: "use-case" });
  assert.equal(computeRetentionState(i, NOW), "full");
  assert.equal(computeRetentionState(i, NOW + 180 * DAY - DAY), "full");
  assert.equal(computeRetentionState(i, NOW + 180 * DAY + DAY), "excerpt");
});

test("unknown class falls back to the default window (3y -> purge)", () => {
  const i = item({ retentionClass: "mystery" });
  assert.equal(computeRetentionState(i, NOW), "full");
  assert.equal(computeRetentionState(i, NOW + 3 * YEAR + DAY), "purged");
});

test("legal-hold id is never purged or rolled, regardless of age", () => {
  const i = item({ id: "hold-1", retentionClass: "regulatory" });
  const old = NOW + 10 * YEAR;
  assert.equal(computeRetentionState(i, old, ["hold-1"]), "full");
  const uc = item({ id: "hold-2", retentionClass: "use-case" });
  assert.equal(computeRetentionState(uc, old, ["hold-2"]), "full");
  // A different id is not covered by the hold.
  assert.equal(computeRetentionState(i, old, ["other"]), "purged");
});

test("missing ingest time defaults to full (safe keep, not delete)", () => {
  const i = item({ ingestedAt: undefined });
  assert.equal(computeRetentionState(i, NOW + 100 * YEAR), "full");
});

test("rollToExcerpt truncates long text to ~300 words with an ellipsis", () => {
  const long = Array.from({ length: 500 }, (_, n) => `word${n}`).join(" ");
  const out = rollToExcerpt(long, 300);
  assert.ok(out.endsWith("…"), "should end with ellipsis");
  assert.ok(out.split(/\s+/).length <= 301, "should be ~300 words");
});

test("rollToExcerpt leaves short text untouched", () => {
  const short = "Just a short summary that should not be cut.";
  assert.equal(rollToExcerpt(short, 300), short);
});

test("windows are defined for both Lane A classes", () => {
  assert.ok(RETENTION_WINDOWS.regulatory);
  assert.ok(RETENTION_WINDOWS["use-case"]);
  assert.equal(RETENTION_WINDOWS.regulatory.roll, "purge");
  assert.equal(RETENTION_WINDOWS["use-case"].roll, "excerpt");
});
