"use strict";

// Scan-lane DOUBLE-ACCOUNT fallback (PR #86).
//
// Proves the scan lane can run its primary AND its fallback on two DISTINCT
// Groq accounts (same model name, different API key), so the background scan
// has two independent RPM/quota pools. OPEN_MODEL_NAME_SCAN ===
// OPEN_MODEL_NAME_FALLBACK (same model) but OPEN_MODEL_API_KEY_FALLBACK_SCAN
// differs from OPEN_MODEL_API_KEY_SCAN — which must NOT collapse to a single
// candidate (the old logic did exactly that, killing the double-account trick).

// Configure the model layer BEFORE requiring the module (constants are read at
// load). Two accounts, same gpt-oss-120b model.
process.env.OPEN_MODEL_API_KEY = "acct-a";
process.env.OPEN_MODEL_BASE_URL = "http://localhost:9/v1";
process.env.OPEN_MODEL_NAME = "openai/gpt-oss-120b";
process.env.OPEN_MODEL_NAME_SCAN = "openai/gpt-oss-120b";
process.env.OPEN_MODEL_API_KEY_SCAN = "acct-b";
process.env.OPEN_MODEL_BASE_URL_SCAN = "http://localhost:9/v1";
process.env.OPEN_MODEL_NAME_FALLBACK = "openai/gpt-oss-120b";
process.env.OPEN_MODEL_API_KEY_FALLBACK_SCAN = "acct-a";
process.env.OPEN_MODEL_BASE_URL_FALLBACK_SCAN = "http://localhost:9/v1";

const test = require("node:test");
const assert = require("node:assert");
const engine = require("../summarise-engine");

function makeResponse(status, bodyText, retryAfter) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "retry-after" ? (retryAfter ?? null) : null) },
    json: async () => ({ choices: [{ message: { content: bodyText } }] }),
    text: async () => bodyText,
  };
}

test("double-account: candidates use two distinct keys for the same model", () => {
  const cands = engine.getScanCandidates();
  assert.strictEqual(cands.length, 2, "expected primary + fallback, not collapsed to one");
  assert.strictEqual(cands[0].model, "openai/gpt-oss-120b");
  assert.strictEqual(cands[1].model, "openai/gpt-oss-120b");
  assert.strictEqual(cands[0].apiKey, "acct-b", "primary must use the scan (2nd) account");
  assert.strictEqual(cands[1].apiKey, "acct-a", "fallback must use the distinct Q&A (1st) account");
});

test("double-account: primary 429 falls back to the 2nd account and enriches", async () => {
  const auths = [];
  globalThis.fetch = async (url, opts) => {
    const auth = (opts.headers && opts.headers.Authorization) || "";
    auths.push(auth);
    const m = JSON.parse(opts.body).model;
    if (m === "openai/gpt-oss-120b" && auth === "Bearer acct-b") return makeResponse(429, "throttled");
    return makeResponse(200, "Recovered scan entry [A1].");
  };
  try {
    const out = await engine.runModelChat("sys", "usr", { lane: "scan" });
    assert.strictEqual(out, "Recovered scan entry [A1].");
    assert.deepStrictEqual(auths, ["Bearer acct-b", "Bearer acct-a"]);
  } finally {
    globalThis.fetch = undefined;
  }
});
