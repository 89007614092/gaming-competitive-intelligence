# Tavily Fallback Plan

> Status: **IMPLEMENTED** — `lib/searchProvider.js` + 15 tests. Tavily is no longer a single point of failure.
> Context: per `docs/longevity-and-live-updates.md`, Tavily *was* the **only external dependency with no fallback**. If it changed terms or rate-limited, three features degraded with no graceful path.
>
> **Two deliberate deviations from this plan (both documented in §7 below):**
> 1. The keyless last-resort leg is **Jina (`s.jina.ai`), not DuckDuckGo.**
> 2. The subhead path **keeps** a search leg for user-visible requests but is
>    **keyless-only for background warming** — which turned out to be the real
>    quota bug, and a bigger win than dropping search from subheads entirely.

## 1. Where Tavily is used (call-site inventory)

| # | Call site | Purpose | Degrade if Tavily fails |
|---|---|---|---|
| 1 | `POST /api/search` | Web-search box in News + Search | No results at all |
| 2 | `GET /api/news/subhead` | Generates article summary/subhead | Summaries break |
| 3 | Suggested Updates discovery (`runSourceScan` candidate finding) | Discovers new items for allowlisted domains | Stale/missing suggestions |

## 2. Provider options (search engines)

| Provider | Cost | Key | Notes |
|---|---|---|---|
| **DuckDuckGo (HTML/RSS)** | Free, **keyless** | none | Unofficial endpoint; HTML scrape; brittle, ToS gray; best as **LAST-RESORT** |
| **Brave Search API** | Free **2,000 q/mo** | yes | Official, reliable, generous free tier → **best fallback** |
| **Google CSE** | Free 100 q/day | yes | Official, low daily quota; fine as secondary |
| **SerpAPI** | Free 100 q/mo | yes | Google results; tiny free tier |
| **You.com API** | Free credits | yes | LLM-search hybrid |
| **Bing Web Search API** | Paid (→Azure AI Search) | yes | **Avoid for `/api/search`** — Microsoft is retiring the Bing Web Search API |
| **SearxNG** | Free, self-host | none | Sovereign, but you run/scale it |

> **Bing clarification (important):** The "Bing retiring" warning above refers **only to the Bing Web Search *API*** (a paid programmatic web-search API). It does **NOT** affect the **Bing News *RSS*** endpoint (`https://www.bing.com/news/search?q=…&format=RSS`) that `/api/news` already uses as its live fallback when Google News RSS is blocked. Those are different Microsoft products. So the existing news fallback chain (Google → Bing News RSS → seed) needs **no change** from this retirement.
>
> Caveat: Bing News RSS is a public RSS feed (not the API), and Microsoft has been inconsistent about RSS support, so it carries its *own* long-term risk unrelated to the API retirement. If we want a third, non-Bing leg for the news fallback later, **GDELT** (already in the codebase — `server.js` GDELT DOC API path) returns real publisher URLs directly and is keyless, making it the natural candidate. Treat that as separate hardening, not part of the Tavily work.

## 3. Recommended strategy — keep AI off the hot path, degrade gracefully

**Call site 2 — `/api/news/subhead`: DROP Tavily entirely.**
The article body is already extracted server-side (Jina / Firecrawl via `/api/reader`). Summarise the **extracted text directly** with the model — no web search needed. This removes 1 of 3 Tavily dependencies and produces stricter, source-citing summaries. Highest leverage, lowest cost.

**Call site 1 — `/api/search`: provider chain.**
`Tavily (primary) → Brave (free fallback) → DDG (keyless last resort) → graceful "limited results" message`.
Each provider behind a `searchProvider` interface; on non-200 / quota error, fail down the chain with a short circuit-breaker.

**Call site 3 — Suggested Updates discovery: use RSS, not search.**
Derive candidate URLs from `data/sources.json` domains via **Google News RSS / site RSS** (already keyless, already used for the news feed) instead of a Tavily search query. Keep Tavily only as optional enrichment where a domain has no RSS.

## 4. Implementation sketch

- New `lib/searchProvider.js` exporting `searchWeb(query, { limit })`:
  - Reads `SEARCH_PROVIDER` env (default `tavily`); fails down the chain on error/quota.
  - Optional `BRAVE_API_KEY` env; DDG needs no key.
  - Circuit-breaker: after N failures, skip a provider for a cooldown window.
- Swap the 3 call-sites to `searchWeb(...)`.
- `subhead` moves to extracted-text-only path (no `searchWeb`).
- Add an active-provider field to `/healthz` (reuses the existing diagnostic pattern).
- Contract tests: assert search returns results under a stubbed provider; assert fallback when the primary throws.

## 5. Cost / risk

- Brave free tier (2k/mo) easily covers normal BI usage; DDG keyless backstop = zero cost. Net: removes the single-point dependency at ~zero marginal cost.
- Risk: DDG HTML scraping breaks if markup changes → monitor; Brave is the real fallback, DDG is backstop only.

## 6. Phasing

1. Extract `searchWeb` abstraction + Brave + DDG adapters.
2. Wire `/api/search` to the chain (Tavily → Brave → DDG).
3. Remove Tavily from `/api/news/subhead` (use extracted text).
4. Re-point Suggested Updates discovery to RSS where possible.
5. Tests + `/healthz` provider field + manual deploy (Auto-Deploy OFF).

---

## 7. What actually shipped (and why it differs from the plan above)

