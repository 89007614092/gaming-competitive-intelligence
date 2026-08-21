"use strict";

// Thread #1 — same-account Groq two-model QA failover.
//
// Exercises postQaChatCompletions directly (the shared helper that both Q&A
// call sites route through). The failover model must ONLY be contacted when
// the primary fails; a short 429 throttle is waited out on the SAME model; and
// a daily-cap 429 sets the lane cooldown so a follow-up Q&A call is rejected
// fast instead of burning quota.

// Configure the model layer BEFORE requiring the module (constants are read at
// load). Same account, same key — only the model name differs.
process.env.OPEN_MODEL_API_KEY = "test-key";
process.env.OPEN_MODEL_BASE_URL = "http://localhost:9/v1";
process.env.OPEN_MODEL_NAME = "openai/gpt-oss-120b";
process.env.OPEN_MODEL_NAME_FALLBACK = "qwen/qwen3-32b";

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

test("failover enabled flag reflects the env model", () => {
  assert.strictEqual(engine.QA_FAILOVER_ENABLED, true);
  assert.strictEqual(engine.OPEN_MODEL_NAME_FALLBACK, "qwen/qwen3-32b");
});

test("primary success never contacts the fallback", async () => {
  const models = [];
  globalThis.fetch = async (url, opts) => {
    models.push(JSON.parse(opts.body).model);
    return makeResponse(200, "Primary answer [A1].");
  };
  try {
    const { content, model } = await engine.postQaChatCompletions({ body: { messages: [] } });
    assert.strictEqual(content, "Primary answer [A1].");
    assert.strictEqual(model, "openai/gpt-oss-120b");
    assert.deepStrictEqual(models, ["openai/gpt-oss-120b"]);
  } finally {
    globalThis.fetch = undefined;
  }
});

test("primary failure falls through to the fallback model", async () => {
  const models = [];
  let first = true;
  globalThis.fetch = async (url, opts) => {
    models.push(JSON.parse(opts.body).model);
    if (first) { first = false; throw new Error("network down"); }
    return makeResponse(200, "Fallback answer [A1].");
  };
  try {
    const { content, model } = await engine.postQaChatCompletions({ body: { messages: [] } });
    assert.strictEqual(content, "Fallback answer [A1].");
    assert.strictEqual(model, "qwen/qwen3-32b");
    assert.deepStrictEqual(models, ["openai/gpt-oss-120b", "qwen/qwen3-32b"]);
  } finally {
    globalThis.fetch = undefined;
  }
});

test("both models fail throws (server.js extractive fallback engages)", async () => {
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    await assert.rejects(() => engine.postQaChatCompletions({ body: { messages: [] } }), /All Q&A models failed|network down/);
  } finally {
    globalThis.fetch = undefined;
  }
});

test("short 429 throttle is waited out on the SAME model (no premature switch)", async () => {
  const models = [];
  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    models.push(JSON.parse(opts.body).model);
    calls += 1;
    if (calls === 1) return makeResponse(429, "slow down", "1"); // 1s retry-after
    return makeResponse(200, "Recovered [A1].");
  };
  try {
    const { content } = await engine.postQaChatCompletions({ body: { messages: [] } });
    assert.strictEqual(content, "Recovered [A1].");
    // Still only the primary model; fallback never contacted.
    assert.deepStrictEqual(models, ["openai/gpt-oss-120b", "openai/gpt-oss-120b"]);
  } finally {
    globalThis.fetch = undefined;
  }
});

test("daily-cap 429 sets the lane cooldown (follow-up Q&A rejected fast)", async () => {
  // Keep the mock alive for BOTH calls (the helper resets fetch in finally).
  globalThis.fetch = async () => makeResponse(429, "Requests per day exceeded", null);
  try {
    // Primary daily-caps: sets qaRateLimitedUntil far in the future, then throws.
    await assert.rejects(() => engine.postQaChatCompletions({ body: { messages: [] } }));
    // A subsequent Q&A call should now short-circuit on the cooldown.
    await assert.rejects(
      () => engine.runApiModelGeneration("any question?", []),
      /rate-limited/i
    );
  } finally {
    globalThis.fetch = undefined;
  }
});

test("qwen3 fallback response has <think> blocks stripped", async () => {
  const models = [];
  let first = true;
  globalThis.fetch = async (url, opts) => {
    const m = JSON.parse(opts.body).model;
    models.push(m);
    if (first) { first = false; throw new Error("primary dead"); }
    // Confirm the fallback disables Qwen3 thinking.
    assert.deepStrictEqual(JSON.parse(opts.body).thinking, { type: "disabled" });
    return makeResponse(200, "<think>reasoning</think>Clean answer [A1].");
  };
  try {
    const { content } = await engine.postQaChatCompletions({ body: { messages: [] } });
    assert.strictEqual(content, "Clean answer [A1].");
  } finally {
    globalThis.fetch = undefined;
  }
});
