"use strict";
// Phase 0 — source registry validation + the seeded allowlist.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const {
  validateSourcesData,
  getEnabledSources,
  bySector,
  byLicenseClass,
} = require("../lib/sourceRegistry");

test("validateSourcesData accepts a well-formed list", () => {
  const good = {
    sources: [{
      id: "a", name: "A", type: "rss", endpoint: "https://a.com/feed",
      sectorTags: ["gaming"], licenseClass: "news-fair-use", cadence: "1h",
      enabled: true, trustTier: 2,
    }],
  };
  const r = validateSourcesData(good);
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.errors.length, 0);
});

test("validateSourcesData rejects malformed entries", () => {
  const bad = {
    sources: [
      { id: "a", name: "A", type: "xml", endpoint: "nope", sectorTags: [],
        licenseClass: "bogus", cadence: "", enabled: "yes", trustTier: "x" },
      { id: "a", name: "B", type: "rss", endpoint: "https://b.com",
        sectorTags: ["gaming"], licenseClass: "open", cadence: "1d",
        enabled: true, trustTier: 1 },
    ],
  };
  const r = validateSourcesData(bad);
  assert.strictEqual(r.valid, false);
  // many fields wrong on the first entry, plus a duplicate id on the second.
  assert.ok(r.errors.length >= 6, "expected multiple validation errors: " + r.errors.join("; "));
});

test("validateSourcesData requires a sources array", () => {
  assert.strictEqual(validateSourcesData({}).valid, false);
  assert.strictEqual(validateSourcesData(null).valid, false);
});

// NOTE: the LIVE data/sources.json is the AI-regulation allowlist consumed by the
// running scan (server.js loadSourceRegistry), which uses a different schema
// (domain/terms/category). The Phase-2 governance seed (new schema) is parked at
// data/sources.gaming-phase2.json. We validate THAT here so the test stays
// meaningful without conflicting with the live scan's file.
test("validates the parked gaming governance seed", () => {
  const seedPath = path.join(__dirname, "..", "data", "sources.gaming-phase2.json");
  const data = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const { valid, errors } = validateSourcesData(data);
  assert.ok(valid, "governance seed should satisfy the schema: " + errors.join("; "));
  assert.ok(Array.isArray(data.sources) && data.sources.length >= 5, "seed should contain several curated sources");
  assert.strictEqual(getEnabledSources(data).length, data.sources.length, "all seed sources enabled");
  assert.ok(bySector(data, "gaming").length >= 1, "should map to the gaming sector");
  assert.ok(byLicenseClass(data, "open").length >= 1, "should include at least one open-licensed source");
});
