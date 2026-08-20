# Option B — Opening Deliverable: Knowledge-Base DB Schema, Seed Script & PUT Gate

> **Status:** SPEC ONLY. Not implemented. Green-light separately.
> **Builds on:** `docs/option-b-server-store.md` (why a server store is needed for "editable by all").
> **Scope of THIS deliverable:** make the shared, editable KB durable in Supabase + add a
> gated `PUT` write. The per-user folder slice (`user_folders`) is deferred (later C2 server path).

---

## 1. Architecture (unchanged trust model)

```
Browser ──▶ Express API (/api/datasets/:name) ──▶ Supabase Postgres
              │  gate: ADMIN_API_KEY (or EDITOR_API_KEY)        ▲
              │  attribution: x-editor-name                     │ only thing
              └── never exposes DB creds ───────────────────────┘ that connects
```

- **The Express server is the ONLY DB client.** `DATABASE_URL` lives only in Render env.
- The browser sends the shared team key as a header; it never sees `DATABASE_URL`.
- Because the server is the sole client, **RLS is optional** (defense-in-depth only). The
  `ADMIN_API_KEY` gate on the API is what keeps anonymous web users out. No PHP, no new language.

---

## 2. SQL schema (idempotent — safe to re-run)

```sql
-- Authoritative store for the shared, editable datasets.
-- `name` matches lib/datasets.js DATASET_FILE keys
-- (knowledge, network, tencent-products, current-use-cases, gaming-trends,
--  regulatory-timeline, risks, company-locations).
CREATE TABLE IF NOT EXISTS datasets (
  name       TEXT PRIMARY KEY,
  data       JSONB NOT NULL,            -- full parsed dataset document
  updated_by TEXT NOT NULL DEFAULT 'seed',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  version    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_datasets_updated_at ON datasets (updated_at);

-- Deferred (later C2 server path). NOT part of this deliverable.
CREATE TABLE IF NOT EXISTS user_folders (
  id         TEXT PRIMARY KEY,
  owner      TEXT NOT NULL,
  name       TEXT NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`JSONB` (not `TEXT`) so we can later query/validate inside Postgres if needed.

---

## 3. Seed script (`scripts/seed-datasets.js`)

Loads every file in `lib/datasets.js → DATASET_FILE` into the table. **Idempotent** and
**re-runnable**; keeps the on-disk JSON as a fallback seed only.

```js
// illustrative
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) { console.error('DATABASE_URL missing'); process.exit(1); }
const { DATASET_FILE } = require('../lib/datasets');
const pg = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 5 });
const force = process.argv.includes('--force');

