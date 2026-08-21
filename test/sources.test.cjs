"use strict";

// Thread D (D1) — shared, team-side source ingestion.
//
// Two top-level tests (run like the dataset-db suite):
//   1. Library unit tests for lib/sources.js using a fake pg.Pool injected via
//      lib/datasets.attachDb and a stub reader via sources.setSourceReader.
//      Covers the citable [T#] evidence loop the Q&A lane consumes.
//   2. Route smoke tests against the real express app (requireEditor reuse),
//      also with the fake pool.
//
// ../server is required once at module load; its boot only attaches a pool /
// starts crons when run as the main module, so nothing connects or ticks here.

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const crypto = require("crypto");

const srv = require("../server");
const { attachDb } = require("../lib/datasets");
const sources = require("../lib/sources");

function hash(s) { return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16); }

const READER_TEXT =
  "The UK CMA published new guidance on foundation-model risk assessment that " +
  "directly affects how gaming studios must document AI procurement in 2026."; // >120 chars

function makeReader(text = READER_TEXT) {
  return async () => ({ text, url: "https://example.com/doc", title: "Example Doc" });
}

// In-memory fake pool that mimics the handful of statements lib/sources issues.
function makeFakePool() {
  const rows = [];
  return {
    rows,
    async query(text, params = []) {
      // INSERT pending row (addSourceUrl)
      if (/INSERT INTO sources/i.test(text) && /kind, url, title, added_by, status/.test(text)) {
        const [id, url, title, addedBy] = params;
        rows.push({
          id, kind: "url", url, title, added_by: addedBy, added_at: new Date(),
          status: "pending", content: null, content_hash: null, citation_id: null,
        });
        return { rows: [] };
      }
      // SELECT id, status, citation_id FROM sources WHERE url = $1  (de-dup check)
      if (/SELECT .* FROM sources WHERE url = \$1/i.test(text)) {
        return { rows: rows.filter(r => r.url === params[0]) };
      }
      // SELECT * FROM sources WHERE id = $1  (ingest / refresh)
      if (/SELECT \* FROM sources WHERE id/i.test(text)) {
        return { rows: rows.filter(r => r.id === params[0]) };
      }
      // COUNT of already-ingested rows → drives the sequential [T#] id
      if (/COUNT\(\*\)::int AS n/i.test(text)) {
        return { rows: [{ n: rows.filter(r => r.citation_id != null).length }] };
      }
      // UPDATE sources SET ... (status transitions) — multi-line SQL, match on keyword
      if (/UPDATE sources/i.test(text)) {
        const id = params[0];
        const row = rows.find(r => r.id === id);
        if (row) {
          if (/status = 'ingested'/.test(text) && /citation_id = \$4/.test(text)) {
            const [rid, content, h, citation, url, title] = params;
            assert.strictEqual(rid, id);
            Object.assign(row, { content, content_hash: h, citation_id: citation, url, title, status: "ingested" });
          } else if (/status = 'changed'/.test(text)) {
            row.status = "changed";
          } else if (/status = 'failed'/.test(text)) {
            row.status = "failed";
          }
        }
        return { rows: [] };
      }
      // listSources — honour ORDER BY added_at DESC
      if (/FROM sources ORDER BY added_at DESC/i.test(text)) {
        return { rows: rows.slice().sort((a, b) => b.added_at - a.added_at).map(r => ({ ...r })) };
      }
      // DELETE FROM sources WHERE id = $1
      if (/DELETE FROM sources WHERE id/i.test(text)) {
        const id = params[0];
        const idx = rows.findIndex(r => r.id === id);
        if (idx >= 0) rows.splice(idx, 1);
        return { rows: [] };
      }
      // loadTeamEvidence
      if (/status IN \('ingested', 'changed'\)/.test(text)) {
        return { rows: rows.filter(r => (r.status === "ingested" || r.status === "changed") && r.citation_id != null).map(r => ({ ...r })) };
      }
      return { rows: [] };
    },
  };
}

function pushIngestedRow(pool, { id = "src_x", citation = "T1", content = READER_TEXT } = {}) {
  pool.rows.push({
    id, kind: "url", url: "https://example.com/doc", title: "Example Doc", added_by: "molly",
    added_at: new Date(), status: "ingested", content, content_hash: hash(content), citation_id: citation,
  });
}

