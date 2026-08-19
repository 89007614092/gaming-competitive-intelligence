# Cold-start optimisation for `/api/news` — proposal for review

> Status: **proposed, not implemented**. Awaiting Molly's review/approval before coding.

## 1. Why `/api/news` cold-starts (root cause)

The endpoint's latency is dominated by a **live RSS fan-out**, not by compute. On a cache miss the handler must:

1. `runNewsFanOut(searchGoogleNewsRss, …)` — **4 topic queries + 1 competitor batch = 5 parallel** `fetchTextResource` calls to `news.google.com/rss/search` (server.js:1599, 1628).
2. If Google returns 0 articles (it 503s from Render's datacenter IP — server.js:1492-1498, 1624-1626), run a **second wave** of 5 Bing fetches (server.js:1632).
3. Respond; subhead enrichment is fire-and-forget.

Each fetch inherits `fetchTextResource`'s default **20s** timeout (server.js:296). They run in parallel, so wall-time ≈ slowest single fetch (+ a second wave when Google is blocked).

**The cache exists but is empty at boot.** `newsCacheBySelection` is an in-memory `Map`. A seed, `data/news-cache.json`, *is* loaded at startup (`bundledNewsCache`, server.js:1397) — but it is only used as a *last-resort fallback when the live fetch returns zero* (`getNewsFallback`, server.js:1412). It is **never pre-loaded into the serve cache**. Therefore the very first request after any process start (deploy, or spin-down wake) has nothing to serve and must pay the full fan-out. That is the cold-start.

Measured on the live Render deploy: first-hit ≈ **9s**; warm repeat ≈ **0.2s** (serve-cache, added in Step 2c PR #52).

## 2. Relation to Render — three layers

| Layer | Cause | Render-specific? | When it bites |
|---|---|---|---|
| **A. Live fan-out** | Aggregating external RSS (Google/Bing) | *Partly* — baseline is host-independent; Render's shared IP reputation makes Google intermittently 503 → forces Bing fallback + occasional slow/hung connects | Every cache miss |
| **B. Empty in-memory cache at boot** | Seed not pre-warmed into serve cache (app logic) | Triggering event is Render (deploy / spin-down restart); root cause is app | First request after any restart |
| **C. Process spin-down boot** | Render free/low tiers spin down after ~15 min idle; first request boots Node + loads modules + startup I/O | **Yes — 100% hosting** | First request after >15 min idle (free tier) |

Note: the code comment at server.js:1343 ("The keep-alive cron keeps it up") is **aspirational** — no external keep-alive cron/ping exists in this repo. The only `setInterval` is the internal scan scheduler (server.js:3580), which does **not** keep Render's HTTP endpoint warm (Render spins down on HTTP inactivity, not internal timers). So Layer C is currently **unmitigated**.

## 3. How much of the latency is Render?

- **Warm + cache fresh (<2 min):** ~0.2s. No cold-start.
- **Warm + cache expired (>2 min idle, no spin-down):** ~9s = **Layer A only**. Render contributes variance (±1-3s from IP-block/Bing fallback) but not the baseline. This cost exists on *any* host.
- **Spin-down wake (free tier, >15 min idle):** Layer C boot (~1-5s, ~2-3s typical for this module graph) **+** Layer A (~9s) ≈ **10-14s**. Render is dominant here.
- **Every deploy (any tier):** process restart → empty cache → first request ≈ Layer A (~9s) [+ boot if free tier]. Layer B is the amplifier; its trigger is Render, its root cause is app logic.

**Attribution:** the ~9s fan-out is ~75-90% intrinsic (external RSS aggregation) and ~10-25% Render-aggravated. The "first hit after idle is slow" symptom is ~50% Render (spin-down) + ~50% app (cache empties / seed not pre-warmed). The boot overhead is 100% Render.

## 4. Proposed optimisation (two tracks)

### Track 1 — App-layer (Render-independent, highest leverage)

- **1.1 Pre-warm serve cache from the seed at boot.** After `bundledNewsCache` loads (server.js:1397), insert it into `newsCacheBySelection` under the default selection key (`DEFAULT_NEWS_COMPETITOR_IDS`) with `generatedAt` = the file's timestamp. The first `/api/news` then serves the seed instantly (`cached:true, live:false`) and triggers the existing background refresh. **Removes Layer B entirely.** Risk: low (uses existing seed; entry still subject to `NEWS_SERVE_TTL_MS` / `NEWS_REFRESH_MS`).
- **1.2 Race Google + Bing concurrently** instead of serial fallback. Change `getLiveNewsArticles` (server.js:1627) to run both fan-outs via `Promise.allSettled` and prefer Google if non-empty, else Bing. Cuts the blocked-Google case from ~2 waves to ~1. Reduces Layer A's Render-aggravated tail.
- **1.3 Tighter news fetch timeout.** Pass an explicit ~8s timeout to `searchGoogleNewsRss` / `searchBingNewsRss` (currently inherits the 20s default, server.js:296/1487). A hung Google connect fails fast → Bing wins sooner. Caps worst-case Layer A.
- **1.4 (optional)** On a cache miss for a non-default selection, copy relevant seed articles into the serve cache immediately (extends 1.1 to custom selections).

### Track 2 — Render-layer (hosting-only)

- **2.1 Add a keep-alive pinger.** A Render Cron hitting `/api/healthz` every 5-10 min (the endpoint is already side-effect-free and designed for this, server.js:3408), or an external uptime pinger. **Eliminates Layer C** on free tier.
- **2.2 Post-deploy warm-up.** After each deploy, hit `/api/news?refresh` once (or let 2.1's first ping do it) so the cache is populated before real users arrive.
- **2.3 (optional)** Upgrade to an always-on plan → Layer C ≈ 0.

## 5. Recommendation

Ship **Track 1.1 + 1.2 + 1.3 + Track 2.1**. Together they take the first hit from ~9-14s to **~0.2s** (seed served) with fresh data arriving seconds later via the existing background refresh — on both free and paid tiers. Risk is low and contained to the news module. Track 2.1 is a Render config change (a cron or dashboard setting) with no app-code change beyond the already-present `/api/healthz`.

## 6. Tests to add (contract)

- Fresh-module first `/api/news` returns `success:true` with seed articles (`cached:true`) **without** a live fan-out (assert fetch count = 0 for that request).
- Background refresh populated `live:true` articles within a short window (or at least fired).
- Google-block simulation: force `searchGoogleNewsRss` → 0 → response still carries Bing articles (race path).

## 7. Out of scope

- Cold-start of other routes (dataset/static reads, already fast).
- Changing RSS providers or adding Tavily to the list (Tavily stays subhead-only).
