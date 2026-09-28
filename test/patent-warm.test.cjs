"use strict";

// The governor is a PACER, not a rationer.
//
// Background warming competes with interactive search for the same small budget
// (OPS reported search=green:5). These tests pin the guarantees that keep a
// background job from becoming an outage: never burst, never starve a user,
// never spend on a guess, and never fight the breaker.

const test = require("node:test");
const assert = require("node:assert");
const { createPatentWarmer } = require("../lib/patentWarm.js");

const GREEN_5 =
  "overloaded (images=green:50, inpadoc=green:30, other=green:1000, retrieval=green:50, search=green:5)";

function client(overrides = {}) {
  return {
    status: () => ({
      configured: true,
      circuitOpen: false,
      throttled: false,
      fairUse: false,
      throttlingControl: GREEN_5,
      ...overrides,
    }),
  };
}

function warmer(overrides = {}, opts = {}) {
  const calls = [];
  const w = createPatentWarmer({
    epoClient: client(overrides),
    chips: [{ id: "a", codes: ["A63F13/00"] }, { id: "b", codes: ["G06N3/006"] }],
    enabled: true,
    warm: async (chip) => { calls.push(chip.id); return { count: 1 }; },
    ...opts,
  });
  return { w, calls };
}

test("shipping dark: nothing runs while disabled", async () => {
  const { w, calls } = warmer({}, { enabled: false });
  const r = await w.tick();
  assert.strictEqual(r.ran, false);
  assert.strictEqual(r.reason, "disabled");
  assert.deepStrictEqual(calls, [], "a dark warmer must spend nothing");
});

test("an unknown budget is skipped, not spent", async () => {
  // No header seen yet — we refuse to warm on a guess.
  const { w, calls } = warmer({ throttlingControl: undefined });
  const r = await w.tick();
  assert.strictEqual(r.reason, "unknown");
  assert.deepStrictEqual(calls, []);
});

test("the reserve is kept for interactive search", async () => {
  // rate 5: with a reserve of 5 there is nothing spare, so warming stands down.
  const blocked = warmer({}, { reserve: 5 });
  assert.strictEqual((await blocked.w.tick()).reason, "reserve");
  assert.deepStrictEqual(blocked.calls, []);
  // With a reserve of 2 it may spend.
  const ok = warmer({}, { reserve: 2 });
  assert.strictEqual((await ok.w.tick()).ran, true);
  assert.deepStrictEqual(ok.calls, ["a"]);
});

test("a non-green search service stops warming", async () => {
  const red = warmer({ throttlingControl: "busy (search=red:0)" });
  assert.strictEqual((await red.w.tick()).reason, "red");
  const yellow = warmer({ throttlingControl: "busy (search=yellow:1)" });
  assert.strictEqual((await yellow.w.tick()).reason, "yellow");
});

test("system load is not our allowance — overloaded + search green still warms", async () => {
  // OPS reported "overloaded" while search was green:5. Keying on the leading
  // word would stop work OPS is willing to serve.
  const { w } = warmer();
  assert.strictEqual(w.readBudget().colour, "green");
  assert.strictEqual((await w.tick()).ran, true);
});

test("exactly one search per tick — a burst is impossible by construction", async () => {
  const { w, calls } = warmer();
  await w.tick();
  assert.strictEqual(calls.length, 1, "one tick must mean one search");
  await w.tick();
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls, ["a", "b"], "and it rotates through the chips");
});

test("a second overlapping tick is refused rather than run in parallel", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const calls = [];
  const w = createPatentWarmer({
    epoClient: client(),
    chips: [{ id: "a" }],
    enabled: true,
    warm: async () => { calls.push("a"); await gate; return {}; },
  });
  const first = w.tick();
  const second = await w.tick();
  assert.strictEqual(second.reason, "busy", "must not stack ticks");
  release();
  await first;
  assert.strictEqual(calls.length, 1);
});

test("an error backs off, and the backoff ramps", async () => {
  let t = 0;
  const w = createPatentWarmer({
    epoClient: client(),
    chips: [{ id: "a" }],
    enabled: true,
    now: () => t,
    backoffMs: 1000,
    backoffMaxMs: 8000,
    warm: async () => { const e = new Error("nope"); e.code = "epo_throttled"; throw e; },
  });
  assert.strictEqual((await w.tick()).reason, "epo_throttled");
  // Inside the backoff window: skipped without spending.
  t = 500;
  assert.strictEqual((await w.tick()).reason, "backoff");
  // After it expires we try again — and the next backoff is longer.
  t = 1500;
  await w.tick();
  t = 1900;
  assert.strictEqual((await w.tick()).reason, "backoff", "second backoff is 2s, not 1s");
});

test("a fair-use block and an open breaker stop warming outright", async () => {
  assert.strictEqual((await warmer({ fairUse: true }).w.tick()).reason, "fair-use");
  assert.strictEqual((await warmer({ circuitOpen: true }).w.tick()).reason, "circuit-open");
  assert.strictEqual((await warmer({ throttled: true }).w.tick()).reason, "throttled");
});

test("status reports enough to diagnose a silent warmer", async () => {
  const { w } = warmer();
  await w.tick();
  const s = w.status();
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.warmed, 1);
  assert.strictEqual(s.chips, 2);
  assert.strictEqual(s.reserve, 2);
  assert.ok(s.lastTickAt, "so /healthz can show whether it is alive at all");
  assert.ok(s.lastBudget && s.lastBudget.colour === "green");
});
