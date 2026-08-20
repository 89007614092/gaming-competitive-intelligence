# Tavily Fallback Plan

> Status: **PLAN FOR REVIEW** (not yet implemented). Discuss-first; no code until approved.
> Context: per `docs/longevity-and-live-updates.md`, Tavily is the **only external dependency with no fallback**. If it changes terms or rate-limits, three features degrade with no graceful path.

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
