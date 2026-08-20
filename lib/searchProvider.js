"use strict";
// Web-search provider chain — removes Tavily as a single point of failure.
//
// Per docs/longevity-and-live-updates.md, Tavily was the ONLY external
// dependency with no fallback: a key expiry, quota exhaustion or terms change
// silently broke the search box and Q&A web evidence. This module puts a chain
// in front of it so a single provider outage degrades instead of failing.
//
// Chain (default): tavily -> brave -> jina
//   * tavily — primary. Structured results, best quality. Needs TAVILY_API_KEY.
//   * brave  — official API, free 2,000 queries/month. Needs BRAVE_API_KEY.
//   * jina   — s.jina.ai. KEYLESS backstop (an optional JINA_API_KEY only lifts
//              anonymous rate limits). Injected as a dependency so we reuse the
//              already-working parser in server.js instead of duplicating it.
//
// Why NOT DuckDuckGo (which the original plan listed as last resort): this repo
// already tried a self-scraped DDG search and removed it — see the comment at
// the top of server.js — because Render's shared egress IP gets rate-limited and
// bot-challenged, so it "always timed out". Jina is the strictly better keyless
// leg: official endpoint, no HTML scraping, and proven to work from Render.
//
// Bing Web Search API is deliberately excluded too (Microsoft is retiring it).
// Note this is unrelated to the Bing News *RSS* feed used by /api/news, which is
// a different product and unaffected.
//
// Behaviour:
//   * A provider that is not configured is skipped (no error).
//   * A provider that throws is recorded; after BREAKER_THRESHOLD consecutive
//     failures it is skipped entirely for a cooldown window (circuit breaker),
//     so a dead provider stops costing latency on every query.
//   * A provider returning ZERO results is NOT treated as a failure (an obscure
//     query legitimately has no hits) but we still try the next provider.
//   * If every provider is exhausted, searchWeb throws with a combined reason so
//     the route can surface a useful message.

const SEARCH_TIMEOUT_MS = 15000;
const BREAKER_THRESHOLD = 2;              // consecutive failures before opening
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000; // how long a provider stays skipped
const DEFAULT_CHAIN = ["tavily", "brave", "jina"];
const KNOWN_PROVIDERS = new Set(DEFAULT_CHAIN);

