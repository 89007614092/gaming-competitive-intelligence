# Patents Phase 2 — live gaming-trends landscape

**Status: design pass, no code yet.** The purpose of this document is to settle
bucket sizing and quota budgeting *before* writing anything, because the binding
constraint is an external API quota that we cannot increase and that can silently
degrade a feature that already works.

---

## 1. Goal

`data/gaming-trends.json` already contains a `patentLandscape` object, but it is
**static prose curated from a PDF**: two companies (Rockstar / Take-Two, Activision
Blizzard), hand-written summaries, links out. It never changes.

Phase 2 makes that landscape **live**: real EPO OPS filing data, refreshed on a
schedule, so the Gaming Trends view shows patent activity that actually moves.

**Non-goals for this phase:** INPADOC families, abstracts on click, trend charts over
time, watch-lists. Those are Phase 3 and each carries its own quota cost.

---

## 2. What already exists (measured, not assumed)

| Thing | Value |
|---|---|
| Tracked companies (`trackedCompanies()`: 1 centre + competitors) | **41** (Tencent, NetEase, ByteDance, miHoYo, Sony, Microsoft, Nintendo, Epic, Unity, Roblox, Krafton …) |
| CPC groups | **4** (Games, AI, Language & interaction, Delivery & graphics) |
| CPC chips (UI granularity) | **24** |
| CPC all codes / default | 37 / 1 |
| Trends in `gaming-trends.json` | **9**, across **5** categories |
| Curated landscape today | **2 companies** — neither in the tracked 41 |
| Cache | Postgres `patents_cache`, versioned keys (`v2~…`, `cpccount:<version>:…`), 7-day TTL sweep |
| Protection | circuit breaker (2 failures → open), quota-signal detection, token cache |
| Live state right now | `configured: true, circuitOpen: false, throttled: false, failures: 0` |
| Measurement tools | `/api/patents/probe-cpc-format`, `/api/patents/validate-cpc` (both admin-gated) |

---

## 3. The constraint, and the honest uncertainty

The OPS Fair Use quota for **search** is small — on the order of **15 per window** —
and the breaker opens after two failures. Two things matter:

1. **We do not know the window length with certainty.** If it is per-minute, warming
   is easy. If it is per-week, warming is nearly impossible. These demand completely
   different designs, and guessing wrong is expensive.
2. **Failure is contagious.** An exhausted quota or an open breaker doesn't just stop
   the landscape — it stops *interactive* patent search, which works today.

That is why the first step is measurement, not scheduling.

---

## 4. Bucket sizing

A "bucket" is one OPS search whose result we store. The landscape is the union of
warmed buckets.

| Option | Buckets | Cost per full refresh | Verdict |
|---|---|---|---|
| Company × chip | 41 × 24 = **984** | 984 searches | Impossible under any plausible quota |
| Company × group | 41 × 4 = **164** | 164 searches | Still far too expensive |
| **Technology volume** (per CPC chip) | **24** | 24 searches | ✅ Affordable, gives the trend view its numbers |
| **Company volume** (top N, gaming CPC) | **N** (start 12) | 12 searches | ✅ Affordable, gives "who is filing" |
| Company × chip intersections | on demand | 0 (interactive, cache-first) | ✅ Already how drill-down works |

**Recommended shape — three tiers:**

- **T1 — technology volume (24 buckets).** Filing volume per CPC chip: how much patent
  activity exists in each technology area. This is the number that makes a *trend* view
  meaningful.
- **T2 — company volume (top N, start 12).** Filing volume per company within the games
  CPC. Answers "who is actually filing". Start with 12, expand only if the quota allows.
- **T3 — intersections.** Never warmed. Company × chip stays interactive and
  cache-first, exactly as today.

**Pre-warmed total: ~36 searches per full refresh cycle** — versus 984 for the naive
approach.

---

## 5. Quota budgeting

The governor is the real deliverable; the buckets are easy once it exists.

- **Ledger.** Count searches used in the current window, persisted (a cache row keyed
  by window id), so a restart doesn't reset our idea of what we've spent.
- **Reserve for humans.** Warming may use at most ~60% of the window; the rest is
  reserved for interactive search. If remaining budget is below the reserve, warming
  stops and waits. **Warming must never be able to starve a user.**
- **Per-tick cap.** One bucket per tick, ticks hourly with jitter. Even if the ledger
  is wrong, the worst case is bounded and slow rather than a burst.
- **Backoff on quota signals.** A 403 with a quota hint stops warming until the window
  resets. No aggressive retries — that is what opens the breaker.
- **Kill switch.** An env flag disables warming entirely without a deploy-to-rollback.

---

## 6. Storage and honesty

- Reuse `patents_cache` with a **versioned** landscape prefix, e.g.
  `landscape:v1:<dimension>:<id>`, plus one meta row holding `asOf` per dimension.
  The version in the key follows the existing `CPC_COUNT_VERSION` precedent: if the
  query shape changes, old rows become unreachable instead of silently misleading.
- **Staleness is displayed, not hidden.** Every number carries "as of <date>". If data
  is beyond its TTL, say so rather than presenting it as current.
- **Fallback ladder:**
  1. live data, fresh → show it
  2. live data, stale → show it, labelled with its age
  3. no live data (unconfigured / quota exhausted / breaker open) → show the **curated
     prose**, clearly labelled "curated, not live"
- **Compliance, unchanged:** deep links go to Espacenet, never Google Patents, and
  "Data: EPO OPS" stays visible and untranslated.

