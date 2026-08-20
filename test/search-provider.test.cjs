"use strict";
// Web-search provider chain — proves Tavily is no longer a single point of failure.
//
// These are unit tests against lib/searchProvider.js directly: fetch and the Jina
// leg are dependency-injected, so nothing here touches the network or the server.
// The behaviours pinned below are the ones that matter operationally:
//   * a dead provider fails DOWN the chain instead of failing the request;
//   * an unconfigured provider is skipped silently (no key != an error);
//   * a repeatedly-failing provider is circuit-broken so it stops costing latency;
//   * total exhaustion throws ONE error carrying every attempt's reason.

const test = require("node:test");
const assert = require("node:assert");
const { createSearchProvider, parseChain, normalise, DEFAULT_CHAIN } = require("../lib/searchProvider");

const TAVILY_BODY = {
  results: [{ title: "Tavily hit", url: "https://example.com/t", content: "tavily body text" }],
};
const BRAVE_BODY = {
  web: { results: [{ title: "Brave hit", url: "https://example.com/b", description: "brave <strong>body</strong> text" }] },
};

function jsonResp(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// A fetch stub that routes by hostname and records what was called.
function router(handlers) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (u.includes(needle)) return handler(u, opts);
    }
    throw new Error(`unrouted fetch: ${u}`);
  };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// parseChain / normalise
// ---------------------------------------------------------------------------
test("parseChain defaults, filters unknown names, and de-duplicates", () => {
  assert.deepStrictEqual(parseChain(""), DEFAULT_CHAIN);
  assert.deepStrictEqual(parseChain(undefined), DEFAULT_CHAIN);
  assert.deepStrictEqual(parseChain("brave,jina"), ["brave", "jina"]);
  assert.deepStrictEqual(parseChain(" BRAVE , tavily "), ["brave", "tavily"]);
  assert.deepStrictEqual(parseChain("brave,brave,jina"), ["brave", "jina"]);
  // A typo must never take search offline — unknown names drop to the default.
  assert.deepStrictEqual(parseChain("bingo,nonsense"), DEFAULT_CHAIN);
  assert.deepStrictEqual(parseChain("bingo,brave"), ["brave"]);
});

test("normalise enforces the shared result shape and the limit cap", () => {
  const out = normalise([
    { title: "A", url: "https://a.example/1", content: "c" },
    { title: "B", url: "https://b.example/2", description: "d" },
    { title: "no url", content: "dropped" },
    { url: "https://c.example/3" }, // no title/description/content -> dropped
  ], 2);
  assert.strictEqual(out.length, 2, "respects the limit");
  for (const r of out) {
    assert.strictEqual(typeof r.title, "string");
    assert.strictEqual(typeof r.url, "string");
    assert.strictEqual(typeof r.description, "string");
  }
  assert.strictEqual(out[0].description, "c", "content maps to description");
  assert.strictEqual(out[1].description, "d");
});

// ---------------------------------------------------------------------------
// Happy path + fallback
// ---------------------------------------------------------------------------
test("searchWeb uses tavily first when it is configured and healthy", async () => {
  const { fetchImpl, calls } = router({ "api.tavily.com": () => jsonResp(TAVILY_BODY) });
  const sp = createSearchProvider({
    config: { TAVILY_API_KEY: "k", BRAVE_API_KEY: "b", WEB_SEARCH_CHAIN: "tavily,brave,jina" },
    fetchImpl,
    jinaSearch: async () => { throw new Error("jina must not be reached"); },
  });
  const { results, provider } = await sp.searchWeb("ai regulation", { limit: 5 });
  assert.strictEqual(provider, "tavily");
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].url, "https://example.com/t");
  assert.strictEqual(calls.length, 1, "no other provider is touched on success");
});

