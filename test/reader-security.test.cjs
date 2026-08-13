// Security + behaviour tests for the Suggested Updates "Reader" proxy.
// Requires server.js (importable without booting a socket, thanks to the
// require.main === module guards) and exercises the hardened fetch path.
process.env.SCAN_MODEL_MIN_GAP_MS = "50"; // keep any pacing logic fast

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

const srv = require("../server");

test("validateSourceUrl rejects non-http(s) schemes and local hosts", () => {
  assert.throws(() => srv.validateSourceUrl("ftp://example.com/file"), /valid source URL|HTTP and HTTPS|supported/i);
  assert.throws(() => srv.validateSourceUrl("javascript:alert(1)"), /valid source URL|HTTP and HTTPS|supported/i);
  assert.throws(() => srv.validateSourceUrl("http://localhost:8080/x"), /Local network|cannot be scraped/i);
  assert.throws(() => srv.validateSourceUrl("http://127.0.0.1/x"), /Local network|cannot be scraped/i);
  // A normal public https URL is accepted and normalised to a string.
  assert.strictEqual(typeof srv.validateSourceUrl("https://example.com/a"), "string");
});

test("isPrivateOrReservedIp classifies addresses correctly", () => {
  assert.strictEqual(srv.isPrivateOrReservedIp("127.0.0.1"), true);   // loopback
  assert.strictEqual(srv.isPrivateOrReservedIp("10.0.0.5"), true);    // RFC1918
  assert.strictEqual(srv.isPrivateOrReservedIp("192.168.1.1"), true); // RFC1918
  assert.strictEqual(srv.isPrivateOrReservedIp("172.16.5.4"), true);  // RFC1918
  assert.strictEqual(srv.isPrivateOrReservedIp("169.254.169.254"), true); // link-local / metadata
  assert.strictEqual(srv.isPrivateOrReservedIp("::1"), true);          // IPv6 loopback
  assert.strictEqual(srv.isPrivateOrReservedIp("8.8.8.8"), false);    // public
  assert.strictEqual(srv.isPrivateOrReservedIp("1.1.1.1"), false);    // public
});

test("assertPublicHost rejects private/loopback literals", async () => {
  await assert.rejects(() => srv.assertPublicHost("127.0.0.1"), /Blocked address range/i);
  await assert.rejects(() => srv.assertPublicHost("::1"), /Blocked address range/i);
  await assert.rejects(() => srv.assertPublicHost("192.168.0.1"), /Blocked address range/i);
  // A public IP literal must not throw. If the sandbox blocks DNS entirely we
  // skip rather than fail, but a literal IP should never need resolution.
  try {
    await srv.assertPublicHost("8.8.8.8");
    assert.ok(true);
  } catch (e) {
    if (/Could not resolve/.test(e.message)) return; // network isolated — skip
    throw e;
  }
});

test("fetchReaderContent never contacts a private/local server", async () => {
  let hits = 0;
  const local = http.createServer((_req, res) => {
    hits += 1;
    res.setHeader("content-type", "text/html");
    res.end("<html><body>SECRET-INTERNAL</body></html>");
  });
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const port = local.address().port;
  try {
    let threw = false;
    try {
      await srv.fetchReaderContent(`http://127.0.0.1:${port}/internal`);
    } catch (_) { threw = true; }
    assert.strictEqual(threw, true, "proxy must refuse the private host");
    assert.strictEqual(hits, 0, "proxy must NEVER have contacted the local server");
  } finally {
    await new Promise((r) => local.close(r));
  }
});

test("readStreamWithCap enforces the byte ceiling", async () => {
  // Small body passes through unchanged.
  const small = new Response("hello world");
  const smallBuf = await srv.readStreamWithCap(small, 100);
  assert.strictEqual(smallBuf.length, 11);

  // A body larger than the cap is rejected mid-stream.
  const big = new Response("x".repeat(1000));
  await assert.rejects(() => srv.readStreamWithCap(big, 10), /too large/i);
});

