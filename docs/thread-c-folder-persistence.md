# Thread C — Folder CRUD & Persistence (Spec / Plan)

> Status: **C1 IMPLEMENTED** (folder rename + delete, client-only). **C2 DEFERRED** (cross-device sync).
>
> C1 shipped as `renameFolder` / `deleteFolder` / `countArticlesInFolder` + an `openFolderActionMenu`
> popover in `public/app.js`, with `.folder-chip-wrap` / `.folder-chip-more` / `.folder-action-*`
> styles in `public/styles.css`. No backend, no schema, no new dependency.

## 1. Current state (verified in code)

| Concern | Where | Mechanism |
|---|---|---|
| Folders | `newsFolders` array | **Browser `localStorage`** — `NEWS_FOLDERS_KEY` (app.js:909–945) |
| Saved articles | `savedNewsArticles` array | **Browser `localStorage`** — `SAVED_ARTICLES_KEY` (app.js:908–941) |
| Folder ops today | `createFolder` (1034), `listFolders` (1047), `getArticleFolders` (1051), `toggleArticleFolder` (1072), `renderFoldersSidebar` (1100), `openFolderMenu` (1123), `setupFolderUI` (1197) | create + toggle only |
| Was missing (now added by C1) | `renameFolder`, `deleteFolder`, `countArticlesInFolder`, `openFolderActionMenu` | rename + delete-with-cascade |
| "All Saved" | `activeFolderFilter = null` | pseudo-folder, not a real entry |

## 2. Important reframe (corrects the longevity-doc worry)

The longevity doc flagged *"Render free-tier ephemeral disk"* as a user-data risk. That risk applies **only to server-persisted user data**, which today is:

- `data/custom-competitors.json` (user-added competitors) — wiped on cold start / deploy.
- `data/proposed-changes.json` (Suggested Updates queue) — wiped on cold start / deploy.
- `data/source-state.json` (last-scan timestamp) — wiped; boot-scan guard resets (by design on free tier).

**Folders and saved articles are browser-held `localStorage`** and therefore **already survive Render cold starts**. The "disk vs DB" panic does **not** apply to Thread C's folders. The only reason to introduce a DB here is cross-device sync (see C2).

## 3. Scope

### C1 — Folder delete + rename (the actual ask; low-risk, client-only)

**`deleteFolder(id)`**
- Guard: ignore if `id` is `null`/`""` (All Saved) or not found.
- Cascade: strip `id` from `folderIds` of every `savedNewsArticles` entry. Articles remain in "All Saved".
- Remove from `newsFolders`; `saveNewsFolders()`.
- If `activeFolderFilter === id`, reset to `null`.
- Re-render sidebar + saved list.

**`renameFolder(id, name)`**
- Validate: non-empty, trimmed, ≤40 chars; reject exact-duplicate name.
- Update `name`; `saveNewsFolders()`; re-render. (No cascade — references are by `id`.)

**UI**
- Folder chip (`renderFoldersSidebar`) gains a `⋯` affordance → small menu: **Rename** / **Delete**.
- Delete confirm: *"Delete folder 'X'? It will be removed from N saved article(s) (they stay in All Saved)."* Use the existing line-glyph convention (e.g. `✕ Delete`); no decorative emoji.
- Rename reuses the existing inline/`window.prompt` pattern used by New-folder.
- "All Saved" is never deletable.

**Footprint:** no backend, no new dependency, no schema. Pure `localStorage` utility — exactly the "standard utility addition" described.

### C2 — Cross-device / server-authoritative (OPTIONAL — defer)

Only if folders must follow Molly across devices/browsers.

| Option | Pros | Cons |
|---|---|---|
| Keep `localStorage` (recommended now) | Zero cost; survives cold starts; no PII on server; no infra | Per-device; lost if browser data cleared |
| Git-committed JSON mirror | Simple, versioned | Shared across **all** users (no per-user isolation); pollutes repo; needs write-auth |
| Render Postgres (free 1 GB, 90-day expiry) | Real DB, cross-device | Cost/quota, migration, schema; 90-day free-tier wipe still applies |
| External KV (Supabase free / Cloudflare KV) | Cross-device, free tiers | New vendor, key mgmt, another external dep (hurts longevity) |

**Recommendation:** ship C1 now; defer C2. If cross-device is ever needed, prefer an external KV over Render disk (still ephemeral on free tier).

## 4. Verification

- Manual checklist: create → rename → delete (folder containing articles) → confirm articles survive in All Saved → refresh page → folders persist → deleting "All Saved" is impossible.
- Optional: a small jsdom unit test for `deleteFolder`/`renameFolder` cascade logic (app.js is not currently unit-tested; weigh cost vs value).

## 5. Phasing

1. `deleteFolder` + `renameFolder` (cascade) in app.js.
2. Folder-chip `⋯` menu + confirm dialogs (app.js + styles.css).
3. Wire into existing `renderFoldersSidebar` / `setupFolderUI`.
4. Verify (manual + optional unit test). Normal PR flow; no new infra.
