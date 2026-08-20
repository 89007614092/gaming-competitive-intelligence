"use strict";

// Thread F — real-source attribution.
//
// Verifies that the reader credit never mislabels an article as
// "Source: news.google.com" when we already know the real publisher name
// (captured from the RSS feed's <source> tag, surfaced as prop.publisher).
//
// Coverage:
//   1. applyRealSource (pure) — the label-only override logic.
//   2. GET /api/reader (resolved via Jina from the aggregator URL) — the real
//      bug: Jina reads the news.google.com URL, so attribution.source is the
//      aggregator host; the server must swap in the real publisher name.
//   3. GET /api/reader (every resolver exhausted, unresolved) — the publisher
//      name must still be threaded into the attribution so the client can show
//      it once the user supplies the article text.

process.env.SCAN_MODEL_MIN_GAP_MS = "50";
process.env.TAVILY_API_KEY = "contract-test-key";
process.env.READER_RATE_MAX = "1000000";
process.env.READER_RATE_WINDOW_MS = "60000";

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");

const srv = require("../server");
const app = srv.app;
const applyRealSource = srv.applyRealSource;

// Captured BEFORE any stubbing so the test harness itself always reaches the
// loopback server even while globalThis.fetch is replaced.
const realFetch = globalThis.fetch;

function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
async function request(server, method, path) {
  const port = server.address().port;
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { accept: "application/json" },
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json, text };
}

// Installs `impl` as globalThis.fetch and returns a restore closure.
// NOTE: the returned value is the RESTORE function, never the stub itself —
// getting this backwards silently leaves the real network in place and the
// test quietly exercises live Google News instead of the stub.
function stubFetch(impl) {
  const prev = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = prev; };
}

let server;
before(async () => { server = await startServer(); });
after(async () => { if (server) await closeServer(server); });

// ---------------------------------------------------------------------------
// Pure-function tests
// ---------------------------------------------------------------------------

test("applyRealSource overrides a news.google.com aggregator attribution", () => {
  const obj = {
    title: "Headline",
    text: "body".repeat(100),
    url: "https://news.google.com/rss/articles/abc",
    attribution: {
      source: "news.google.com",
      title: "Headline",
      url: "https://news.google.com/rss/articles/abc",
      licenseClass: "news-fair-use",
    },
  };
  const out = applyRealSource(obj, "Reuters");
  assert.strictEqual(out.attribution.source, "Reuters");
  // The (unresolvable) URL is preserved so the credit link still opens the article.
  assert.strictEqual(out.attribution.url, "https://news.google.com/rss/articles/abc");
  // The license class must survive the override (governance depends on it).
  assert.strictEqual(out.attribution.licenseClass, "news-fair-use");
});

test("applyRealSource leaves a resolved real publisher untouched", () => {
  const obj = {
    attribution: { source: "reuters.com", title: "Headline", url: "https://www.reuters.com/article" },
  };
  const out = applyRealSource(obj, "Reuters");
  assert.strictEqual(out.attribution.source, "reuters.com");
});

test("applyRealSource populates a stored-proposal-shaped object with no attribution", () => {
  const obj = {
    title: "T", text: "x", publisher: "Bloomberg",
    url: "https://news.google.com/rss/articles/xyz",
  };
  const out = applyRealSource(obj, obj.publisher);
  assert.strictEqual(out.attribution.source, "Bloomberg");
  assert.strictEqual(out.attribution.url, "https://news.google.com/rss/articles/xyz");
});

test("applyRealSource no-ops when no publisher is supplied", () => {
  const obj = { attribution: { source: "news.google.com" } };
  assert.strictEqual(applyRealSource(obj, "").attribution.source, "news.google.com");
  assert.strictEqual(applyRealSource(obj, "   ").attribution.source, "news.google.com");
  assert.strictEqual(applyRealSource(obj, undefined).attribution.source, "news.google.com");
});

test("applyRealSource no-ops on a non-aggregator, non-empty attribution", () => {
  const obj = { attribution: { source: "The Verge" } };
  const out = applyRealSource(obj, "Reuters");
  assert.strictEqual(out.attribution.source, "The Verge");
});