---

## 7. Proposed PR split

| PR | Contents | Risk |
|---|---|---|
| **0 — measure** | Report the OPS throttling control through the existing probe path so we can *read* the real quota and window. No scheduling, no callers. | None (read-only) |
| **1 — governor** | Ledger + reserve + per-tick cap + backoff + kill switch, with tests. Still no callers. | Low |
| **2 — T1** | Technology volume: 24 buckets, warmed, stored, surfaced in the UI with "as of" and static fallback. | Medium |
| **3 — T2** | Company volume (top 12) + provenance + expansion path gated on measured quota. | Medium |

PR 0 exists specifically so PRs 1–3 are sized against a *measured* number. If
measurement shows the window is very tight, T2 may be dropped or reduced to a handful
of companies — better to know that at PR 0 than after PR 3.

---

## 8. Open questions

1. **Which headline?** Technology volume (T1) or company volume (T2)? They cost
   differently and answer different questions.
2. **The curated two.** Keep Rockstar / Activision Blizzard prose alongside the live
   tracked 41, or replace it? They are different company sets, so "replace" loses
   content that isn't in the tracked data.
3. **Refresh cadence.** Monthly is comfortable; weekly is the target for anything
   claiming to be a *trend*. Depends on PR 0.
4. **Replace or augment the prose?** Live numbers beside the curated text, or numbers
   that supersede it?

---

## 9. Why design first

The failure mode here is not "the landscape is missing" — it is **"patent search
stops working"**, because warming ate the quota or tripped the breaker. That is a
regression of a working feature, and it is the one outcome this phase must avoid.
Hence: measure, then budget, then build.

---

## 10. Decisions (settled 2025-09-25)

### D1 — Lead with technology volume (T1), and get "who" for free

Molly's reasoning for preferring T1 over T2 is better than the one in section 4:
a company leaderboard is **bounded by the competitor list**, so a technology being
patented by an unknown company is invisible — a restricted view *and* noisier
quality. Technology volume has no such blind spot.

**Her dilemma has a free solution.** A T1 search already returns sample documents
with applicant names, and `server.js` can already cross-reference a patent against
the tracked companies (matching on distinctive tokens, so "DeepMind Limited"
resolves to Google DeepMind). So per chip we can compute, with **no extra OPS
call**:

> Virtual worlds & agents — 1,240 filings · **9 of the 25 most recent are from
> tracked competitors** (Tencent, NetEase, Unity)

Cost: still 24 searches. Two honesty requirements:

- it is a share **of the sample returned**, not of the whole corpus — label it that
  way ("of the most recent N filings"), never as a percentage of all filings
- applicant matching is imperfect, so this is a *signal*, not an exact count

This gives the "who" without the 41×24 intersection cost and without T2's blind spot.

### D2 — Add Activision Blizzard and Rockstar / Take-Two

Agreed for consistency: they are in the curated prose but absent from the tracked
list (41 → 43).

**Open sub-decision — the news-cron cost.** `network.json` competitors feed both
`trackedCompanies()` (patents) and `newsCompetitorCatalog` (news cron, every 5
minutes), so adding two companies permanently increases recurring news search
volume. Two options:

- **(a)** add to both — accept the ongoing news cost
- **(b)** add to patents only, via an opt-out flag honoured by the news catalogue
  (e.g. `newsScan: false`), ~10 lines

Recommend **(b)** to avoid an unbounded recurring cost we haven't budgeted, with
the flag flipped later if news coverage is wanted.

### D3 — Monthly refresh

Chosen as lower-cost and better suited:

- patent data moves slowly (publication lags priority by ~18 months), so weekly
  adds little signal while costing ~4× more (24/month vs ~104/month)
- the 12-hour cache TTL plus on-demand queries already cover any staleness for a
  chip the user actually opens
- cadence is the easiest knob to turn later — start conservative, increase for a
  subset (e.g. the top 6 chips) only if measurement shows real headroom

### D4 — Augment the prose, do not supersede it

Live figures are added beside the curated narrative, which stays. Rationale: a
filing count cannot express *what* a company is protecting (AI-driven NPC
behaviour, procedural animation) — that is editorial value worth keeping. It also
means the section degrades gracefully when OPS is unavailable, and it lets the
curated claims for Activision and Rockstar be read against live numbers.

---

## 11. Next step: PR #139 (measurement)

Adds the ability to **read** the OPS throttling control (green/yellow/red and the
window) rather than infer it. Read-only, no scheduling, no callers, cannot degrade
interactive search.

Because OPS credentials are not available locally, this needs one deploy, then a
single value read from the admin probe (or a log line) to settle D3's headroom and
confirm whether T2 becomes affordable later.

### D2 — CORRECTED: both companies were already tracked

~~Add Activision Blizzard and Rockstar / Take-Two.~~ **Not needed — and the premise
was wrong.**

Section 4 claims the two curated companies are "neither in the tracked 41". That
was an error from comparing exact strings. The list already contains:

- `activision-blizzard` — "Activision Blizzard"
- `take-two` — "Take-Two / Rockstar Games" (name order differs, which is why a
  literal search missed it)

So both are **already** in `trackedCompanies()` and **already** in
`newsCompetitorCatalog`. The news-cron cost question in D2 is moot: that cost is
already being paid today, and no change increases it. Nothing to add, nothing to
budget.

Lesson recorded: verify membership by id/normalised name, not by exact display
string.
