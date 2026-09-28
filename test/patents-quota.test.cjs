"use strict";

// Patents Phase 2, step one: READ the OPS quota instead of inferring it.
//
// Every scheduling decision for the live landscape depends on the quota, and
// until we had read a real header we were guessing both its size and its shape.
// Production has now told us the shape, and it was not the one we assumed.

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

process.env.OPEN_MODEL_API_KEY = "test-key";
process.env.OPEN_MODEL_BASE_URL = "http://localhost:9/v1";
process.env.OPEN_MODEL_NAME = "openai/gpt-oss-120b";

const epoOps = require("../lib/epoOps.js");
const srv = require("../server");

const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const SERVER_JS = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const EPO_SRC = fs.readFileSync(path.join(__dirname, "..", "lib", "epoOps.js"), "utf8");

// The header OPS actually returned in production. Kept verbatim as a fixture so
// the parser is tested against reality, not against our assumption about it.
const REAL =
  "overloaded (images=green:50, inpadoc=green:30, other=green:1000, retrieval=green:50, search=green:5)";

test("parseThrottlingControl reads the per-service shape OPS actually sends", () => {
  const p = epoOps.parseThrottlingControl(REAL);
  assert.strictEqual(p.system, "overloaded");
  assert.deepStrictEqual(p.services.search, { colour: "green", rate: 5 });
  assert.deepStrictEqual(p.services.inpadoc, { colour: "green", rate: 30 });
  // Every service is parsed separately — they are independent budgets.
  assert.deepStrictEqual(Object.keys(p.services).sort(), [
    "images", "inpadoc", "other", "retrieval", "search",
  ]);
  assert.strictEqual(p.raw, REAL, "the raw header is never lost");
});

test("the system word is NOT the allowance: overloaded + search green is usable", () => {
  // The trap this guards: OPS reported "overloaded" while search was green with 5
  // left. A governor keyed on the leading word would stop work that OPS is
  // perfectly willing to serve, so the services must be read individually.
  const p = epoOps.parseThrottlingControl(REAL);
  assert.strictEqual(p.system, "overloaded");
  assert.strictEqual(p.search.colour, "green");
  assert.strictEqual(epoOps.searchBudget(REAL).allowed, true);
});

test("a single red service is obeyed while the rest stay green", () => {
  const h = "busy (images=green:50, inpadoc=red:0, other=green:1000, retrieval=green:50, search=green:5)";
  const p = epoOps.parseThrottlingControl(h);
  assert.strictEqual(p.services.inpadoc.colour, "red");
  assert.strictEqual(p.services.search.colour, "green");
  // And when it is search itself that goes red, spending must stop.
  const red = epoOps.parseThrottlingControl("busy (search=red:0)");
  assert.strictEqual(epoOps.searchBudget(red.raw).allowed, false);
  assert.strictEqual(epoOps.searchBudget(red.raw).reason, "red");
});

test("searchBudget enforces the reserve so warming never starves a user", () => {
  // rate 5: with a reserve of 2 the warmer may spend, but with a reserve of 5 it
  // may not — the reserve is what is kept back for interactive search.
  assert.strictEqual(epoOps.searchBudget(REAL, 2).allowed, true);
  assert.strictEqual(epoOps.searchBudget(REAL, 5).allowed, false);
  assert.strictEqual(epoOps.searchBudget(REAL, 5).reason, "reserve");
});

test("an unknown budget is not an allowed budget", () => {
  // If we have never seen a header we must not let a warmer spend on a guess.
  assert.strictEqual(epoOps.searchBudget(null).allowed, false);
  assert.strictEqual(epoOps.searchBudget(null).reason, "unknown");
  assert.strictEqual(epoOps.searchBudget("").allowed, false);
});

test("the legacy rate/window shape still parses", () => {
  assert.deepStrictEqual(epoOps.parseThrottlingControl("idle (4/hour)"), {
    system: "idle", services: {}, search: null, raw: "idle (4/hour)", rate: 4, window: "hour",
  });
  const weekly = epoOps.parseThrottlingControl("green (15/week)");
  assert.strictEqual(weekly.window, "week", "the window must remain distinguishable");
  // A header with no parentheses still returns the raw string.
  assert.strictEqual(epoOps.parseThrottlingControl("busy").system, "busy");
  assert.strictEqual(epoOps.parseThrottlingControl(""), null);
  assert.strictEqual(epoOps.parseThrottlingControl(null), null);
});

test("the throttle observation is logged as a by-product, not a probe", () => {
  // A dedicated probe costs a search; a log line costs nothing. Prefer the log.
  assert.ok(/throttling control: \$\{ctl\}/.test(EPO_SRC), "the control must be logged");
  assert.ok(/ctl !== throttlingControl/.test(EPO_SRC), "and only when it changes");
});

test("GET /api/patents/quota exists and is session-gated", async () => {
  const server = http.createServer(srv.app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/patents/quota`);
    // Without a session it must not leak anything: 401 (no session) or 503 (not
    // configured) are both correct; 200 with data would be wrong.
    assert.ok(res.status === 401 || res.status === 503, `expected 401/503, got ${res.status}`);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

test("the quota route reports the parsed budget and states its own cost", () => {
  assert.ok(SERVER_JS.includes('app.get("/api/patents/quota"'), "route must exist");
  assert.ok(/parsed: parseThrottlingControl\(/.test(SERVER_JS), "must return the parsed header");
  assert.ok(/budget: searchBudget\(/.test(SERVER_JS), "must return the spendable budget");
  assert.ok(/costNote/.test(SERVER_JS), "must disclose that the call costs a search");
  // It must not be reachable anonymously — this is an OPS-spending endpoint.
  assert.ok(/whenAuth\(requireAuth\)/.test(SERVER_JS), "and must be session-gated");
});

test("the curated landscape companies are already tracked (no data change needed)", () => {
  // Recorded as a test so the next person does not re-add them. A literal name
  // comparison misses these: "Take-Two / Rockstar Games" vs "Rockstar Games /
  // Take-Two Interactive".
  const net = require("../data/network.json");
  const byId = new Map(net.competitors.map((c) => [c.id, c.name]));
  assert.ok(byId.has("activision-blizzard"), "Activision Blizzard is already tracked");
  assert.ok(byId.has("take-two"), "Take-Two / Rockstar Games is already tracked");
});

test("still no scheduling — measurement only", () => {
  // Step one must not start warming anything. No new timers in this change.
  assert.ok(!/landscapeWarm|warmPatents|PATENT_CRON/.test(SERVER_JS),
    "no warming scheduler yet — that is the next PR, after we know the quota");
  void APP_JS;
});