test("createRateLimiter throttles after the budget is exhausted", () => {
  const lim = srv.createRateLimiter({ max: 2, windowMs: 60000 });
  assert.strictEqual(lim("alice"), true);
  assert.strictEqual(lim("alice"), true);
  assert.strictEqual(lim("alice"), false, "third request in window must be blocked");
  assert.strictEqual(lim("bob"), true, "different key has its own budget");
});

test("fetchReaderContent never surfaces the Google News boilerplate", async () => {
  // For an unresolved news.google.com URL every resolver fails (here we force the
  // network down) and the Option-A viewer fallback also fails. The reader must
  // then return a structured {unresolved:true} marker — NOT throw a dead-end
  // error, and NEVER surface the "Comprehensive up-to-date news coverage..."
  // aggregator landing text. The client uses the marker to offer manual entry.
  const restore = mockFetch(async () => { throw new Error("network down"); });
  try {
    const result = await srv.fetchReaderContent("https://news.google.com/rss/articles/CBMi_example");
    assert.strictEqual(result && result.unresolved, true,
      "unresolved Google News link returns the manual-entry marker, never boilerplate");
    assert.strictEqual(result.reason, "google-news");
    assert.ok(!result.text || !srv.isGoogleNewsBoilerplate(result.text || ""),
      "must never surface the Google News boilerplate");
  } finally { restore(); }
});

test("fetchReaderContent returns a partial viewer preview when the publisher is unreachable", async () => {
  // The Google News viewer page (with /rss/ stripped) serves a real headline +
  // description even though the publisher can't be reached. The reader should
  // surface that as a PARTIAL preview rather than the unresolved marker.
  const viewerHtml = `<!doctype html><html><head><title>EU AI Act passes final vote</title>
    <meta name="description" content="The EU AI Act has been approved by lawmakers in a landmark vote that sets binding rules for providers of general-purpose AI models.">
    </head><body><article><h1>EU AI Act passes final vote</h1>
    <p>The EU AI Act has been approved by lawmakers in a landmark vote that sets out binding rules for providers of general-purpose AI models. The regulation introduces a risk-based framework classifying systems by potential harm, with the strictest obligations reserved for high-risk applications such as biometric surveillance and critical infrastructure.</p>
    </article></body></html>`;
  const restore = mockFetch(async (url) => {
    const u = String(url);
    if (u.includes("news.google.com/articles/")) {
      return {
        status: 200, ok: true, url: u,
        headers: { get: (h) => (String(h).toLowerCase() === "content-type" ? "text/html" : null) },
        text: async () => viewerHtml,
        arrayBuffer: async () => Buffer.from(viewerHtml),
      };
    }
    throw new Error("network down");
  });
  try {
    const result = await srv.fetchReaderContent("https://news.google.com/rss/articles/CBMi_viewer");
    assert.ok(result && result.partial === true, "should return a partial preview from the viewer page");
    assert.ok(/EU AI Act/.test(result.text), "partial preview should contain the headline text");
    assert.notStrictEqual(result.unresolved, true, "should NOT be the unresolved marker when viewer text was extracted");
  } finally { restore(); }
});

// ---- followGoogleRedirect (primary Google News resolver) -------------------
// Public IP-literal "publishers" are used so the publisher-host assertPublicHost
// check passes deterministically without depending on sandbox DNS resolution.
const PUB = "https://8.8.8.8/article";

function mockFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}
function redirectResp(loc) {
  return { status: 302, headers: { get: (h) => (String(h).toLowerCase() === "location" ? loc : null) } };
}
function finalResp() {
  return { status: 200, headers: { get: () => null } };
}

test("followGoogleRedirect returns the publisher on a single 302", async () => {
  const restore = mockFetch(async (url) =>
    String(url).includes("news.google.com") ? redirectResp(PUB) : finalResp());
  try {
    const out = await srv.followGoogleRedirect("https://news.google.com/rss/articles/ABC");
    assert.strictEqual(out, PUB, "should follow the 302 to the publisher");
  } finally { restore(); }
});

