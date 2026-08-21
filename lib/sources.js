// Thread D — shared, team-side ingestion (watch-URL + report-upload).
//
// Stores curated sources in the Supabase `sources` table so they become
// citable [T#] evidence in the Q&A lane. The actual text extraction reuses the
// existing reader pipeline (server.js fetchReaderContent) via a setter injected
// at boot — this keeps the library free of a circular require on server.js and
// guarantees ingested sources go through the SAME governed extraction
// (Jina + Thread F attribution) as the rest of the app.
//
// DB access mirrors lib/datasets: getDbPool() returns null when DATABASE_URL is
// unset or pg is absent, and every exported function degrades safely (throws a
// clear error) so callers can 500 / fall back rather than crash.

const crypto = require("crypto");
const { getDbPool } = require("./datasets");

// Injected by server.js at boot (fetchReaderContent). Kept as a module-level
// reference so ingestSource can call it without importing server.js.
let _fetchReader = null;
function setSourceReader(fn) {
  _fetchReader = typeof fn === "function" ? fn : null;
}

function newSourceId() {
  return `src_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function hashContent(text = "") {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 16);
}

// Map a DB row to a Q&A evidence item. Only ingested/changed rows are citable.
function rowToEvidence(row) {
  const text = row.content || "";
  return {
    id: row.citation_id,
    sourceType: "team",
    dataset: "Team Sources",
    title: row.title || row.url || row.citation_id || "Untitled source",
    section: "Team-shared evidence",
    text: text.slice(0, 4000),
    excerpt: text.slice(0, 360),
    url: row.url || undefined,
  };
}

async function listSources() {
  const pool = getDbPool();
  if (!pool) throw new Error("Database not configured");
  const { rows } = await pool.query(
    "SELECT id, kind, url, title, added_by, added_at, last_fetched, status, citation_id " +
    "FROM sources ORDER BY added_at DESC"
  );
  return rows.map(r => ({
    id: r.id,
    kind: r.kind,
    url: r.url,
    title: r.title,
    addedBy: r.added_by,
    addedAt: r.added_at,
    lastFetched: r.last_fetched,
    status: r.status,
    citationId: r.citation_id,
  }));
}

// Insert a pending row, then kick off background ingestion. Returns the pending
// row immediately so the UI can poll status via refresh; ingestion failure is
// logged but never rejects the POST (the row is marked 'failed' instead).
//
// De-duplicates by URL: if a row already exists for this URL we UPDATE that
// same row (reset to pending) and re-ingest it, instead of inserting a second
// row. This is what stops the same article from appearing as both a FAILED and
// an INGESTED [T#] entry in the list. We prefer an already-ingested row so a
// re-add never spawns a competing [T#] next to the good one.
async function addSourceUrl(url, title, addedBy) {
  const pool = getDbPool();
  if (!pool) throw new Error("Database not configured");
  const normUrl = String(url || "").slice(0, 2000);
  const { rows: existing } = await pool.query(
    "SELECT id, status, citation_id FROM sources WHERE url = $1",
    [normUrl]
  );
  if (existing.length) {
    const existingRow = existing.find(r => r.citation_id) || existing[0];
    const id = existingRow.id;
    await pool.query(
      "UPDATE sources SET title = COALESCE($2, title), added_by = COALESCE($3, added_by), " +
      "status = 'pending', last_fetched = now() WHERE id = $1",
      [id, String(title || "").slice(0, 300) || null, String(addedBy || "unknown").slice(0, 100)]
    );
    const row = { id, kind: "url", url, title: title || null, addedBy: addedBy || "unknown", status: "pending", citationId: existingRow.citation_id || null };
    ingestSource(id).catch((err) => {
      console.error(`[sources] ingestion failed for ${id}:`, err.message);
    });
    return row;
  }
  const id = newSourceId();
  await pool.query(
    "INSERT INTO sources(id, kind, url, title, added_by, status) VALUES($1, 'url', $2, $3, $4, 'pending')",
    [id, normUrl, String(title || "").slice(0, 300) || null, String(addedBy || "unknown").slice(0, 100)]
  );
  const row = { id, kind: "url", url, title: title || null, addedBy: addedBy || "unknown", status: "pending", citationId: null };
  // Fire-and-forget; failures update the row to 'failed'.
  ingestSource(id).catch((err) => {
    console.error(`[sources] ingestion failed for ${id}:`, err.message);
  });
  return row;
}

// Fetch + classify + store the extracted text for a source row. Shared by the
// initial add and the later refresh (D3). Resolves to the updated row.
async function ingestSource(id) {
  const pool = getDbPool();
  if (!pool) throw new Error("Database not configured");
  const { rows } = await pool.query("SELECT * FROM sources WHERE id = $1", [id]);
  const row = rows[0];
  if (!row) throw new Error("Source not found");

  // D2 (report upload) lands here with content already provided; skip the fetch.
  let text = "";
  let resolvedUrl = row.url;
  let resolvedTitle = row.title;
  if (row.kind === "report") {
    text = row.content || "";
  } else {
    if (!_fetchReader) throw new Error("Reader pipeline not initialised");
    const result = await _fetchReader(row.url, { licenseClass: "news-fair-use" });
    if (result && result.unresolved) {
      await pool.query("UPDATE sources SET status = 'failed', last_fetched = now() WHERE id = $1", [id]);
      return { ...row, status: "failed" };
    }
    if (result && result.restricted) {
      // Governed content we may not store in full; mark failed with the reason.
      await pool.query(
        "UPDATE sources SET status = 'failed', content = $2, last_fetched = now() WHERE id = $1",
        [id, "Source is access-restricted and cannot be stored as shared evidence."]
      );
      return { ...row, status: "failed" };
    }
    text = result?.text || "";
    resolvedUrl = result?.url || row.url;
    resolvedTitle = result?.title || row.title;
  }

  if (!text || text.trim().length < 120) {
    await pool.query("UPDATE sources SET status = 'failed', last_fetched = now() WHERE id = $1", [id]);
    return { ...row, status: "failed" };
  }

  const contentHash = hashContent(text);
  // Preserve an existing [T#] on re-ingest (refresh) so citations already baked
  // into stored answers never get renumbered. Only assign a fresh sequential id
  // when the row has none yet.
  let citationId = row.citation_id;
  if (!citationId) {
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM sources WHERE citation_id IS NOT NULL"
    );
    const nextT = (countRows[0]?.n || 0) + 1;
    citationId = `T${nextT}`;
  }
  // IMPORTANT: keep the ORIGINAL submitted `url` as the stable key ($5 = row.url,
  // not resolvedUrl). The reader may resolve a redirector to a canonical URL; if
  // we persisted that here, a later re-add of the same submitted URL would no
  // longer de-dupe against this row (the stored url would have drifted). The
  // de-dup SELECT in addSourceUrl relies on the submitted url staying put.
  await pool.query(
    `UPDATE sources
       SET status = 'ingested', content = $2, content_hash = $3,
           citation_id = $4, url = $5, title = COALESCE($6, title), last_fetched = now()
       WHERE id = $1`,
    [id, text, contentHash, citationId, row.url, resolvedTitle]
  );
  return { ...row, status: "ingested", content_hash: contentHash, citation_id: citationId, url: resolvedUrl, title: resolvedTitle };
}

// Re-fetch an existing URL source and diff its content hash. Unchanged → stays
// 'ingested'; changed → 'changed' (D3 will surface this via SSE later).
async function refreshSource(id) {
  const pool = getDbPool();
  if (!pool) throw new Error("Database not configured");
  const { rows } = await pool.query("SELECT * FROM sources WHERE id = $1", [id]);
  const row = rows[0];
  if (!row) throw new Error("Source not found");
  if (row.kind !== "url") {
    // Reports don't re-fetch; just re-mark as ingested.
    await pool.query("UPDATE sources SET status = 'ingested', last_fetched = now() WHERE id = $1", [id]);
    return { ...row, status: "ingested" };
  }
  const fresh = await ingestSource(id);
  if (fresh.status === "ingested" && row.content_hash && row.content_hash !== fresh.content_hash) {
    await pool.query("UPDATE sources SET status = 'changed' WHERE id = $1", [id]);
    return { ...fresh, status: "changed" };
  }
  return fresh;
}

// Remove a source row (editor action). Used to clear failed/duplicate entries
// from the Team Sources list; citable [T#] ids are not reused afterwards.
async function deleteSource(id) {
  const pool = getDbPool();
  if (!pool) throw new Error("Database not configured");
  await pool.query("DELETE FROM sources WHERE id = $1", [id]);
  return { id, deleted: true };
}

// The crux of "actually useful": return citable [T#] evidence for the Q&A lane.
// Returns [] when the DB is unconfigured or errors, so the rest of the answer
// pipeline is unaffected.
async function loadTeamEvidence() {
  const pool = getDbPool();
  if (!pool) return [];
  try {
    const { rows } = await pool.query(
      "SELECT citation_id, title, url, content, status FROM sources " +
      "WHERE status IN ('ingested', 'changed') AND citation_id IS NOT NULL ORDER BY added_at DESC"
    );
    return rows.map(rowToEvidence);
  } catch (err) {
    console.warn("[sources] loadTeamEvidence failed:", err.message);
    return [];
  }
}

module.exports = {
  setSourceReader,
  listSources,
  addSourceUrl,
  ingestSource,
  refreshSource,
  deleteSource,
  loadTeamEvidence,
  rowToEvidence,
};
