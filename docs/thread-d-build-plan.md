# Thread D — Watch-URL + Report-Upload Ingestion (BUILD PLAN, for review)

Status: **PLANNED, NOT BUILT.** Molly accepted the scope recommendations; this is the implementation plan.

Accepted recommendations: **D1 first**, D2 after, **D3 deferred**; **inline text** storage for MVP (no Supabase Storage bucket); UI **under News+Search**; ingestion target = **separate `sources` table** (citations link into KB).

## Two design decisions to confirm before I build
1. **Citation prefix — `[S#]` vs new `[T#]`:** Today `[S#]` means *the viewing user's own* saved articles (per-user, client-side, C2). D sources are **shared team evidence**. Reusing `[S#]` would collide with a user's personal list and silently change its meaning. **Recommend: introduce `[T#]` (Team/Shared) for D sources**, so `[S#]` stays personal and `[T#]` is the shared, server-backed evidence the Q&A can cite. (This is the one open item from the scope that I think needs an explicit call.)
2. **Read gate:** `GET /api/sources` (list) — should it be **open** (shared reference data, no secrets) or **editor-only** (`requireEditor`)? **Recommend: open read**, writes gated by `requireEditor`. Flag if you'd rather lock reads too.

## Database
- New idempotent script `scripts/migrate-sources.js` (mirrors `seed-datasets.js` pattern; run locally with `DATABASE_URL`, like the pooler seed). Creates table if missing:
  ```sql
  CREATE TABLE IF NOT EXISTS sources (
    id           TEXT PRIMARY KEY,            -- e.g. src_<base36>
    kind         TEXT NOT NULL,               -- 'url' | 'report'
    url          TEXT,
    title        TEXT,
    added_by     TEXT,
    added_at     TIMESTAMPTZ DEFAULT now(),
    last_fetched TIMESTAMPTZ,
    content_hash TEXT,
    status       TEXT DEFAULT 'pending',      -- pending|ingested|failed|changed
    content      TEXT,                        -- extracted text (inline for MVP)
    citation_id  TEXT,                         -- produced [T#] id
    citations    JSONB
  );
  ```

## Shared library — `lib/sources.js` (new)
- `listSources()` → rows ordered by `added_at DESC`.
- `addSourceUrl(url, title, addedBy)` → inserts `pending` row, calls `ingestSource(id)`.
- `ingestSource(id)` → the shared ingest core:
  1. Fetch content via **existing** reader pipeline (`openReaderSplit` → `fetchReaderContent`, `lib/extractor.js`, Thread F attribution).
  2. `classifyItem`/`bestMatch` against the KB (PR #35 anchor rule) to find the AI-policy anchor.
  3. Assign a `[T#]` id (sequential per source row), store extracted `content` + `citation_id`, set `status='ingested'`, write `content_hash`.
  4. Register the source into the **evidence set the Q&A sees** (see Integration below).
- `refreshSource(id)` → re-fetch + re-ingest; on hash change set `status='changed'` (used later by D3).
- All DB access via `getDbPool()` (DB-backed like datasets); degrade to 500 if pool unavailable (consistent with `requireEditor` fail-closed).

## Integration with Q&A (the crux of "actually useful")
For a D source to be citable, its content must reach `runApiModelGeneration`'s `evidence` array. Plan: in `summarise-engine.js` (or `server.js` where evidence is assembled), add a loader that reads `sources` rows with `status IN ('ingested','changed')` and maps each into an evidence item `{ id: citation_id (e.g. "T1"), sourceType: "team", text: content, title, url }`. These join the existing `[A#]`/`[W#]`/`[S#]` evidence. The Q&A system prompt already instructs the model to cite attached sources; extend it to also honor `[T#]` (team-shared).

## Endpoints — `server.js`
- `POST /api/sources` (body `{kind:'url', url, title?}` **or** multipart `{kind:'report', file}`) → `requireEditor` → `addSourceUrl` / `addSourceReport` → returns new source + `[T#]` id.
- `GET /api/sources` → list (open read per decision #2).
- `POST /api/sources/:id/refresh` → `requireEditor` → `refreshSource`.

## UI — `public/app.js` + `index.html` + `styles.css`
- New **"Sources / Watched"** section under the News+Search panel: Add-URL input + button; Upload-report control (D2); list of sources with `status` + Refresh button. **Chrome-only** (no i18n — that is #5).

## Phasing
- **D1 (build now):** `migrate-sources.js` + `lib/sources.js` URL path + 3 endpoints + UI Add-URL/list/refresh + evidence loader + `[T#]` prompt extension.
- **D2 (after D1):** multipart upload. **MVP = text-based files (`.txt`/`.md`/`.json`)** ingested inline; **PDF deferred** (would add a parser dependency — flag if you want PDF now). Same `ingestSource` core + UI upload control.
- **D3 (deferred, documented):** re-use the existing news cron (PR #58) to call `refreshSource` on `kind='url'` rows on a schedule; hash-diff → `status='changed'`; notify via existing SSE. Scope separately once D1+D2 land.

## Tests — `test/sources.test.cjs`
- `lib/sources.js` unit: add/list/refresh with stubbed `fetch` + stubbed DB.
- Endpoint gate: `POST`/`refresh` return **401** without `X-Admin-Key`; **500** when DB unconfigured (mirrors `test/dataset-db.test.cjs`).
- `ingestSource` produces a `[T#]` citation id and sets `status='ingested'`.
- Evidence loader includes an ingested source in the Q&A evidence array.

## Rollout
1. Write plan → Molly approves → implement + tests (target **141 → green suite**).
2. `node --check` + `node --test "test/**/*.test.cjs"`.
3. PR via the rebase-merge skill (GitHub Actions "test" check must be green).
4. Molly runs `scripts/migrate-sources.js` locally with the pooler `DATABASE_URL`.
5. Molly **manual deploys** (Auto-Deploy OFF) → live-verify `POST /api/sources` + `/api/sources` list.