test("followGoogleRedirect follows an internal multi-hop chain to the publisher", async () => {
  const restore = mockFetch(async (url) => {
    if (String(url).includes("/articles/A"))
      return redirectResp("https://news.google.com/rss/articles/B");
    if (String(url).includes("/articles/B"))
      return redirectResp(PUB);
    return finalResp();
  });
  try {
    const out = await srv.followGoogleRedirect("https://news.google.com/rss/articles/A");
    assert.strictEqual(out, PUB, "should traverse two hops and land on the publisher");
  } finally { restore(); }
});

test("followGoogleRedirect returns null when the chain ends at the aggregator", async () => {
  const restore = mockFetch(async (url) =>
    String(url).includes("news.google.com") ? finalResp() : finalResp());
  try {
    const out = await srv.followGoogleRedirect("https://news.google.com/rss/articles/ABC");
    assert.strictEqual(out, null, "a 200 interstitial with no Location is not a resolution");
  } finally { restore(); }
});

test("followGoogleRedirect returns null on a redirect loop", async () => {
  const restore = mockFetch(async (url) => {
    if (String(url).includes("/articles/A"))
      return redirectResp("https://news.google.com/rss/articles/B");
    return redirectResp("https://news.google.com/rss/articles/A"); // B -> A -> loop
  });
  try {
    const out = await srv.followGoogleRedirect("https://news.google.com/rss/articles/A");
    assert.strictEqual(out, null, "a detected redirect loop must not hang or recurse");
  } finally { restore(); }
});

test("followGoogleRedirect rejects a private-host publisher (SSRF guard)", async () => {
  const restore = mockFetch(async (url) =>
    String(url).includes("news.google.com") ? redirectResp("http://127.0.0.1/secret") : finalResp());
  try {
    const out = await srv.followGoogleRedirect("https://news.google.com/rss/articles/ABC");
    assert.strictEqual(out, null, "a 302 to a loopback host must never be returned");
  } finally { restore(); }
});

test("followGoogleRedirect returns null for a non-Google-News URL", async () => {
  const restore = mockFetch(async () => finalResp());
  try {
    const out = await srv.followGoogleRedirect("https://example.com/some-article");
    assert.strictEqual(out, null, "only news.google.com links are followed");
  } finally { restore(); }
});

test("followGoogleRedirect returns null for an invalid URL", async () => {
  const restore = mockFetch(async () => finalResp());
  try {
    const out = await srv.followGoogleRedirect("not-a-url");
    assert.strictEqual(out, null, "validateSourceUrl failure must be swallowed");
  } finally { restore(); }
});

// ---- Session-only negative cache -------------------------------------------
test("resolveGoogleNewsUrl skips re-resolution for a URL that just failed", async () => {
  srv.resolverNegativeCache.clear();
  let fetchCount = 0;
  const restore = mockFetch(async (url) => {
    fetchCount++;
    const u = String(url);
    if (u.includes("news.google.com")) return finalResp();      // followGoogleRedirect -> null
    if (u.includes("jina.ai")) return { status: 200, headers: { get: () => null }, text: async () => "no results" };
    if (u.includes("duckduckgo.com")) return { status: 200, headers: { get: () => null }, text: async () => "no uddg param" };
    if (u.includes("gdeltproject.org")) return { status: 200, headers: { get: () => null }, text: async () => "not json {" };
    return { status: 200, headers: { get: () => null }, text: async () => "" };
  });
  const url = "https://news.google.com/rss/articles/NEGCACHE_" + Date.now();
  try {
    const first = await srv.resolveGoogleNewsUrl(url, "Some Title", "example.com");
    assert.strictEqual(first, null, "all resolvers exhausted -> null");
    const afterFirst = fetchCount;
    assert.ok(afterFirst > 0, "first call actually attempted resolution");
    // The URL must now be in the session negative cache...
    assert.strictEqual(srv.resolverNegativeCache.has(url), true, "failed URL recorded in negative cache");
    const second = await srv.resolveGoogleNewsUrl(url, "Some Title", "example.com");
    assert.strictEqual(second, null, "second call also returns null");
    assert.strictEqual(fetchCount, afterFirst, "second call did NOT re-fetch (negative cache short-circuits)");
  } finally {
    restore();
    srv.resolverNegativeCache.delete(url);
  }
});

