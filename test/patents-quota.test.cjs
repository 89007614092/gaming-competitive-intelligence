"use strict";

// Patents Phase 2, step one: READ the OPS quota instead of inferring it.
//
// Every scheduling decision for the live landscape depends on the quota WINDOW,
// and "15 per minute" vs "15 per week" imply completely different designs. This
// adds the means to observe it, without changing any behaviour.

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

test("parseThrottlingControl reads the state, rate and window", () => {
  assert.deepStrictEqual(epoOps.parseThrottlingControl("idle (4/hour)"), {
    state: "idle", rate: 4, window: "hour", raw: "idle (4/hour)",
  });
  assert.deepStrictEqual(epoOps.parseThrottlingControl("green (15/minute)"), {
    state: "green", rate: 15, window: "minute", raw: "green (15/minute)",
  });
  // A window we cannot parse still returns the raw header — never lose the truth.
  assert.deepStrictEqual(epoOps.parseThrottlingControl("busy"), {
    state: "busy", rate: null, window: null, raw: "busy",
  });
  assert.strictEqual(epoOps.parseThrottlingControl(""), null);
  assert.strictEqual(epoOps.parseThrottlingControl(null), null);
});

test("the quota window is the number we are actually missing", () => {
  // Guarded by a test so it stays true: the design depends on knowing this.
  const parsed = epoOps.parseThrottlingControl("green (15/week)");
  assert.strictEqual(parsed.window, "week", "the window must be distinguishable");
});

test("the throttle observation is logged as a by-product, not a probe", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "lib", "epoOps.js"), "utf8");
  // A dedicated probe costs a search; a log line costs nothing. Prefer the log.
  assert.ok(/throttling control: \$\{ctl\}/.test(src), "the control must be logged");
  assert.ok(/ctl !== throttlingControl/.test(src), "and only when it changes");
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

test("the quota route reports the parsed window and states its own cost", () => {
  assert.ok(SERVER_JS.includes('app.get("/api/patents/quota"'), "route must exist");
  assert.ok(/parsed: parseThrottlingControl\(/.test(SERVER_JS), "must return the parsed window");
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