test("searchWeb falls down to brave when tavily fails", async () => {
  const { fetchImpl } = router({
    "api.tavily.com": () => jsonResp({ error: "quota" }, { status: 429 }),
    "api.search.brave.com": () => jsonResp(BRAVE_BODY),
  });
  const sp = createSearchProvider({
    config: { TAVILY_API_KEY: "k", BRAVE_API_KEY: "b", WEB_SEARCH_CHAIN: "tavily,brave,jina" },
    fetchImpl,
    jinaSearch: async () => { throw new Error("jina must not be reached"); },
  });
  const { results, provider, attempts } = await sp.searchWeb("ai regulation");
  assert.strictEqual(provider, "brave", "brave answers when tavily 429s");
  assert.strictEqual(results[0].url, "https://example.com/b");
  assert.strictEqual(results[0].description, "brave body text", "brave <strong> highlights are stripped");
  assert.ok(attempts.some(a => a.startsWith("tavily:")), "the tavily failure is reported in attempts");
});

test("searchWeb skips providers with no key and lands on the keyless jina leg", async () => {
  let jinaCalls = 0;
  const { fetchImpl, calls } = router({});
  const sp = createSearchProvider({
    // No TAVILY_API_KEY, no BRAVE_API_KEY — both must be skipped, not errored.
    config: { WEB_SEARCH_CHAIN: "tavily,brave,jina" },
    fetchImpl,
    jinaSearch: async () => {
      jinaCalls += 1;
      return [{ title: "Jina hit", url: "https://example.com/j", content: "jina body" }];
    },
  });
  const { results, provider, attempts } = await sp.searchWeb("ai regulation");
  assert.strictEqual(provider, "jina");
  assert.strictEqual(jinaCalls, 1);
  assert.strictEqual(results[0].url, "https://example.com/j");
  assert.strictEqual(calls.length, 0, "unconfigured providers make no HTTP calls");
  assert.ok(attempts.includes("tavily: not configured"));
  assert.ok(attempts.includes("brave: not configured"));
});

test("searchWeb tries the next provider when one returns zero results", async () => {
  const { fetchImpl } = router({
    "api.tavily.com": () => jsonResp({ results: [] }),
    "api.search.brave.com": () => jsonResp(BRAVE_BODY),
  });
  const sp = createSearchProvider({
    config: { TAVILY_API_KEY: "k", BRAVE_API_KEY: "b", WEB_SEARCH_CHAIN: "tavily,brave" },
    fetchImpl,
  });
  const { results, provider } = await sp.searchWeb("extremely obscure query");
  assert.strictEqual(provider, "brave");
  assert.strictEqual(results.length, 1);
});

test("searchWeb returns an empty set (not an error) when every provider has zero hits", async () => {
  const { fetchImpl } = router({
    "api.tavily.com": () => jsonResp({ results: [] }),
    "api.search.brave.com": () => jsonResp({ web: { results: [] } }),
  });
  const sp = createSearchProvider({
    config: { TAVILY_API_KEY: "k", BRAVE_API_KEY: "b", WEB_SEARCH_CHAIN: "tavily,brave" },
    fetchImpl,
  });
  const { results } = await sp.searchWeb("nothing matches this");
  assert.deepStrictEqual(results, [], "zero hits is a valid answer, not a failure");
});

test("searchWeb throws one combined error when the whole chain is exhausted", async () => {
  const { fetchImpl } = router({
    "api.tavily.com": () => { throw new Error("tavily down"); },
    "api.search.brave.com": () => { throw new Error("brave down"); },
  });
  const sp = createSearchProvider({
    config: { TAVILY_API_KEY: "k", BRAVE_API_KEY: "b", WEB_SEARCH_CHAIN: "tavily,brave" },
    fetchImpl,
  });
  await assert.rejects(
    () => sp.searchWeb("anything"),
    (err) => {
      assert.match(err.message, /Web search unavailable/);
      assert.match(err.message, /tavily down/);
      assert.match(err.message, /brave down/);
      return true;
    }
  );
});