test("Thread D — shared source ingestion (library)", async (t) => {
  let pool;
  function libSetup() {
    pool = makeFakePool();
    attachDb(pool);
    sources.setSourceReader(makeReader());
  }
  function libTeardown() { attachDb(null); sources.setSourceReader(null); }

  await t.test("graceful degradation when DB is unconfigured", async () => {
    attachDb(null);
    sources.setSourceReader(null);
    await assert.rejects(() => sources.listSources(), /Database not configured/);
    const ev = await sources.loadTeamEvidence();
    assert.deepStrictEqual(ev, []);
  });

  await t.test("listSources maps DB rows to a clean shape (newest first)", async () => {
    libSetup();
    try {
      const older = new Date(Date.now() - 10000);
      pool.rows.push({
        id: "src_1", kind: "url", url: "https://example.com/a", title: "A", added_by: "molly",
        added_at: older, status: "ingested", content: READER_TEXT, content_hash: hash(READER_TEXT), citation_id: "T1",
      });
      pushIngestedRow(pool, { id: "src_2", citation: "T2" });
      const list = await sources.listSources();
      assert.strictEqual(list.length, 2);
      assert.deepStrictEqual(list[0], {
        id: "src_2", kind: "url", url: "https://example.com/doc", title: "Example Doc",
        addedBy: "molly", addedAt: list[0].addedAt, lastFetched: list[0].lastFetched,
        status: "ingested", citationId: "T2",
      });
    } finally { libTeardown(); }
  });

  await t.test("addSourceUrl inserts a pending row then ingests to a [T#] id", async () => {
    libSetup();
    try {
      const row = await sources.addSourceUrl("https://example.com/a", "A", "molly");
      assert.strictEqual(row.status, "pending");
      assert.match(row.id, /^src_/);
      const ingested = await sources.ingestSource(row.id);
      assert.strictEqual(ingested.status, "ingested");
      assert.match(ingested.citation_id, /^T\d+$/);
      const list = await sources.listSources();
      assert.strictEqual(list[0].status, "ingested");
      assert.match(list[0].citationId, /^T\d+$/);
    } finally { libTeardown(); }
  });

  await t.test("ingestSource refuses to store too-short text", async () => {
    libSetup();
    try {
      sources.setSourceReader(makeReader("too short"));
      const row = await sources.addSourceUrl("https://example.com/b", "B", "molly");
      const ingested = await sources.ingestSource(row.id);
      assert.strictEqual(ingested.status, "failed");
    } finally { libTeardown(); }
  });

  await t.test("addSourceUrl de-duplicates by URL (re-add updates the same row)", async () => {
    libSetup();
    try {
      const r1 = await sources.addSourceUrl("https://example.com/dup", "Dup", "molly");
      const r2 = await sources.addSourceUrl("https://example.com/dup", "Dup", "molly");
      assert.strictEqual(r1.id, r2.id, "re-add must update the existing row, not insert a new one");
      const list = await sources.listSources();
      const matching = list.filter(s => s.url === "https://example.com/dup");
      assert.strictEqual(matching.length, 1, "only one row should exist per URL");
      // Force the (background) ingestion to complete, then confirm it ingested.
      await sources.ingestSource(r1.id);
      const after = await sources.listSources();
      const row = after.find(s => s.url === "https://example.com/dup");
      assert.strictEqual(row.status, "ingested");
      assert.match(row.citationId, /^T\d+$/);
    } finally { libTeardown(); }
  });

  await t.test("ingestSource preserves an existing [T#] on re-ingest (no renumber)", async () => {
    libSetup();
    try {
      pushIngestedRow(pool, { id: "src_p", citation: "T1" });
      const refreshed = await sources.refreshSource("src_p");
      assert.strictEqual(refreshed.status, "ingested");
      assert.strictEqual(refreshed.citation_id, "T1", "citation id must not be renumbered on refresh");
      const list = await sources.listSources();
      const row = list.find(s => s.id === "src_p");
      assert.strictEqual(row.citationId, "T1");
    } finally { libTeardown(); }
  });

  await t.test("refreshSource keeps status 'ingested' when content is unchanged", async () => {
    libSetup();
    try {
      pushIngestedRow(pool, { id: "src_r", citation: "T1" });
      const refreshed = await sources.refreshSource("src_r");
      assert.strictEqual(refreshed.status, "ingested");
    } finally { libTeardown(); }
  });

  await t.test("loadTeamEvidence returns citable [T#] evidence for the Q&A lane", async () => {
    libSetup();
    try {
      pushIngestedRow(pool, { id: "src_e", citation: "T1" });
      const ev = await sources.loadTeamEvidence();
      assert.strictEqual(ev.length, 1);
      assert.strictEqual(ev[0].id, "T1");
      assert.strictEqual(ev[0].sourceType, "team");
      assert.strictEqual(ev[0].title, "Example Doc");
      assert.ok(ev[0].text.startsWith("The UK CMA"));
    } finally { libTeardown(); }
  });
});

