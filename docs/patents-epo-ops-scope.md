# Patents — EPO OPS live data layer (SCOPE, for review)

> Status: **Phase 1 (MVP) SHIPPED** — live search, durable cache, Patents view, i18n.
> Env-gated: inert until `EPO_OPS_KEY` + `EPO_OPS_SECRET` are set (added to Render 2026-08-28).
> **Phase 2 (live patent landscape) is still OUTSTANDING** — see the note at the end of §5.

## 1. Context — what was removed and why

History of the patents feature on this repo:

| Stage | What | Why it changed |
|---|---|---|
| PR #94 | Full Patents tab ingesting `futureofgaming.com` reports, cross-ref to KB `company-locations`, Supabase `patents` table, `/api/patents` + admin refresh | Worked, but scraped a third-party site |
| PR #100 | Rescoped to a **Google Patents Launch Hub** (human-driven, key-free) | PatentsView/USPTO ODP requires US-citizen ID; Google Patents forbids automated access + blocks iframing |
| PR #101 | **Removed the standalone Patents tab entirely** | Not integral; couldn't be in-app compliantly |
| (kept) | `gaming-trends.json` → `patentLandscape` "Game Technology Patent Signals" | Static, sourced from a `Patents.pdf` research doc, links to Google Patents/GreyB |
| (deferred) | **EPO OPS data layer** | Blocked on Molly's EPO developer account approval |

**The deferred item is what we're returning.** EPO Open Patent Services (OPS) is the compliant path that none of the earlier attempts had: it is the European Patent Office's *official REST API*, explicitly designed for automated access, with no citizenship wall (unlike USPTO). It requires only a registered developer account (ID-validated) + an app registration that yields a Consumer Key / Secret.

Molly has now confirmed EPO OPS access, which unblocks it.

## 2. Goal

Bring **live, compliant patent data** back into the app, cross-referenced to the companies already in the KB, replacing the static `patentLandscape` as the "signal" source and giving the app a real IP-intelligence capability.

Non-goals (explicitly out of scope for now):
- Full-text claims/description analysis (heavy, low BI value per call).
- Patent legal-status / INPADOC legal-event tracking.
- Any Google Patents scraping or USPTO ODP (both remain blocked/infeasible).

## 3. What EPO OPS gives us (grounded facts)

- **Auth:** OAuth2 client-credentials.
  - Register app at https://developers.epo.org → `Consumer Key` + `Consumer Secret`.
  - `POST https://ops.epo.org/3.2/auth/accesstoken` with `Authorization: Basic base64(key:secret)`, body `grant_type=client_credentials`.
  - Response: `{ access_token, token_type: Bearer, expires_in: ~1199 (~20 min) }`. Renew on `invalid_access_token`.
- **Search:** `GET /3.2/rest-services/published-data/search?q=<CQL>` with `Range: items=1-25` header.
  - CQL fields: `pa=` (applicant/assignee), `in=` (inventor), `ti=` (title), `ab=` (abstract), `pd=` (publication date), `cpc=` (classification), `ta=` (title+abstract).
  - The AI×gaming classification set from the old Launch Hub is reusable: **A63F** (games), **G06N** (AI/ML), **G06T** (graphics), **G10L** (speech/audio), **H04N** (video).
