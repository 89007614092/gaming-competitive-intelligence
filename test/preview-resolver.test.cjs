"use strict";

// Leg 1 (resolver fix): a Google News URL should now be previewed via Jina's
// reader (which resolves the redirect server-side) instead of the local
// resolver that returns null from Render's egress (consent-wall). We stub
// global.fetch so r.jina.ai returns article text and ANY other URL throws —
// if the function reaches the local resolver (followGoogleRedirect) it would
// fetch news.google.com and the stub would throw, failing the test. So a
// successful preview proves the Jina-direct path was taken.

process.env.SEARCH_PROVIDER = "jina"; // match the live Render config

const test = require("node:test");
const assert = require("node:assert");

const realFetch = global.fetch;
const JINA_BODY =
  "The European Commission has published new guidance on general-purpose AI " +
  "models. Providers must now document training data provenance. National " +
  "competent authorities gain audit powers. Non-compliance triggers fines up " +
  "to 7% of global turnover. The rules apply from August 2026.";

test("fetchArticlePreview: google-news URL uses Jina direct-extract (Leg 1)", async () => {
  global.fetch = async (url) => {
    if (String(url).startsWith("https://r.jina.ai/")) {
      return { ok: true, status: 200, text: async () => JINA_BODY };
    }
    // Any non-Jina fetch (e.g. the local resolver's followGoogleRedirect) must
    // fail the test — proving the Jina path short-circuited it.
    throw new Error(`unexpected fetch to ${url}`);
  };

  try {
    const server = require("../server");
    // Thin snippet forces the resolution path (not the snippet-shortcut).
    const item = {
      url: "https://news.google.com/rss/articles/CBMiabc123",
      title: "EU AI model guidance",
      snippet: "EU AI model guidance - European Commission", // < 40 extra chars
    };
    const res = await server.fetchArticlePreview(item, { timeoutMs: 2000 });
    assert.strictEqual(res.blocked, false);
    assert.ok(res.text, "expected a non-empty preview text");
    assert.match(res.text, /European Commission|general-purpose AI/i);
    // lead is capped at maxChars (720) and ends with ellipsis if truncated
    assert.ok(res.text.length <= 760, "preview should be a short lead");
  } finally {
    global.fetch = realFetch;
  }
});

test("fetchArticlePreview: non-google URL with rich snippet returns snippet lead", async () => {
  global.fetch = async () => { throw new Error("fetch should not be called for a rich snippet"); };
  try {
    const server = require("../server");
    const item = {
      url: "https://example.com/article",
      title: "Some Article",
      snippet: "This is a substantial paragraph of real article content that is " +
               "long enough to clear the thin-snippet threshold and be used directly " +
               "without any network fetch at all for the preview text extraction.",
    };
    const res = await server.fetchArticlePreview(item, { timeoutMs: 2000 });
    assert.strictEqual(res.blocked, false);
    assert.ok(res.text && res.text.length > 0);
    assert.match(res.text, /substantial paragraph/i);
  } finally {
    global.fetch = realFetch;
  }
});
