"use strict";
// Phase 1 — governed central extractor (Jina-backed, cached, license-aware).
const test = require("node:test");
const assert = require("node:assert");
const { createExtractor } = require("../lib/extractor");

const LONG = "Title: Example Headline\n\n" +
  "This article body is deliberately written to be long enough to exceed the one " +
  "hundred and twenty character threshold that the extractor uses to reject useless " +
  "or boilerplate extractions, so the happy path is exercised.\n";

function jinaResp(body, { status = 200, contentType = "text/plain" } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? contentType : null) },
    text: async () => body,
  };
}

function makeExtractor(fetchHandler) {
  const original = globalThis.fetch;
  globalThis.fetch = fetchHandler;
  const deps = {
    validateSourceUrl: (u) => {
      const p = new URL(u);
      if (!/^https?:/.test(p.protocol)) throw new Error("bad scheme");
      return p.toString();
    },
    assertPublicHost: async () => {},
    readStreamWithCap: async (res) => Buffer.from(await res.text()),
    SCRAPE_USER_AGENT: "test-agent",
    READER_MAX_BYTES: 5 * 1024 * 1024,
    READER_TIMEOUT_MS: 5000,
    readerRateLimiter: () => true,
  };
  const ex = createExtractor(deps);
  const restore = () => { globalThis.fetch = original; };
  return { ex, restore };
}

test("extractArticle returns text + provenance on Jina success", async () => {
  let calls = 0;
  const { ex, restore } = makeExtractor(async () => { calls++; return jinaResp(LONG); });
  try {
    const r = await ex.extractArticle("https://example.com/article");
    assert.ok(r && r.text && r.text.includes("article body"), "should return extracted text");
    assert.strictEqual(r.via, "jina");
    assert.strictEqual(r.cached, false);
    assert.ok(r.attribution && r.attribution.source === "example.com", "attribution should carry the source host");
    assert.ok(r.attribution.retrievedAt, "attribution should carry a retrievedAt timestamp");
    assert.strictEqual(calls, 1);
  } finally { restore(); }
});

test("extractArticle caches by canonical URL (drops tracking params)", async () => {
  let calls = 0;
  const { ex, restore } = makeExtractor(async () => { calls++; return jinaResp(LONG); });
  try {
    const r1 = await ex.extractArticle("https://example.com/article?utm_source=x");
    const r2 = await ex.extractArticle("https://example.com/article?utm_medium=y");
    assert.strictEqual(calls, 1, "second call with different tracking param hits the cache");
    assert.strictEqual(r2.cached, true, "second result flagged as cached");
  } finally { restore(); }
});

test("extractArticle returns metadata only for restricted sources (no fetch)", async () => {
  const { ex, restore } = makeExtractor(async () => { throw new Error("should not fetch"); });
  try {
    const r = await ex.extractArticle("https://restricted.example.com/a", { licenseClass: "restricted" });
    assert.strictEqual(r.restricted, true);
    assert.strictEqual(r.text, "");
    assert.ok(r.attribution && r.attribution.licenseClass === "restricted");
  } finally { restore(); }
});

test("extractArticle throws on an invalid URL", async () => {
  const { ex, restore } = makeExtractor(async () => { throw new Error("should not fetch"); });
  try {
    await assert.rejects(() => ex.extractArticle("not-a-url"), /Invalid source URL/i);
  } finally { restore(); }
});

test("extractArticle returns null on a failed fetch and short-circuits via negative cache", async () => {
  let calls = 0;
  const { ex, restore } = makeExtractor(async () => { calls++; return jinaResp("nope", { status: 404 }); });
  try {
    const first = await ex.extractArticle("https://example.com/missing");
    assert.strictEqual(first, null, "404 yields no extraction");
    assert.strictEqual(calls, 1);
    const second = await ex.extractArticle("https://example.com/missing");
    assert.strictEqual(second, null);
    assert.strictEqual(calls, 1, "negative cache prevents a second fetch");
  } finally { restore(); }
});

test("extractArticle returns null when the body is too short", async () => {
  const { ex, restore } = makeExtractor(async () => jinaResp("too short"));
  try {
    const r = await ex.extractArticle("https://example.com/short");
    assert.strictEqual(r, null, "sub-threshold text is rejected");
  } finally { restore(); }
});

test("extractArticle does not negative-cache a Jina 403 (anonymous throttle)", async () => {
  // A 403 from Jina (AbuseAlleviation / anonymous-throttle) is account-level,
  // not URL-level. Poisoning the per-URL negative cache with it would blacklist
  // the URL for the whole session; instead a later call must retry Jina.
  let calls = 0;
  const { ex, restore } = makeExtractor(async () => { calls++; return jinaResp("nope", { status: 403 }); });
  try {
    const first = await ex.extractArticle("https://example.com/throttled");
    assert.strictEqual(first, null, "403 yields no extraction");
    const second = await ex.extractArticle("https://example.com/throttled");
    assert.strictEqual(second, null);
    assert.strictEqual(calls, 2, "a 403 is NOT negative-cached, so a retry re-fetches Jina");
  } finally { restore(); }
});

test("extractArticle sends the Jina API key as a Bearer token when configured", async () => {
  // The reader path must authenticate to Jina (config.JINA_API_KEY on Render)
  // or popular domains stay throttled (anonymous 403) and retrieval fails.
  const original = globalThis.fetch;
  let sentAuth = null;
  globalThis.fetch = async (u, opts) => {
    sentAuth = opts && opts.headers && (opts.headers.Authorization || (opts.headers.get && opts.headers.get("Authorization"))) || null;
    return jinaResp(LONG);
  };
  try {
    const ex = createExtractor({
      validateSourceUrl: (u) => u,
      assertPublicHost: async () => {},
      readStreamWithCap: async (res) => Buffer.from(await res.text()),
      readerRateLimiter: () => true,
      JINA_API_KEY: "test-key-123",
    });
    const r = await ex.extractArticle("https://reuters.com/article");
    assert.ok(r && r.text, "should still extract when key is sent");
    assert.strictEqual(sentAuth, "Bearer test-key-123", "Jina request must carry the Authorization header");
  } finally { globalThis.fetch = original; }
});

test("extractArticle stays anonymous (no Authorization header) when no key is set", async () => {
  // Without a key the request must NOT send an Authorization header — the
  // previous bug was that the key was never forwarded, so this must remain false
  // when the env var is absent.
  const original = globalThis.fetch;
  let sentAuth = "unset";
  globalThis.fetch = async (u, opts) => {
    sentAuth = opts && opts.headers && (opts.headers.Authorization || (opts.headers.get && opts.headers.get("Authorization"))) || null;
    return jinaResp(LONG);
  };
  try {
    const ex = createExtractor({
      validateSourceUrl: (u) => u,
      assertPublicHost: async () => {},
      readStreamWithCap: async (res) => Buffer.from(await res.text()),
      readerRateLimiter: () => true,
    });
    await ex.extractArticle("https://example.com/article");
    assert.strictEqual(sentAuth, null, "no Authorization header when JINA_API_KEY is absent");
  } finally { globalThis.fetch = original; }
});