// Accepts "tavily,brave" / "brave" / "" and always yields a valid, de-duplicated
// chain. Unknown names are dropped rather than throwing, so a typo in an env var
// can never take search offline.
function parseChain(raw) {
  const parts = String(raw || "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(s => KNOWN_PROVIDERS.has(s));
  const deduped = [...new Set(parts)];
  return deduped.length ? deduped : [...DEFAULT_CHAIN];
}

// Every adapter returns this shape, so call sites are provider-agnostic.
function normalise(items, limit) {
  const cap = Math.min(Math.max(Number(limit) || 10, 1), 20);
  return (Array.isArray(items) ? items : [])
    .filter(item => item && item.url && (item.title || item.description || item.content))
    .slice(0, cap)
    .map(item => ({
      title: String(item.title || item.url).trim() || item.url,
      url: String(item.url),
      description: String(item.description || item.content || item.title || "").slice(0, 900),
    }));
}

function createSearchProvider(deps = {}) {
  const config = deps.config || {};
  const fetchImpl = deps.fetchImpl || ((...args) => globalThis.fetch(...args));
  const jinaSearch = typeof deps.jinaSearch === "function" ? deps.jinaSearch : null;
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const cooldownMs = Number(deps.cooldownMs) > 0 ? Number(deps.cooldownMs) : BREAKER_COOLDOWN_MS;
  const threshold = Number(deps.threshold) > 0 ? Number(deps.threshold) : BREAKER_THRESHOLD;
  const chain = parseChain(config.WEB_SEARCH_CHAIN);

  // name -> { failures, openUntil, lastError }
  const breaker = new Map();

  function state(name) {
    if (!breaker.has(name)) breaker.set(name, { failures: 0, openUntil: 0, lastError: "" });
    return breaker.get(name);
  }
  function isOpen(name) {
    return state(name).openUntil > now();
  }
  function recordFailure(name, err) {
    const s = state(name);
    s.failures += 1;
    s.lastError = String((err && err.message) || err || "unknown");
    if (s.failures >= threshold) {
      s.openUntil = now() + cooldownMs;
      log(`[search] provider "${name}" tripped after ${s.failures} failures — skipping for ${Math.round(cooldownMs / 1000)}s`);
    }
    return s;
  }
  function recordSuccess(name) {
    const s = state(name);
    s.failures = 0;
    s.openUntil = 0;
    s.lastError = "";
  }

  // Shared abort/timeout wrapper so no provider can hang a request.
  async function withTimeout(run) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
    try {
      return await run(controller.signal);
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("Search timed out");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function runTavily(query, limit) {
    return withTimeout(async (signal) => {
      const resp = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: config.TAVILY_API_KEY,
          query,
          max_results: Math.min(Number(limit) || 10, 20),
          search_depth: "basic",
          include_answer: false,
        }),
        signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`Tavily HTTP ${resp.status}: ${txt.slice(0, 160)}`);
      }
      const json = await resp.json();
      return normalise(json && json.results, limit);
    });
  }

  async function runBrave(query, limit) {
    return withTimeout(async (signal) => {
      const url = "https://api.search.brave.com/res/v1/web/search"
        + `?q=${encodeURIComponent(query)}&count=${Math.min(Number(limit) || 10, 20)}`;
      const resp = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": config.BRAVE_API_KEY,
        },
        signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`Brave HTTP ${resp.status}: ${txt.slice(0, 160)}`);
      }
      const json = await resp.json();
      const items = (json && json.web && Array.isArray(json.web.results) ? json.web.results : [])
        // Brave marks up snippets with <strong> highlights — strip to plain text.
        .map(r => ({
          title: r.title,
          url: r.url,
          description: String(r.description || "").replace(/<[^>]+>/g, ""),
        }));
      return normalise(items, limit);
    });
  }

  async function runJina(query, limit) {
    // jinaSearch already applies its own timeout + markdown parsing and returns
    // { title, url, content }; normalise() maps content -> description.
    const results = await jinaSearch(query, Math.min(Number(limit) || 10, 20));
    return normalise(results, limit);
  }

  const adapters = {
    tavily: { run: runTavily, configured: () => !!config.TAVILY_API_KEY, keyless: false },
    brave: { run: runBrave, configured: () => !!config.BRAVE_API_KEY, keyless: false },
    jina: { run: runJina, configured: () => !!jinaSearch, keyless: true },
  };

  // Tries each configured provider in chain order. Resolves with
  // { results, provider, attempts } where `provider` is the one that answered.
  async function searchWeb(query, options = {}) {
    const q = String(query || "").trim();
    if (!q) throw new Error("Query is required");
    const limit = options.limit || 10;
    const attempts = [];
    let lastResults = null;
    let lastProvider = "";

    for (const name of chain) {
      const adapter = adapters[name];
      if (!adapter) continue;
      if (!adapter.configured()) { attempts.push(`${name}: not configured`); continue; }
      if (isOpen(name)) { attempts.push(`${name}: circuit open (${state(name).lastError})`); continue; }

      try {
        const results = await adapter.run(q, limit);
        recordSuccess(name);
        if (results.length) return { results, provider: name, attempts };
        // Zero hits is a valid answer, not a fault: remember it and try the next
        // provider in case this one simply has thinner coverage.
        attempts.push(`${name}: 0 results`);
        if (!lastResults) { lastResults = results; lastProvider = name; }
      } catch (err) {
        recordFailure(name, err);
        attempts.push(`${name}: ${String((err && err.message) || err).slice(0, 160)}`);
        log(`[search] provider "${name}" failed: ${(err && err.message) || err}`);
      }
    }

    // Every provider ran but none had hits — return the empty set rather than
    // erroring, so the UI shows "no results" instead of "search broken".
    if (lastResults) return { results: lastResults, provider: lastProvider, attempts };

    const reason = attempts.length ? attempts.join("; ") : "no search providers configured";
    throw new Error(`Web search unavailable — ${reason}`);
  }

  // Diagnostic snapshot for /healthz: which providers exist, which are usable,
  // and which are currently circuit-broken.
  function searchProviderStatus() {
    const ts = now();
    return {
      chain,
      providers: chain.map(name => {
        const adapter = adapters[name];
        const s = state(name);
        return {
          name,
          configured: adapter ? adapter.configured() : false,
          keyless: adapter ? adapter.keyless : false,
          circuitOpen: s.openUntil > ts,
          failures: s.failures,
          lastError: s.lastError || undefined,
        };
      }),
      active: chain.find(name => adapters[name] && adapters[name].configured() && !isOpen(name)) || null,
    };
  }

  // Test seam: clear breaker state between cases.
  function resetBreakers() {
    breaker.clear();
  }

  return { searchWeb, searchProviderStatus, resetBreakers, chain };
}

module.exports = { createSearchProvider, parseChain, normalise, DEFAULT_CHAIN };
