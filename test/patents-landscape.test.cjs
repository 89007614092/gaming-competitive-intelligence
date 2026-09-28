"use strict";

// T1 — technology volume, with the competitor highlight.
//
// The number that must never lie: the competitor figure is a share OF THE
// SAMPLE WE LOOKED AT. "3 of the 10 most recent" is true and checkable;
// "30%" would be a fabrication drawn from ten documents. That invariant is
// enforced in describeChipRow and pinned here.

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

process.env.OPEN_MODEL_API_KEY = "test-key";
process.env.OPEN_MODEL_BASE_URL = "http://localhost:9/v1";
process.env.OPEN_MODEL_NAME = "openai/gpt-oss-120b";

const { describeChipRow } = require("../lib/patentWarm.js");
const srv = require("../server");

const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const SERVER_JS = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const NAMES = new Map([["tencent", "Tencent"], ["netease", "NetEase"]]);
const CHIP = { id: "agents", label: "Virtual worlds & agents", group: "ai" };

test("the competitor figure can never exceed the sample", () => {
  // 3 companies matched but only 2 documents looked at: claiming 3 would be a
  // lie told from a sample of two.
  const row = describeChipRow(CHIP, {
    count: 1240, sampleSize: 2, matched: 3,
    competitors: { tencent: 2, netease: 1 },
  }, NAMES);
  assert.strictEqual(row.matched, 2, "matched is clamped to the sample");
  assert.strictEqual(row.sampleSize, 2);
  assert.strictEqual(row.count, 1240, "the corpus total is separate and unaffected");
});

test("with no sample there is no competitor signal at all", () => {
  // The older count-only cache rows have no sample; they must not imply one.
  const row = describeChipRow(CHIP, { count: 900 }, NAMES);
  assert.strictEqual(row.sampleSize, 0);
  assert.strictEqual(row.matched, 0);
  assert.deepStrictEqual(row.competitors, []);
  assert.strictEqual(row.count, 900, "but the count is still shown");
});

test("a row missing from the cache yields nothing, not a zero", () => {
  assert.strictEqual(describeChipRow(CHIP, null, NAMES), null);
  assert.strictEqual(describeChipRow(CHIP, undefined, NAMES), null);
});

test("competitors are ranked by hits and carry display names", () => {
  const row = describeChipRow(CHIP, {
    count: 5, sampleSize: 10, matched: 3,
    competitors: { netease: 1, tencent: 2 },
  }, NAMES);
  assert.deepStrictEqual(row.competitors.map((c) => c.id), ["tencent", "netease"]);
  assert.strictEqual(row.competitors[0].name, "Tencent");
});

test("GET /api/patents/landscape is gated, and degrades to an empty list", async () => {
  // Gating is asserted on the source because whenAuth is deliberately a no-op
  // with AUTH_ENABLED=0, which is how the suite runs. The behavioural check
  // here is that an unconfigured/unwarmed state answers cleanly rather than
  // throwing or inventing numbers.
  const start = SERVER_JS.indexOf('app.get("/api/patents/landscape"');
  assert.ok(/whenAuth\(requireAuth\)/.test(SERVER_JS.slice(start, start + 120)),
    "route must be session-gated");
  const server = http.createServer(srv.app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/patents/landscape`);
    assert.ok([200, 401, 503].includes(res.status), `unexpected ${res.status}`);
    if (res.status === 200) {
      const json = await res.json();
      assert.strictEqual(json.success, true);
      assert.ok(Array.isArray(json.chips), "chips should be a list even when empty");
      assert.strictEqual(json.attribution, "Data: EPO OPS", "EPO attribution stays");
    }
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("the landscape endpoint reads the cache and makes NO OPS call", () => {
  // 24 chips fetched on page load is exactly the burst the governor exists to
  // prevent, so this route must never search — only read what warming stored.
  const start = SERVER_JS.indexOf('app.get("/api/patents/landscape"');
  assert.ok(start > 0, "route must exist");
  const body = SERVER_JS.slice(start, start + 1200);
  assert.ok(/readPatentCache\(/.test(body), "must read the warm cache");
  assert.ok(!/epoClient\.search|searchCql\(/.test(body), "and must not call OPS itself");
});

test("T1 augments the curated prose instead of replacing it", () => {
  // A filing count cannot express WHAT a company is protecting, so the
  // narrative stays and the numbers sit beside it.
  assert.ok(/landscape\.description/.test(APP_JS), "curated prose must still render");
  assert.ok(/landscape\.sourceNote/.test(APP_JS), "and its source note too");
  assert.ok(/trendsPatentsLive/.test(APP_JS), "with the live block added alongside");
});

test("the competitor figure is labelled as a share of the sample", () => {
  assert.ok(/of the \$\{c\.sampleSize\} most recent/.test(APP_JS),
    "must say 'of the N most recent', not a percentage");
  assert.ok(/not of all filings/.test(APP_JS),
    "and must state explicitly that it is not a share of the corpus");
  assert.ok(/Data: EPO OPS/.test(APP_JS), "EPO attribution stays visible");
});
