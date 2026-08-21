# Thread D — Watch-URL + Report-Upload Ingestion (SCOPE, for review)

Status: **SCOPED, NOT BUILT.** Molly to review before implementation.

## Goal
Let a team member push external material into the *shared* intelligence layer:
- **D1 — attach-URL-as-source:** paste a URL; it becomes a tracked source, run through the existing reader + classification pipeline, and stored as shared evidence.
- **D2 — report-upload:** upload a PDF/report; extract its text and ingest it as shared evidence.
- **D3 (optional) — recurring watch:** watched URLs re-fetch on a schedule; changes are flagged.

All server-side, team-shared, gated by the existing `ADMIN_API_KEY` (`requireEditor`), stored in the Supabase store established by Option B.

## Why now
The server-store fork (Option B, PRs #65/#66) has shipped and is live — a durable, shared store now exists. D was blocked on that decision; it is now unblocked. C2's *server* path was killed, so per-user News+Search folders stay client-side (Option A). D is explicitly the **shared** ingestion path, complementing — not competing with — C2.

## Reused building blocks (do NOT rebuild)
- **Reader / extraction:** `openReaderSplit` → `GET /api/reader` → `fetchReaderContent`; `lib/extractor.js` (Jina server-side, dual-fail). (PRs #33/#34/#40; Thread F attribution #63.)
- **Classification:** `classifyItem` → `bestMatch` against the KB. (PR #35 guardrail — AI-policy anchor required.)
- **Shared store:** `lib/datasets.js` (Supabase-backed) + `requireEditor` gate (Option B).
- **Scheduling:** news cron + SSE already exist (PR #58) — reused for D3.
- **Citations:** `[S#]` MySources scheme already exists for user evidence.

## Proposed data model
New Supabase table `sources` (mirrors `datasets` shape):
| column | type | notes |
|---|---|---|
| id | UUID PK | |
| kind | TEXT | `'url'` \| `'report'` |
| url | TEXT NULL | for url kind |
| title | TEXT | |
| added_by | TEXT | `x-editor-name` |
| added_at | TIMESTAMPTZ | |
| last_fetched | TIMESTAMPTZ NULL | |
| content_hash | TEXT NULL | for D3 diff |
| status | TEXT | `'pending'\|'ingested'\|'failed'\|'changed'` |
| storage_ref | TEXT NULL | report file ref (Supabase Storage) or inline text |
| citations | JSONB NULL | `[S#]` ids produced |

## Proposed endpoints
- `POST /api/sources` — register URL **or** upload report (multipart). `requireEditor`. Triggers ingestion.
- `GET /api/sources` — list (admin).
- `POST /api/sources/:id/refresh` — re-fetch + re-ingest (also invoked by D3 cron).
- Ingestion writes into the shared evidence store and emits the resulting `[S#]` citations.

## Proposed UI
A **"Sources / Watched"** panel — either a new tab or a section under News+Search. Controls: Add URL, Upload report, Refresh, list with status. Chrome-only; no i18n yet (that is #5).

## Phasing
- **D1 (URL as source):** paste URL → reader pipeline → classify → store as source + `[S#]` evidence. Smallest; proves the pattern end-to-end.
- **D2 (report upload):** multipart upload → extract text (PDF/report) → ingest as evidence. Depends on the storage decision below.
- **D3 (recurring watch):** reuse news cron to re-fetch watched URLs, hash-diff, flag `changed`, notify via existing SSE. **Optional** — scope separately after D1+D2 land.

## Open decisions for Molly to review
1. **Report storage:** Supabase Storage bucket vs inline text in `sources` JSONB. *Recommend inline text for MVP, Storage later.*
2. **UI location:** new top-level tab vs under News+Search.
3. **D3 scope:** in-scope now or deferred to a later pass?
4. **Ingestion target:** append to the shared `knowledge` dataset vs a separate `sources` table that citations link into. *Recommend the separate `sources` table (cleaner, audit-friendly).*

## Out of scope
- Per-user folder sync (C2, client-side, DONE via Option A).
- i18n (#5).
- 2nd-model failover (#1) — separate track.
