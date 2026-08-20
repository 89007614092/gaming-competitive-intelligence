# Option B — Server-Authoritative Store (Editable-by-All KB + Server Folders)

> Status: **SPEC ONLY** (not implemented). Thread C1 (folder rename/delete) and Option A
> (folder export/import) are shipped client-side. This document scopes the server store
> that "editable by all" makes mandatory.
>
> Driver: Molly confirmed the central Knowledge Base is **editable by all** team members
> (not read-only-curated). That single fact promotes the KB from a committed static file
> to a **server-authoritative, mutable, shared dataset** — which is the Option B fork we
> deferred earlier, now a requirement rather than a nice-to-have.

## 0. TL;DR — what you need to prepare

| Need | Today | For "editable by all" |
|---|---|---|
| KB storage | `data/knowledge.json` (committed, static) | **Durable DB** (off-Render managed Postgres free tier, or SQLite on paid Render Disk) |
| KB writes | admin-only `integrate` → `fs.writeFileSync` to **ephemeral disk** | Same write path, but to the DB; relaxed gate |
| Identity | single `ADMIN_API_KEY` (optional shared secret) | per-editor **username/team token** for attribution |
| Folders | `localStorage` only (Option A covers portability) | stay client-side, OR move server-side later (roaming/backup) |

**Minimum to satisfy "editable by all":** one small database + a relaxed, attributed
write gate. No new front-end framework; the existing JSON shape is preserved.

## 1. The reframe

Earlier we treated the shared KB as **read-only-shared** (curators publish, everyone
reads), which let it stay a static file. "Editable by all" changes that:

- The KB must accept runtime writes from **any team member**, not just an admin integrate step.
- Those writes must **survive Render cold starts / deploys** — today they do **not** (see §2).
- We want to know **who** changed what (a team, not anonymous).

This is exactly the "should user data live on the server, and where?" fork we identified
as the gate for Thread C (server path), D (watch-URL/report-upload), and now the KB. One
DB decision unblocks all three.

## 2. Current state (verified in code)

| Concern | Where | Mechanism | Problem for "editable by all" |
|---|---|---|---|
| KB read | `GET /api/knowledge` (server.js:3774) → `getDataset("knowledge")` (server.js:2962–2976) | loads `data/knowledge.json`, mtime-cached in `contentCache` | fine as-is |
| KB write | `integrateProposal` (server.js:3149–3202) | `fs.writeFileSync` to `data/knowledge.json` (server.js:3195), then `clearDatasetCache` (server.js:3200) | **writes to ephemeral disk → lost on cold start/deploy** |
| KB auth | `requireAdmin` (server.js:3670–3676) on the integrate route (server.js:3679) | `ADMIN_API_KEY` unset ⇒ `next()` (open); set ⇒ requires `X-Admin-Key` | gate exists but is a single shared secret, not per-user |
| Timeline / use-cases | same `integrateProposal` + `fileMap` (server.js:3150) | same ephemeral-disk write | same problem |
| Folders | `newsFolders` / `savedNewsArticles` in `localStorage` (app.js:911–951) | browser only, no server path | already portable via Option A |

Key insight: **the write path already exists** (`integrateProposal`). The two gaps are
(1) durability (ephemeral disk) and (2) identity/attribution + a *direct* edit path (today
you can only write by first creating a proposal and integrating it). "Editable by all"
mostly means **make the existing write durable + attributed + directly callable**.

## 3. What to prepare

### 3.1 Durable store (required)
Render free-tier disk is **ephemeral** — a cold start or deploy wipes `data/*.json`. That is
why integrated proposals already silently disappear on restart. Options:

| Option | Pros | Cons |
|---|---|---|
| **Managed Postgres (Neon / Supabase free tier)** — *recommended* | Off-Render → survives cold starts; free; zero infra; easy backup | New external dependency (hurts the keyless/free-tier longevity story, but the KB is the crown jewel) |
| SQLite on **Render persistent Disk** (paid) | Single file, simplest schema, no new vendor | Needs paid Disk; disk still a Render-managed resource |
| Keep `fs.writeFileSync` to `data/` | Zero change | **Disqualified** — loses edits on every cold start |

Recommendation: **managed Postgres free tier**. One connection string env var; the rest of
the app stays keyless/ephemeral except the KB (and later folders/D).

### 3.2 Identity & attribution (required, minimal)
Today there is only `ADMIN_API_KEY`. For "editable by all" we need *who*, not *whether*.

- **Tier 1 (recommended for one trusted team):** first-run prompt for a display name;
  client stores it in `localStorage` and sends `x-editor-name` on writes. Server records
  `updated_by`. No passwords, no accounts.
- **Tier 2 (if needed later):** a shared `TEAM_API_KEY` or lightweight accounts.

The KB content is already team-shared, so server storage is **not** a privacy regression
for the KB. It *is* a minor inversion for the per-user folder slice (§5) — but folders are
just names + article references.