test("searchWeb rejects an empty query without calling any provider", async () => {
  const { fetchImpl, calls } = router({});
  const sp = createSearchProvider({ config: { TAVILY_API_KEY: "k" }, fetchImpl });
  await assert.rejects(() => sp.searchWeb("   "), /Query is required/);
  assert.strictEqual(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
test("a repeatedly-failing provider is circuit-broken and then skipped", async () => {
  let tavilyCalls = 0;
  const { fetchImpl } = router({
    "api.tavily.com": () => { tavilyCalls += 1; throw new Error("tavily down"); },
    "api.search.brave.com": () => jsonResp(BRAVE_BODY),
  });
  let clock = 1_000_000;
  const sp = createSearchProvider({
    config: { TAVILY_API_KEY: "k", BRAVE_API_KEY: "b", WEB_SEARCH_CHAIN: "tavily,brave" },
    fetchImpl,
    now: () => clock,
    threshold: 2,
    cooldownMs: 60_000,
  });

  await sp.searchWeb("q1");
  assert.strictEqual(tavilyCalls, 1);
  await sp.searchWeb("q2");
  assert.strictEqual(tavilyCalls, 2, "second failure trips the breaker");

  // Third query must NOT touch tavily at all.
  const third = await sp.searchWeb("q3");
  assert.strictEqual(tavilyCalls, 2, "circuit is open — tavily is skipped entirely");
  assert.strictEqual(third.provider, "brave");
  assert.ok(third.attempts.some(a => a.includes("circuit open")));

  const status = sp.searchProviderStatus();
  const tav = status.providers.find(p => p.name === "tavily");
  assert.strictEqual(tav.circuitOpen, true);
  assert.strictEqual(status.active, "brave", "active provider reflects the open circuit");

  // After the cooldown the provider is retried.
  clock += 61_000;
  await sp.searchWeb("q4");
  assert.strictEqual(tavilyCalls, 3, "tavily is retried once the cooldown expires");
});

test("a success resets the failure counter", async () => {
  let fail = true;
  const { fetchImpl } = router({
    "api.tavily.com": () => { if (fail) throw new Error("blip"); return jsonResp(TAVILY_BODY); },
    "api.search.brave.com": () => jsonResp(BRAVE_BODY),
  });
  const sp = createSearchProvider({
    config: { TAVILY_API_KEY: "k", BRAVE_API_KEY: "b", WEB_SEARCH_CHAIN: "tavily,brave" },
    fetchImpl,
    threshold: 2,
  });
  await sp.searchWeb("q1");                       // 1 failure
  fail = false;
  const ok = await sp.searchWeb("q2");            // recovers
  assert.strictEqual(ok.provider, "tavily");
  fail = true;
  await sp.searchWeb("q3");                       // failure count restarted at 1
  const status = sp.searchProviderStatus();
  const tav = status.providers.find(p => p.name === "tavily");
  assert.strictEqual(tav.circuitOpen, false, "one post-recovery failure must not re-open the circuit");
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
test("searchProviderStatus reports the chain, configuration and keyless flags", () => {
  const sp = createSearchProvider({
    config: { TAVILY_API_KEY: "k", WEB_SEARCH_CHAIN: "tavily,brave,jina" },
    fetchImpl: async () => { throw new Error("unused"); },
    jinaSearch: async () => [],
  });
  const status = sp.searchProviderStatus();
  assert.deepStrictEqual(status.chain, ["tavily", "brave", "jina"]);
  const byName = Object.fromEntries(status.providers.map(p => [p.name, p]));
  assert.strictEqual(byName.tavily.configured, true);
  assert.strictEqual(byName.brave.configured, false, "no BRAVE_API_KEY -> not configured");
  assert.strictEqual(byName.jina.configured, true, "jina needs no key");
  assert.strictEqual(byName.jina.keyless, true);
  assert.strictEqual(status.active, "tavily");
});
