# Longevity & "Live Updates" — Analysis and Roadmap

**Purpose.** This is the durable record for the longevity / robustness work on the
AI×Gaming BI web app. It captures: (1) what happens if an external dependency
suddenly changes its terms, (2) the overall resilience verdict, and (3) the
multi-stage roadmap for making the app *feel* live without burning AI tokens.

**Status.** Thread A (this doc) — written 2026-08-20. Thread B (news-refresh cron
+ SSE push) — implemented same session, pending deploy. Threads C/D + 2nd-model
failover — open, awaiting decision.

---

## 1. Why this matters now

The app has stabilised on performance (cold-start fix shipped, news + search
caches live-verified). The next maturity axis is **longevity**: if a provider
changes its terms, a key expires, or the free tier is retired, how badly does the
app degrade, and what must a human do to recover?

A second, related ask: *Suggested Updates* is "okay but not the full standard" —
the app should **feel more live**, but we are token-limited, so AI cannot sit on
the hot path. The resolution is to keep AI as an on-demand garnish and drive
"live" through cheap, keyless, pre-AI mechanisms: scheduled jobs, RSS
aggregation, and client push.

---

## 2. Blast radius — if an API changes its terms tomorrow

| Dependency | Powers | Fallback today | Severity if it breaks | Mitigation |
|---|---|---|---|---|
| **Google News RSS** | Article LIST (`/api/news`) | Bing News RSS, then bundled seed | Low | Already a fan-out with Bing fallback + seed cache |
| **Bing News RSS** | Article LIST fallback | Bundled seed (`data/news-cache.json`) | Low | Seed cache; apiclick.aspx URLs unwrapped |
| **Tavily** | `/api/search`, `/api/news/subhead`, gaming-trends discovery | **None** | **HIGH** | Only external dep with no fallback. Add a secondary search-provider seam (mirror the `createExtractor` pattern) or a keyless DuckDuckGo fallback. Search is a core Q&A feature — this is the #1 fragility. |
| **Jina** | Server-side article extraction (`/api/reader`) | `createExtractor` → Firecrawl seam | Medium (mitigated) | `EXTRACTOR_PROVIDER=firecrawl` + `FIRECRAWL_API_KEY` swaps provider. |
| **OPEN_MODEL_\*** (Groq/OpenRouter) | Summaries, Q&A, *Suggested Updates* draft | Repoint env | Medium (mitigated) | OpenAI-compatible; change `OPEN_MODEL_BASE_URL`/`KEY`. A 2nd key = new env var + selector (trivial). |
| **Render** (hosting) | Everything at runtime | Portable Express app | Medium (operational) | No Render lock-in; redeploy anywhere. **Real risk = ephemeral free-tier disk** (see §3). |

**Key finding:** the data *pipeline* (news, sources, reader) is resilient by
design — every external call has a fallback except Tavily. The two genuine
single-points are **Tavily** (no fallback) and **Render free-tier ephemeral
disk** (user data lost on cold start).

---

## 3. Longevity verdict

**Robust where it counts.** News has Google→Bing→seed fallback. The reader has a
Jina→Firecrawl seam. The LLM is env-repointable. The source-scan scheduler is
already clock-driven (`setInterval` in `server.js`, guarded by
`require.main === module`).

**Weak spots.**
1. **Tavily** — no fallback for search/subhead/discovery. A terms change or
   killed free tier breaks core search with no degrade path.
2. **Ephemeral disk** — on Render free tier every cold start is a fresh process
   and the local filesystem is **not** guaranteed to persist. Today the only
   server-written state is `source-state` (scanned proposals), which is
   re-derivable. But **any future user-created data** (custom competitors,
   saved-article folders, uploaded reports, watch-URLs) would be **lost on cold
   start** unless it lives in a database or an external store. This is the
   binding constraint for Threads C and D.

**Principle going forward.** Keep AI **off** the live path. "Live" =
RSS + cron + SSE push (all cheap/keyless). AI enrichment (subheads, summaries,
proposed-change previews) is **on-demand**, fired by a user action or a
bounded background job, never required to show fresh data.

---