### 3.3 Direct edit API (required for "editable by all")
Today you can only mutate the KB by proposing then integrating. Add a direct upsert:

- `PUT /api/knowledge` — body `{ dataset, categoryKey?, subsection }`; requires team identity;
  records `updated_by` / `updated_at`. Reuses `integrateProposal`'s merge logic (§4) without
  the propose queue.

### 3.4 Migration (one-time)
On first boot, seed the DB rows from the existing `data/knowledge.json`,
`regulatory-timeline.json`, `current-use-cases.json`. Keep the JSON files as the canonical
**seed/fallback** so the app still boots if the DB is unreachable.

### 3.5 Conflict handling
Single team, low contention → **last-write-wins per subsection/record**. Store
`updated_by` + `updated_at` for audit. (True CRDT/merge is over-engineering here.)

### 3.6 Backup
Managed Postgres handles this automatically. If SQLite-on-disk is chosen, schedule snapshots.

## 4. Recommended design — JSON-document store (minimal schema change)

Preserve the existing JSON shape; store each dataset as **one row**:

```
datasets ( dataset TEXT PK, data JSONB, updated_by TEXT, updated_at TIMESTAMPTZ )
```

- `GET /api/knowledge` keeps calling `getDataset` — but `getDataset` reads from the DB row
  instead of `fs.readFileSync`. The mtime-cache logic is replaced by a simple in-process
  cache invalidated on write.
- `integrateProposal` and the new `PUT /api/knowledge` both call
  `upsertDataset(dataset, data, updatedBy)` → `UPDATE datasets SET data=..., updated_by=..., updated_at=now() WHERE dataset=?`.
- No relational decomposition of categories/subsections needed — the JSON shape is already
  correct and the client renders it as-is.

This is the **same fork** that unblocks Thread D (watch-URL / report-upload): one DB,
many tables.

## 5. Per-user folders on the server (the original Option B slice)

Once the DB exists, moving folders server-side is trivial — a second small table:

```
user_folders ( user_id TEXT, folders_json JSONB, saved_articles_json JSONB, updated_at TIMESTAMPTZ, PK(user_id) )
```

- Client calls `GET/PUT /api/user/folders` using the identity header (§3.2).
- Gains: any-device roaming, central backup, device-loss survival.
- This is **optional** — Option A (shipped this turn) already gives portability via
  export/import. Move folders server-side only if a concrete roaming/backup need appears.

## 6. API surface (proposed)

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/knowledge` | none | serve KB (unchanged) |
| PUT | `/api/knowledge` | team identity | directly upsert an entry (editable by all) |
| POST | `/api/proposed-changes/:id/integrate` | admin (existing) | curated propose→integrate queue |
| GET | `/api/user/folders` | team identity | read this user's folders (Option B) |
| PUT | `/api/user/folders` | team identity | write this user's folders (Option B) |

## 7. Phasing

1. **P1 — Durable + attributed KB (the core of "editable by all"):** stand up DB, seed
   migration, `upsertDataset`, relax the gate to team identity (`x-editor-name`), repoint
   `getDataset`/`integrateProposal`. KB now survives cold starts and records authors.
2. **P2 — Direct edit UI:** inline add/edit KB entries in the client calling `PUT /api/knowledge`.
3. **P3 — Server folders (Option B):** move per-user folders to `user_folders` for roaming/backup.
4. **P4 — Polish:** backup verification, `updated_by` audit view, conflict messaging.

## 8. Risks / trade-offs

- **New external dependency (DB):** weakens the keyless/free-tier longevity story, but the KB
  is the highest-value data and the rest of the app stays ephemeral. Mitigated by an
  off-Render managed free tier.
- **Attack surface (write API):** mitigated by team-only identity, input validation, and
  size caps on `data` payloads.
- **Cold start:** DB off-Render means news/cron caches are still ephemeral, but the KB (the
  crown jewel) is now durable.
- **Privacy inversion (minor):** only the folder slice; KB content was already shared.

## 9. Verification

- Boot with `DATABASE_URL` set → KB seeded from JSON; edit via `PUT /api/knowledge` →
  persists across a forced cold start (restart the server, confirm the edit remains).
- `GET /api/knowledge` reflects writes; `updated_by` is recorded.
- With `DATABASE_URL` unset → app still boots from the JSON seed (graceful fallback).
- Existing test suite stays green (no change to pure functions; add a contract test for
  `PUT /api/knowledge` with and without identity).

## 10. Relation to other threads

- **Supersedes** the longevity-doc "ephemeral disk" worry for the KB — edits no longer lost.
- **Unblocks Thread D** (watch-URL / report-upload) — same DB, new tables.
- **Option A (this turn)** ships client-side folder export/import now, so users get
  portability immediately while Option B is specced for later.
