"use strict";

// EPO's weekly Fair Use cap: what happens when it rejects us.
//
// Observed live: "This request has been rejected due to the violation of Fair
// Use policy" with a 403. Two things made that worse than it needed to be, and
// both are pinned here:
//
//   1. The notice is in the response BODY, never a header. Reading headers only
//      misclassified it, and an auth-flavoured header could send it down the
//      provider-fault path — which feeds the breaker and takes EVERY OPS call
//      down, not just this one.
//   2. It was parked for the ordinary one-hour throttle floor, so we retried
//      straight back into a WEEKLY cap, repeatedly.

const test = require("node:test");
const assert = require("node:assert");
const epoOps = require("../lib/epoOps.js");

const FAIR_USE_BODY = "This request has been rejected due to the violation of Fair Use policy";

function client(rejections) {
  let i = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes("/auth/accesstoken")) {
      return {
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({ access_token: "tok", expires_in: 1200 }),
        text: async () => "",
      };
    }
    const r = rejections[Math.min(i++, rejections.length - 1)];
    return {
      ok: false, status: 403,
      headers: { get: (n) => (r.headers && r.headers[String(n).toLowerCase()]) || null },
      text: async () => r.body || "",
      json: async () => ({}),
    };
  };
  return epoOps.createEpoClient({
    config: { EPO_OPS_KEY: "k", EPO_OPS_SECRET: "s" },
    fetchImpl,
    log: () => {},
  });
}

test("the fair-use notice is detected in the body", () => {
  assert.strictEqual(epoOps.isFairUseRejection({ body: FAIR_USE_BODY }), true);
  assert.strictEqual(epoOps.isFairUseRejection({ body: "violation of fair  use policy" }), true);
  // An ordinary throttle is NOT fair use — it must keep the short cooldown.
  assert.strictEqual(epoOps.isFairUseRejection({ reason: "quota exceeded" }), false);
  assert.strictEqual(epoOps.isFairUseRejection({}), false);
});

test("a fair-use 403 pauses patents without tripping the breaker", async () => {
  const c = client([{ body: FAIR_USE_BODY }]);
  await assert.rejects(
    () => c.searchCql("cpc=/low A63F13/00", { limit: 1 }),
    (e) => e.code === "epo_fair_use",
    "must be reported as fair use, not a generic fault"
  );
  const st = c.status();
  assert.strictEqual(st.fairUse, true, "and visible on /healthz");
  assert.strictEqual(st.circuitOpen, false,
    "fair use must NOT open the breaker — that would kill every OPS call");
  assert.strictEqual(st.failures, 0, "and must not count toward the breaker");
});

test("an auth-flavoured header does not override a fair-use body", async () => {
  // The regression this guards: "not allowed" in a header used to route the
  // rejection to the provider-fault path, feeding the breaker.
  const c = client([{ body: FAIR_USE_BODY, headers: { "x-rejection-reason": "not allowed" } }]);
  await assert.rejects(() => c.searchCql("cpc=/low A63F13/00", { limit: 1 }),
    (e) => e.code === "epo_fair_use");
  assert.strictEqual(c.status().circuitOpen, false, "still must not open the breaker");
  assert.strictEqual(c.status().failures, 0);
});

test("the fair-use latch is longer than the ordinary throttle floor", async () => {
  // The floor is 1 hour; a weekly cap needs a materially longer park.
  const c = client([{ body: FAIR_USE_BODY }]);
  await assert.rejects(() => c.searchCql("cpc=/low A63F13/00", { limit: 1 }));
  const until = new Date(c.status().throttledUntil).getTime();
  assert.ok(until - Date.now() > 2 * 60 * 60 * 1000,
    `expected a multi-hour park, got ${new Date(until).toISOString()}`);
});

test("an ordinary quota 403 is still just a throttle", async () => {
  const c = client([{ body: "quota exceeded", headers: { "x-rejection-reason": "quota exceeded" } }]);
  await assert.rejects(() => c.searchCql("cpc=/low A63F13/00", { limit: 1 }),
    (e) => e.code === "epo_throttled");
  assert.strictEqual(c.status().fairUse, false, "not reported as fair use");
  assert.strictEqual(c.status().circuitOpen, false);
});

test("the user is told what happened, not shown EPO's markup", async () => {
  const c = client([{ body: FAIR_USE_BODY }]);
  let msg = "";
  try { await c.searchCql("cpc=/low A63F13/00", { limit: 1 }); }
  catch (e) { msg = e.message; }
  assert.ok(/fair-use limit reached/i.test(msg), `unhelpful message: ${msg}`);
  assert.ok(!/violation/i.test(msg), "must not echo the provider's raw error page");
  assert.ok(/resumes automatically/i.test(msg), "and should say it is not permanent");
});