test("applyRealSource is safe on non-objects", () => {
  assert.strictEqual(applyRealSource(null, "Reuters"), null);
  assert.strictEqual(applyRealSource(undefined, "Reuters"), undefined);
  assert.strictEqual(applyRealSource("str", "Reuters"), "str");
});

test("applyRealSource detects the aggregator from the object url alone", () => {
  // Attribution exists but carries no url — the fall-back host check reads obj.url.
  const obj = {
    url: "https://news.google.com/rss/articles/nourl",
    attribution: { source: "news.google.com", title: "T" },
  };
  assert.strictEqual(applyRealSource(obj, "Financial Times").attribution.source, "Financial Times");
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

// Jina EXTRACTION (r.jina.ai/<article>) succeeds and returns article text, so
// the reader gets a real body — but because the canonical is the news.google.com
// URL, attribution.source is the aggregator host. Every resolver/redirect/viewer
// fetch fails so the real publisher URL is never resolved.
function aggregatorExtractionImpl() {
  return async (url) => {
    const u = String(url);
    if (u.includes("r.jina.ai/")) {
      return {
        ok: true, status: 200, url: u,
        headers: { get: (h) => (h.toLowerCase() === "content-type" ? "text/plain" : null) },
        text: async () => "# Resolved Headline\n\n" + "word ".repeat(150),
      };
    }
    throw new Error("network down (stubbed)");
  };
}

test("GET /api/reader swaps news.google.com for the real publisher (Jina read)", async () => {
  const restore = stubFetch(aggregatorExtractionImpl());
  try {
    const url = "https://news.google.com/rss/articles/CBMi_threadf";
    const { status, body } = await request(
      server, "GET",
      `/api/reader?url=${encodeURIComponent(url)}&publisher=${encodeURIComponent("Reuters")}`
    );
    assert.strictEqual(status, 200);
    assert.ok(body && typeof body === "object", "body must be an object");
    assert.ok(!body.unresolved, `should NOT be unresolved (Jina returned text); got reason=${body.reason}`);
    assert.ok(body.text && body.text.length >= 120, "body should carry extracted text");
    assert.ok(body.attribution && typeof body.attribution === "object", "attribution must exist");
    assert.strictEqual(
      body.attribution.source, "Reuters",
      "credit must show the real publisher, not news.google.com"
    );
  } finally {
    restore();
  }
});

// Same scenario, but with NO publisher query param: the pre-fix behaviour must
// still be intact (no silent invention of a source) — this pins the bug itself.
test("GET /api/reader still reports the aggregator when no publisher is known", async () => {
  const restore = stubFetch(aggregatorExtractionImpl());
  try {
    const url = "https://news.google.com/rss/articles/CBMi_threadf_nopub";
    const { status, body } = await request(
      server, "GET", `/api/reader?url=${encodeURIComponent(url)}`
    );
    assert.strictEqual(status, 200);
    assert.ok(body.attribution && typeof body.attribution === "object", "attribution must exist");
    assert.strictEqual(
      body.attribution.source, "news.google.com",
      "without a publisher hint the credit is unchanged (documents the bug)"
    );
  } finally {
    restore();
  }
});

// Every outbound fetch fails (network down). Resolution fails, Jina fails, the
// viewer fallback fails -> the reader returns {unresolved:true}. The publisher
// name must still be threaded into the attribution so the client can surface it.
test("GET /api/reader threads publisher into attribution when unresolved", async () => {
  const restore = stubFetch(async () => { throw new Error("network down (stubbed)"); });
  try {
    const url = "https://news.google.com/rss/articles/CBMi_threadf_unresolved";
    const { status, body } = await request(
      server, "GET",
      `/api/reader?url=${encodeURIComponent(url)}&publisher=${encodeURIComponent("Associated Press")}`
    );
    assert.strictEqual(status, 200);
    assert.strictEqual(body.unresolved, true, "should be the unresolved fall-through");
    assert.ok(body.attribution && typeof body.attribution === "object", "attribution must exist");
    assert.strictEqual(
      body.attribution.source, "Associated Press",
      "publisher must still be threaded in"
    );
  } finally {
    restore();
  }
});