## 4. Work threads (roadmap)

| Thread | Scope | Status |
|---|---|---|
| **A** | This record doc (analysis + roadmap) | **Done 2026-08-20** |
| **B** | News-refresh **cron** (clock-driven) + **SSE push** to clients | **In progress** (this session) |
| **C** | User-data **persistence** + folder CRUD (the disk-vs-DB decision) | Open — blocks user-created data |
| **D** | **Watch-URL** ingestion + **report upload** → knowledge base `[S#]` | Open |
| Opt. | **2nd model / failover** (distinct `OPEN_MODEL_*_SCAN` key already supported) | Trivial env change; no code |

**Recommended order:** B first (highest "live" feel per token/risk, no new
dependency), then C (persistence decision must land before any user data is
stored), then D (reuses `/api/reader` + the `[S#]` citation scheme).

---

## 5. Thread B — spec & implementation notes

**Goal.** News stays fresh on a fixed clock even with zero visitors, and any
open client tab is notified the moment a refresh lands — so the feed *feels*
live without anyone polling and without spending AI tokens.

**Design.**
- *Server cron* (`server.js`, beside the source-scan `setInterval`, guarded by
  `require.main === module`): on a configurable `NEWS_CRON_MS` (default 5 min)
  it calls `triggerNewsBackgroundRefresh(defaultKey, resolveNewsCompetitors())`.
  That reuses the existing coalesced, single-flight refresh (keyless
  Google/Bing RSS fan-out — no tokens).
- *SSE endpoint* `GET /api/news/stream`: opens `text/event-stream`, registers
  the response in a `newsSseClients` Set, sends a `: connected` frame, and a
  20s `: ping` heartbeat (keep-alive through proxies). On `req` close it
  de-registers.
- *Broadcast hook*: inside `triggerNewsBackgroundRefresh` (and the explicit
  `?refresh` live path), after `cacheNews(...)` succeeds, call
  `broadcastNewsUpdate({ type:"news-updated", key, source, count, generatedAt })`.
  Each SSE client receives `event: news-updated\ndata: {...}`.
- *Client* (`public/app.js`): a single `EventSource('/api/news/stream')` opened
  at boot. On `news-updated`: reveal a `↻ New updates` pill; if the News view is
  already active, auto-reload the feed. Clicking the pill reloads manually. No
  decorative emoji — line-glyph controls only (PR #46 convention).
- *Config*: `NEWS_CRON_MS` added to `config.js` (`num(..., 5*60*1000)`) and
  documented in `.env.example`.

**Why this is safe.** The fan-out is keyless RSS (already proven resilient); the
SSE path allocates only a small Set of open sockets and cleans them on
disconnect; the cron is guarded so contract tests never trigger real fetches.

**Tests.** `test/api-contract.test.cjs` gains an SSE contract test: opens
`/api/news/stream` via `realFetch` + `AbortController`, asserts `200` +
`content-type: text/event-stream`, reads one frame, then aborts (no hang,
socket cleaned up).

**Rollout.** Branch → `node --check` + `node --test` → PR → rebase-merge →
Molly deploys manually (Auto-Deploy off) → live-verify: open the app, watch the
News tab auto-refresh ~5 min after last activity / on the cron tick, and confirm
the pill appears when the tab is hidden.

---

## 6. Open decisions (needed before C/D)

1. **Persistence backend for user data.** Options: (a) stay on disk but point at
   a mounted persistent volume (Render Disk) — minimal code, single-instance
   only; (b) external store (SQLite on a volume, or a hosted DB) — survives
   restarts + scales, more setup. This decides whether folders/saved-articles/
   uploads are safe. **Recommend deciding before Thread C starts.**
2. **Tavily fallback** (Thread "Tavily" above). Add a secondary search-provider
   seam now, or accept the single-point until it bites? Recommend a lightweight
   keyless DuckDuckGo fallback for the search box at minimum.
3. **Watch-URL vs upload ingestion** scope for D — both feed the same
   "user evidence → `[S#]`" path; confirm whether uploads need parsing/summarisation
   (AI, on-demand) or just storage + retrieval (no AI).