async function main() {
  // ensure schema exists (so Molly doesn't have to paste SQL manually)
  await pool.query(`CREATE TABLE IF NOT EXISTS datasets (
    name TEXT PRIMARY KEY, data JSONB NOT NULL,
    updated_by TEXT NOT NULL DEFAULT 'seed',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    version INTEGER NOT NULL DEFAULT 1 );`);

  for (const [name, file] of Object.entries(DATASET_FILE)) {
    const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', file), 'utf8'));
    if (force) {
      await pool.query(
        `INSERT INTO datasets(name,data,updated_by) VALUES($1,$2::jsonb,'seed')
         ON CONFLICT(name) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
        [name, JSON.stringify(data)]);
    } else {
      await pool.query(
        `INSERT INTO datasets(name,data,updated_by) VALUES($1,$2::jsonb,'seed')
         ON CONFLICT(name) DO NOTHING`,
        [name, JSON.stringify(data)]);
    }
    console.log(`seeded: ${name}`);
  }
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });
```

Run once after env vars are set: `node scripts/seed-datasets.js`.

---

## 4. Read-path change (keeps `getDataset` synchronous)

`lib/datasets.js` is consumed synchronously by ~8 handlers. To avoid rewiring every caller,
**preload** the cache from Supabase at boot and keep `getDataset` as-is (cache-first, disk fallback).

```js
// lib/datasets.js — add:
let dbPool = null;
function attachDb(pool) { dbPool = pool; }

async function primeDatasetCacheFromDb() {
  if (!dbPool) return;
  const { rows } = await dbPool.query('SELECT name, data FROM datasets');
  for (const r of rows) datasetCache[r.name] = { mtime: Date.now(), data: r.data };
}

// getDataset unchanged: cache-first, falls back to disk read on cache miss.
// (Disk JSON stays as a fallback seed if DB is empty/unreachable.)
```

**Refinement implemented:** the cache is now *source-aware*. A DB-backed entry is **sticky**
(`source: "db"`) — a later disk re-read can never shadow a successful PUT, because the
on-disk file is only a fallback seed that may be stale. A disk-backed entry (`source: "disk"`)
still refreshes on mtime change, so the existing `integrateProposal` path (which writes disk)
keeps working. `setDatasetCache(name, data)` writes a sticky db-backed entry after a PUT;
`clearDatasetCache(name)` drops an entry so the next read re-reads disk.

Boot sequence in `server.js`: create the `pg.Pool` from `DATABASE_URL`, call
`attachDb(pool)` + `await primeDatasetCacheFromDb()` **before** `app.listen(...)`.
On cold start the cache is repopulated from Supabase (survives restarts — the whole point).

---

## 5. PUT /api/datasets/:name gate

Generalizes the earlier `knowledge`-only ask to all datasets (cheap, same code), but the UI
exposes an editor only where you want it (start with `knowledge`).

```js
// gate — reuses the existing ADMIN_API_KEY pattern; supports a dedicated EDITOR_API_KEY
function requireEditor(req, res, next) {
  const key = process.env.EDITOR_API_KEY || process.env.ADMIN_API_KEY;
  if (!key) return res.status(500).json({ error: 'Editor auth not configured' });
  const provided = req.get('x-editor-key') || (req.body && req.body.editorKey);
  if (provided !== key) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.put('/api/datasets/:name', requireEditor, async (req, res) => {
  const { name } = req.params;
  if (!DATASET_FILE[name]) return res.status(404).json({ error: 'Unknown dataset' });
  if (typeof req.body !== 'object' || req.body === null)
    return res.status(400).json({ error: 'Body must be a JSON object' });
  const editor = req.get('x-editor-name') || 'unknown';
  try {
    await dbPool.query(
      `INSERT INTO datasets(name,data,updated_by,version)
       VALUES($1,$2::jsonb,$3,1)
       ON CONFLICT(name) DO UPDATE
       SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by,
           updated_at=now(), version=datasets.version+1`,
      [name, JSON.stringify(req.body), editor]);
    clearDatasetCache(name);              // keep sync reads fresh
    res.json({ success: true, name, updated_by: editor });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
```

Edit model = **full-document PUT** (the client sends the entire dataset JSON, e.g. edited in a
textarea). Simplest for "editable by all"; structured diffs can come later. `integrateProposal`
(propose→integrate flow) is untouched and can later be pointed at the DB too.

---

## 6. Render environment variables required

| Var | Source | Purpose | Secret? |
|---|---|---|---|
| `DATABASE_URL` | Supabase → Settings → Database → **Connection string (URI, direct, port 5432)** | Server-only DB connection | **Yes** — keep in Render env only |
| `ADMIN_API_KEY` | Generate: `openssl rand -hex 32` | Reused as the write gate (or set `EDITOR_API_KEY` instead) | **Yes** |
| `EDITOR_API_KEY` | *(optional)* generate similarly | Dedicated editor key if you want it separate from admin | **Yes** |

- Add both to **Render → your service → Environment**. Never commit them; never send to the browser.
- Supabase free-tier direct connections are limited — the `pg.Pool` uses `max: 5`.
- Supabase URI already includes `?sslmode=require` (TLS on by default). Good.
- Network: Supabase accepts connections from anywhere by default. Render free tier has no static
  IP, so leave it open and rely on the strong password in `DATABASE_URL` + the `ADMIN_API_KEY` gate.
  (Tightening to Render IPs is possible only on a paid plan with static egress.)

---

## 7. What Molly needs to provide / decide before I implement

**To set up (you do this in Supabase + Render):**
1. Create the Supabase project (free tier).
2. Add `DATABASE_URL` (direct URI, port 5432) to Render env.
3. Add `ADMIN_API_KEY` to Render env (reuse) — or `EDITOR_API_KEY` if you want a separate editor key.
4. *(No need to paste secrets to me — they live only in Render.)*

**Decisions for me (tell me and I'll implement):**
- **(a)** Reuse `ADMIN_API_KEY` as the gate, or add a separate `EDITOR_API_KEY`? *(Recommend reuse for v1.)*
- **(b)** PUT scope: `knowledge` only, or all 8 datasets durable? *(Recommend all 8 — makes the
  entire shared tier survive cold starts, not just the KB.)*
- **(c)** Edit model: full-document PUT (recommended) vs structured field edits.

---

## 8. Phasing

- **P1 (this deliverable):** table + seed + boot preload + `PUT /api/datasets/:name` gate. KB now durable + attributed + not-anonymously-editable.
- **P2:** Minimal editor UI (load `GET /api/datasets/knowledge`, edit, `PUT` with `x-editor-name`).
- **P3 (deferred):** point `integrateProposal` at the DB; `user_folders` server table for C2.
- **P4:** Optional RLS / per-person Supabase Auth (magic-link login) if you outgrow the shared key.

---

## 9. Safety recap (no PHP, already covered)

Server-as-gateway ⇒ DB creds never leave Render ⇒ `ADMIN_API_KEY` gate blocks anonymous writes ⇒
TLS by default ⇒ input validated server-side. The data is internal-not-secret, so "not openly
editable by the public web" is fully met.