### Chain: `tavily → brave → jina` (NOT `→ ddg`)

`lib/searchProvider.js` exposes `createSearchProvider({ config, fetchImpl, jinaSearch, now, threshold, cooldownMs })` → `{ searchWeb, searchProviderStatus, resetBreakers, chain }`.

**Why Jina replaced DDG as the keyless leg:** this repo *already tried* a self-scraped DuckDuckGo search and deleted it — the header comment in `server.js` records that Render's shared egress IP got rate-limited and bot-challenged, so it "always timed out". Shipping DDG as the backstop would have shipped a leg that is *known not to work in production*. `s.jina.ai` is keyless (an optional `JINA_API_KEY` only lifts anonymous limits), is an official endpoint rather than an HTML scrape, and is already proven from Render by the Suggested-Updates resolver. The chain injects the existing `jinaSearch` function, so there is no duplicated parser.

Bing Web Search API stays excluded (retiring). Unrelated to Bing News **RSS** — see the clarification in §2.

### Behaviour

| Situation | Result |
|---|---|
| Provider has no key | Skipped silently (`"brave: not configured"`), not an error |
| Provider throws | Recorded; chain continues to the next leg |
| Provider throws twice in a row | **Circuit breaker opens** — skipped for 5 min (`SEARCH` cooldown), so a dead provider stops costing 15s per query |
| Provider returns 0 results | *Not* a failure (obscure queries legitimately have none) — try the next leg, and if all are empty return `200` + `[]` |
| Every leg fails | One error carrying every attempt's reason |
| Success | Failure counter resets |

### Call sites moved onto the chain

| Call site | Before | After |
|---|---|---|
| `POST /api/search` | `tavilySearch` | `searchProvider.searchWeb` + `provider` in the response |
| `POST /api/summarise` (web evidence) | `tavilySearch` | `searchWeb` |
| `POST /api/gaming-trends/search` | `tavilySearch` | `searchProvider.searchWeb` + `provider` |
| `searchSubhead` (was `tavilySubhead`) | `tavilySearch` | `searchWeb` |

`tavilySearch` is deleted from `server.js` — the Tavily adapter now lives in the lib.

### Subhead: the quota bug the plan under-called

The plan said "drop Tavily from `/api/news/subhead` entirely". Investigating it surfaced something more specific and more urgent: `enrichTopArticles(articles, 6, …)` is fire-and-forget **on every news refresh — including the Thread B clock cron** (`NEWS_CRON_MS`, 5 min default). Ungated that is up to 6 searches × ~288 refreshes/day ≈ **1,700 searches/day against a 1,000/month budget**, spent warming cards nobody has opened. Thread B made this materially worse.

But deleting the search leg outright risked regressing what it was introduced to fix (the Google-News boilerplate subhead), because the keyless resolve+fetch leg is exactly the path that was failing.

Shipped split, which fixes the quota burn *and* keeps quality:

- `fetchArticleSubhead(article, { allowSearch })` now orchestrates two named legs:
  - `searchSubhead(title)` — chain-backed, cached per normalised headline.
  - `extractSubhead(article)` — **keyless**: resolve the Google-News redirect (cache-first) then read the publisher page for `og:description` / lead sentences.
- **`enrichTopArticles` passes `allowSearch: false`** → background warming is keyless-only → **zero** search spend on the cron.
- **`GET /api/news/subhead` keeps the default (`allowSearch: true`)** → search-first, extraction fallback. This route only fires when a card actually scrolls into view (`public/app.js:1495` requests a subhead for any visible card lacking one, *including the top 6*), so anything warming couldn't fill still gets the high-quality subhead — once per headline, then cached.

Net: identical user-visible behaviour, search quota now proportional to what is actually read rather than to wall-clock time.

### Config

`WEB_SEARCH_CHAIN` (default `tavily,brave,jina`) and `BRAVE_API_KEY` in `config.js` + `.env.example`. `WEB_SEARCH_CHAIN` is deliberately a **new** var: the pre-existing `SEARCH_PROVIDER` selects the *URL resolver* provider, not the web-search chain, and overloading it would have silently coupled two unrelated subsystems. Unknown chain names are dropped, so a typo cannot take search offline.

### Observability

`GET /healthz` gains `search: { chain, providers[{name, configured, keyless, circuitOpen, failures, lastError}], active }`. A degraded search is now visible to a live probe instead of only surfacing as empty result sets.

### Tests (15 new; suite 131/131)

`test/search-provider.test.cjs` (12, fully injected — no network): chain parsing/dedupe/typo-tolerance, normalisation + limit cap, Tavily-first happy path, fall-through to Brave on 429, skip-unconfigured → land on keyless Jina, zero-results fall-through, all-empty → `[]`, full exhaustion error, empty-query guard, breaker opens after 2 failures / is skipped / retries after cooldown, success resets the counter, status shape.

`test/api-contract.test.cjs` (3, through the real route): `provider` field present; **Tavily fails → Jina answers → still `200`**; every provider down → `500` with the combined reason. Plus `/healthz` `search` shape.

### Not done (deliberately deferred)

Plan step 4 — re-pointing Suggested Updates discovery from search to RSS — was **not** included here. It already uses `searchGoogleNewsRss` (keyless RSS) for discovery, so there is no Tavily dependency to remove; the real attribution problem on that path is Thread F (`news.google.com` credit), which is a separate change.