- **Retrieval:** `GET /3.2/rest-services/published-data/publication/{docdb}/biblio` (and `abstract`, `claims`, `description`, `images`); `family/publication/{docdb}` for INPADOC family.
- **Response:** JSON (via `Accept: application/json`) or XML.
- **Rate limits (Fair Use):** per-hour and per-week quotas; returns `403` with `X-Rejection-Reason` / `X-Throttling-Control` headers on breach. Must self-throttle and cache aggressively. Weekly quota is ~2.5 GB for registered users.
- **Attribution:** must credit EPO and deep-link to **Espacenet** (EPO's own viewer, ToS-clean for deep-linking — unlike Google Patents which blocks iframing).

## 4. Proposed architecture

```
public/app.js (Patents view)
      │  GET /api/patents?q=<company-or-keyword>&cpc=A63F,G06N&sort=date
      │  (whenAuth(requireAuth) — inert when AUTH_ENABLED=false, same as #106)
      ▼
server.js  /api/patents
      │  1. parse query → CQL
      │  2. hit cache first
      ▼
lib/epoOps.js  (new)
      │  token cache + auto-refresh (client-credentials)
      │  self-throttle (respect X-Throttling-Control / Retry-After)
      │  circuit breaker (2 fails → skip 5 min)   ← mirrors lib/searchProvider.js
      ▼
EPO OPS  (published-data/search → biblio → abstract)
      │
      ▼
cache layer (see §6)  →  normalize → cross-ref to company-locations.json
      │
      ▼
render: patent cards (title, applicant, pub date, CPC, abstract excerpt,
        Espacenet deep-link + "Data: EPO OPS" attribution)
```

Precedent to mirror: `lib/searchProvider.js` already implements the exact "external API + fallback + circuit breaker + throttle" shape used for search. The EPO client is a narrower single-provider version of that: token management + throttle + breaker, no fallback chain (there is no compliant second patent API).

## 5. Phases

### Phase 1 — MVP (live search + company cross-ref) — **DONE 2026-08-28**
- New `lib/epoOps.js`: token cache/refresh, throttle, breaker, `search(q, cpc, range)`, `biblio(docdb)`, `abstract(docdb)`.
- New `GET /api/patents` endpoint (gated `whenAuth(requireAuth)`), query → CQL → OPS → normalized JSON.
- New `GET /api/patents/company-options` (reuses existing `/api/company-locations` names) so the UI can offer a company dropdown (same UX as the old Launch Hub, but OPS-backed).
- Frontend: a **Patents view** (restored) with a search builder — company dropdown, CPC chips (A63F/G06N/G06T/G10L/H04N), keyword input, sort by date — rendering patent cards with Espacenet deep-links + EPO attribution.
- i18n chrome (en + zh-CN) via `locales.js`, following the existing hybrid pattern.
- Env: `EPO_OPS_KEY`, `EPO_OPS_SECRET` (+ `.env.example` placeholders `__WB_*`). Gated off (returns "EPO OPS not configured") when keys absent, so nothing breaks in dev/test.

### Phase 2 — make the landscape "live" (COMMITTED per "Both") — **NOT STARTED**
- Replace/augment the static `gaming-trends.json` `patentLandscape` with a live "recent filings per KB company" fetch (cache + cron refresh), so the "Game Technology Patent Signals" section reflects current activity instead of a one-time PDF.

> **Deferred deliberately, and it needs a decision before it is switched on.**
> The KB carries 31 companies, so a full refresh is ~31 OPS calls. That is far too
> many to run on page load — it would be slow and would trip the per-hour
> throttle. It needs a cron-warmed cache (e.g. one company per tick, 24h TTL)
> rather than a synchronous fan-out, which is a materially different piece of
> work from Phase 1. The static landscape from `Patents.pdf` remains accurate and
> correctly attributed in the meantime, so nothing is broken by waiting.

### Phase 3 (optional, later)
- INPADOC family + abstract enrichment on click; patent-count trend charts; watch-list alerts.

## 6. Persistence — LOCKED: durable Supabase cache

Re-create a `patents_cache` table (PR #94 used a `patents` table that was dropped 2026-08-26). Survives Render cold starts, caps OPS quota burn, and matches the "durable KB in Supabase" pattern the rest of the app already uses. Self-heal at boot (same convention as `proposed_changes`). In-memory cache (option A) is rejected for this feature.

## 7. Decisions (LOCKED, 2026-08-28)

1. **Product surface → BOTH.** Restore the dedicated Patents view **and** wire the gaming-trends patent landscape to live EPO data. (Phases 1–2 below are therefore in scope; Phase 3 remains optional.)
2. **Persistence → Durable Supabase cache** (per §6).
3. **Data depth → Biblio + abstract only.** No claims/description/legal for now (quota-heavy, low BI value).
4. **Credentials → HAVE key + secret.** Molly has the EPO OPS Consumer Key + Secret and will place `EPO_OPS_KEY` / `EPO_OPS_SECRET` in Render env. For local/CI, the code is env-gated (returns a clean "EPO OPS not configured" when keys are absent) so tests never need real keys.

## 8. Risks & mitigations

- **Fair Use quota breach** → self-throttle on `X-Throttling-Control`, honor `Retry-After`, cache aggressively (§6), circuit breaker.
- **Token expiry (20 min)** → cache token, renew on `invalid_access_token` (OPS returns 400 for expired token).
- **ToS/attribution** → credit "Data: EPO OPS"; deep-link Espacenet (not Google Patents); no iframing.
- **Key leak** → keys stay in Render env only; `.env.example` uses `__WB_*` placeholders (already allowlisted in `.gitleaks.toml`); `secret-scan` runs in CI.
- **OPS endpoint drift** (`/3.2/rest-services` vs `/rest-services`) → confirm exact base at implementation time against the OPS v3.2 reference guide; pin it in a single constant.

## 9. Test plan

- `test/epo-ops.test.cjs` — pure-logic unit tests with an injected `fetchImpl` (no network), mirroring `test/search-provider.test.cjs`: CQL builder, token-refresh-on-expiry, throttle behavior, breaker open/close, response normalization, cross-ref matching.
- `test/api-contract.test.cjs` — through-route tests: `/api/patents` returns 200 with normalized cards when OPS mocked; returns a clear "not configured" error when keys absent; auth gate is inert when `AUTH_ENABLED=false`.
- `node --check` + full suite (`node --test "test/**/*.test.cjs"`) must stay green (currently 281/281).

## 10. Deployment notes

- Render Auto-Deploy is OFF → manual deploy after merge.
- Env vars to add in Render: `EPO_OPS_KEY`, `EPO_OPS_SECRET`.
- No model/env changes beyond those two keys; the app already has the Supabase + auth scaffolding to reuse.
