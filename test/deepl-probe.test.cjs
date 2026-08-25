'use strict';

// Tests for the DeepL liveness probe in lib/mtService.js (PR #95).
// global.fetch is mocked to simulate DeepL responses, so no network is touched.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const mt = require("../lib/mtService");

let savedFetch = null;
let fetchCalls = 0;

function setFetch(body, status = 200) {
  fetchCalls = 0;
  savedFetch = global.fetch;
  global.fetch = async () => {
    fetchCalls += 1;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}
function restoreFetch() {
  if (savedFetch) global.fetch = savedFetch;
}
function deeplBody(text) {
  return { translations: [{ text }] };
}

beforeEach(() => {
  delete process.env.DEEPL_API_KEY;
});
afterEach(restoreFetch);

test("probeDeepl returns false when DEEPL_API_KEY is unset", async () => {
  assert.strictEqual(await mt.probeDeepl(), false);
});

test("probeDeepl returns true for a genuine ZH translation", async () => {
  process.env.DEEPL_API_KEY = "test:fx";
  setFetch(deeplBody("你好世界"));
  assert.strictEqual(await mt.probeDeepl(), true);
  assert.strictEqual(fetchCalls, 1);
});

test("probeDeepl returns false when DeepL echoes the source (no translation)", async () => {
  process.env.DEEPL_API_KEY = "test:fx";
  setFetch(deeplBody("Hello world"));
  assert.strictEqual(await mt.probeDeepl(), false);
});

test("probeDeepl returns false when DeepL returns a non-200 error", async () => {
  process.env.DEEPL_API_KEY = "test:fx";
  setFetch(deeplBody("err"), 403);
  assert.strictEqual(await mt.probeDeepl(), false);
});

test("probeDeepl returns false when fetch throws (network down)", async () => {
  process.env.DEEPL_API_KEY = "test:fx";
  savedFetch = global.fetch;
  global.fetch = async () => { throw new Error("network down"); };
  assert.strictEqual(await mt.probeDeepl(), false);
});

test("getDeeplStatus caches and respects TTL (no second probe while fresh)", async () => {
  process.env.DEEPL_API_KEY = "test:fx";
  setFetch(deeplBody("你好世界"));
  // First read triggers a background probe; wait for it, then a fresh read must
  // be served from cache without re-hitting the network.
  mt.getDeeplStatus();
  await mt.ensureDeeplStatus();
  assert.strictEqual(mt.getDeeplStatus(), true);
  assert.strictEqual(fetchCalls, 1); // only one real probe occurred
});
