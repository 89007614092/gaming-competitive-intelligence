'use strict';

// Tests for the DeepL liveness probe in lib/mtService.js (PR #95).
// global.fetch is mocked to simulate DeepL responses, so no network is touched.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert");

const mt = require("../lib/mtService");

let savedFetch = null;
let fetchCalls = 0;
let lastReq = null;

function setFetch(body, status = 200) {
  fetchCalls = 0;
  lastReq = null;
  savedFetch = global.fetch;
  global.fetch = async (url, opts) => {
    fetchCalls += 1;
    lastReq = { url, opts };
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
  if (mt.clearLastDeeplError) mt.clearLastDeeplError();
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

test("deeplBaseUrl routes a Free (:fx) key to api-free.deepl.com", () => {
  delete process.env.DEEPL_ENDPOINT;
  process.env.DEEPL_API_KEY = "abc123:fx";
  assert.strictEqual(mt.deeplBaseUrl(), "https://api-free.deepl.com");
});

test("deeplBaseUrl routes a Pro (no :fx) key to api.deepl.com", () => {
  delete process.env.DEEPL_ENDPOINT;
  process.env.DEEPL_API_KEY = "abc123-pro";
  assert.strictEqual(mt.deeplBaseUrl(), "https://api.deepl.com");
});

test("deeplBaseUrl honours an explicit DEEPL_ENDPOINT override", () => {
  process.env.DEEPL_ENDPOINT = "https://deepl-proxy.example.com/";
  process.env.DEEPL_API_KEY = "abc123:fx";
  assert.strictEqual(mt.deeplBaseUrl(), "https://deepl-proxy.example.com");
  delete process.env.DEEPL_ENDPOINT;
});

test("translation request sends the DeepL-Auth-Key header AND legacy auth_key", async () => {
  process.env.DEEPL_API_KEY = "abc123:fx";
  setFetch(deeplBody("你好世界"));
  await mt.probeDeepl();
  assert.ok(lastReq, "a request should have been made");
  const authz = lastReq.opts.headers.Authorization;
  assert.strictEqual(authz, "DeepL-Auth-Key abc123:fx");
  assert.ok(
    /auth_key=abc123%3Afx|auth_key=abc123:fx/.test(lastReq.opts.body),
    `expected legacy auth_key in body, got: ${lastReq.opts.body}`
  );
  assert.strictEqual(lastReq.url, "https://api-free.deepl.com/v2/translate");
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

test("getLastDeeplError captures the HTTP status on a 456 (Free quota exceeded)", async () => {
  process.env.DEEPL_API_KEY = "test:fx";
  mt.clearLastDeeplError();
  setFetch(deeplBody("err"), 456);
  assert.strictEqual(await mt.probeDeepl(), false);
  const err = mt.getLastDeeplError();
  assert.ok(err && /456/.test(err), `expected a 456 error, got: ${err}`);
});

test("getLastDeeplError captures the HTTP status on a 403 (wrong/expired key)", async () => {
  process.env.DEEPL_API_KEY = "test:fx";
  mt.clearLastDeeplError();
  setFetch(deeplBody("err"), 403);
  assert.strictEqual(await mt.probeDeepl(), false);
  const err = mt.getLastDeeplError();
  assert.ok(err && /403/.test(err), `expected a 403 error, got: ${err}`);
});

test("getLastDeeplError captures a network failure", async () => {
  process.env.DEEPL_API_KEY = "test:fx";
  mt.clearLastDeeplError();
  savedFetch = global.fetch;
  global.fetch = async () => { throw new Error("getaddrinfo ENOTFOUND api-free.deepl.com"); };
  assert.strictEqual(await mt.probeDeepl(), false);
  const err = mt.getLastDeeplError();
  assert.ok(err && /network error/i.test(err), `expected a network error, got: ${err}`);
  global.fetch = savedFetch;
});

test("clearLastDeeplError resets the captured error to null", async () => {
  process.env.DEEPL_API_KEY = "test:fx";
  setFetch(deeplBody("err"), 403);
  await mt.probeDeepl();
  assert.ok(mt.getLastDeeplError());
  mt.clearLastDeeplError();
  assert.strictEqual(mt.getLastDeeplError(), null);
});