test("Thread D — source routes (real app, fake pool)", async (t) => {
  process.env.ADMIN_API_KEY = "test-editor-key";
  const pool = makeFakePool();
  attachDb(pool);
  sources.setSourceReader(makeReader()); // boot set the real reader; override now
  const app = srv.app;
  const realFetch = globalThis.fetch;
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  try {
    async function request(method, path, body, headers = {}) {
      const port = server.address().port;
      const opts = { method, headers: { accept: "application/json", connection: "close", ...headers } };
      if (body !== undefined) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body); }
      const res = await realFetch(`http://127.0.0.1:${port}${path}`, opts);
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
      return { status: res.status, body: json };
    }

    await t.test("POST without editor key is rejected (401)", async () => {
      const r = await request("POST", "/api/sources", { kind: "url", url: "https://x.com" });
      assert.strictEqual(r.status, 401);
    });

    await t.test("POST with key (kind:url) returns 202 + pending source", async () => {
      const r = await request("POST", "/api/sources", { kind: "url", url: "https://x.com/a", title: "A" },
        { "x-admin-key": "test-editor-key", "x-editor-name": "molly" });
      assert.strictEqual(r.status, 202);
      assert.ok(r.body.success);
      assert.match(r.body.source.id, /^src_/);
      assert.strictEqual(r.body.source.status, "pending");
    });

    await t.test("POST with unsupported kind is 400", async () => {
      const r = await request("POST", "/api/sources", { kind: "report", url: "https://x.com" },
        { "x-admin-key": "test-editor-key" });
      assert.strictEqual(r.status, 400);
    });

    await t.test("GET is open and lists sources", async () => {
      pushIngestedRow(pool, { id: "src_g", citation: "T1" });
      const r = await request("GET", "/api/sources");
      assert.strictEqual(r.status, 200);
      assert.ok(Array.isArray(r.body.sources));
      // >=1: an earlier POST-202 leaves its (now-ingested) row in the pool too.
      assert.ok(r.body.sources.length >= 1);
      assert.ok(r.body.sources.some(s => s.id === "src_g"));
    });

    await t.test("POST /:id/refresh (editor-gated) re-ingests", async () => {
      pushIngestedRow(pool, { id: "src_f", citation: "T1" });
      const r = await request("POST", "/api/sources/src_f/refresh", undefined,
        { "x-admin-key": "test-editor-key" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.body.source.status, "ingested");
    });

    await t.test("DELETE /api/sources/:id (editor-gated) removes a source", async () => {
      pushIngestedRow(pool, { id: "src_del", citation: "T1" });
      const noKey = await request("DELETE", "/api/sources/src_del");
      assert.strictEqual(noKey.status, 401);
      const ok = await request("DELETE", "/api/sources/src_del", undefined,
        { "x-admin-key": "test-editor-key" });
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.body.success, true);
      const list = await request("GET", "/api/sources");
      assert.ok(!list.body.sources.some(s => s.id === "src_del"));
    });

    await t.test("POST /api/summarise injects ONLY requested team sources (opt-in)", async () => {
      pushIngestedRow(pool, { id: "src_t1", citation: "T1" });
      pushIngestedRow(pool, { id: "src_t2", citation: "T2" });
      const ask = (teamSourceIds) => request("POST", "/api/summarise", {
        question: "What does the CMA say about AI procurement in gaming?",
        useModel: false, useInternet: false, userSources: [], teamSourceIds,
      });
      // No IDs requested -> team evidence must be absent (no auto-inject).
      const r1 = await ask([]);
      assert.strictEqual(r1.status, 200);
      assert.ok(r1.body.success);
      const teamR1 = (r1.body.sources || []).filter(s => s.sourceType === "team");
      assert.strictEqual(teamR1.length, 0, "team evidence must be absent when not requested");
      // Only T2 requested -> exactly T2 injected, T1 excluded.
      const r2 = await ask(["T2"]);
      const teamR2 = (r2.body.sources || []).filter(s => s.sourceType === "team");
      assert.strictEqual(teamR2.length, 1);
      assert.strictEqual(teamR2[0].id, "T2");
    });
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(r => server.close(r));
    attachDb(null);
    sources.setSourceReader(null);
  }
});
