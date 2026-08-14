// Regression guard for the AI-regulation live scan (PR #35 class of bug).
//
// The live "Suggested Updates" engine (runSourceScan -> fetchSourceItems ->
// classifyItem) consumes data/sources.json with an AI-regulation schema that is
// INCOMPATIBLE with the Phase 0/1 governance seed (data/sources.gaming-phase2.json).
// PR #35 overwrote data/sources.json with the gaming schema, which dropped every
// AI-regulation item and emptied Suggested Updates. This test fails loudly if the
// two schemas ever collide onto one file again.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const AI_REG_PATH = path.join(DATA_DIR, "sources.json");
const GAMING_PATH = path.join(DATA_DIR, "sources.gaming-phase2.json");

const AI_REG_CATEGORIES = new Set(["regulation", "use-case", "academic"]);
const GOV_TYPES = new Set(["rss", "api", "html"]);

function load(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// AI-regulation fields the live crawler actually needs (every Google News query
// is built as `site:<domain> <terms>`). If any of these are missing the scan
// silently produces zero items.
const AI_REG_REQUIRED = ["id", "name", "domain", "terms", "category", "ttlMinutes", "freshness"];
// Governance-only fields that must NEVER appear in the AI-reg file.
const GOV_ONLY = ["type", "endpoint", "sectorTags", "licenseClass", "cadence", "trustTier", "enabled"];
// AI-reg-only fields that must NEVER appear in the gaming file.
const AI_REG_ONLY = ["domain", "terms", "jurisdiction", "ttlMinutes", "freshness", "language"];

test("AI-regulation source file keeps the schema the live scan consumes", () => {
  const doc = load(AI_REG_PATH);
  assert.ok(Array.isArray(doc.sources) && doc.sources.length > 0, "sources array missing/empty");
  for (const s of doc.sources) {
    for (const f of AI_REG_REQUIRED) {
      const v = s[f];
      if (f === "ttlMinutes") assert.ok(typeof v === "number", `source ${s.id} missing numeric ${f}`);
      else assert.ok(v !== undefined && v !== null && v !== "", `source ${s.id} missing ${f}`);
    }
    assert.ok(AI_REG_CATEGORIES.has(s.category), `source ${s.id} invalid category ${s.category}`);
    for (const g of GOV_ONLY) {
      assert.ok(!(g in s), `source ${s.id} carries governance '${g}' — PR #35 collision`);
    }
  }
});

test("gaming seed stays on the governance schema at a separate path", () => {
  const doc = load(GAMING_PATH);
  assert.ok(Array.isArray(doc.sources) && doc.sources.length > 0, "gaming sources empty");
  assert.notStrictEqual(
    path.basename(AI_REG_PATH),
    path.basename(GAMING_PATH),
    "the two source files must never share a path",
  );
  for (const s of doc.sources) {
    assert.ok(s.id && typeof s.id === "string");
    assert.ok(s.name && typeof s.name === "string");
    assert.ok(GOV_TYPES.has(s.type), `gaming source ${s.id} invalid type ${s.type}`);
    assert.ok(s.endpoint && typeof s.endpoint === "string");
    assert.ok(Array.isArray(s.sectorTags) && s.sectorTags.length > 0, `gaming source ${s.id} missing sectorTags`);
    assert.ok(typeof s.licenseClass === "string");
    assert.ok(typeof s.cadence === "string");
    assert.strictEqual(typeof s.enabled, "boolean", `gaming source ${s.id} enabled must be boolean`);
    assert.ok(typeof s.trustTier === "number", `gaming source ${s.id} missing numeric trustTier`);
    for (const a of AI_REG_ONLY) {
      assert.ok(!(a in s), `gaming source ${s.id} carries AI-reg '${a}' — would break live scan if merged`);
    }
  }
});

test("AI-regulation and gaming sources never collapse onto one schema", () => {
  const ai = load(AI_REG_PATH);
  const game = load(GAMING_PATH);
  assert.ok(!ai.sources.some((s) => "type" in s), "AI-reg file leaked governance 'type'");
  assert.ok(!game.sources.some((s) => "domain" in s), "gaming file leaked AI-reg 'domain'");
  // The descriptions should make the intended split explicit.
  assert.match(JSON.stringify(ai.description || ""), /AI-?regulation/i, "AI-reg file should describe AI regulation");
});
