"use strict";

// Durable Suggested Updates (increment 2a).
//
// Before this, integrating a proposal wrote ONLY to data/*.json — and Render's
// filesystem is ephemeral, so the change vanished on the next restart while the
// proposal still claimed "integrated". These tests pin the new behaviour:
//   - the dataset is written through to the durable `datasets` table
//   - integrating twice is rejected (no duplicate entries)
//   - entries carry the attribution stamp used for "Added by …" and removal
//   - with no database configured it degrades to disk-only instead of failing

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

const srv = require("../server");
const { attachDb } = require("../lib/datasets");

// integrateProposal() and saveProposed() genuinely rewrite files under data/,
// so snapshot them and put them back afterwards — a test must never leave the
// working tree dirty.
const DATA_DIR = path.join(__dirname, "..", "data");
const PROTECTED = [
  "knowledge.json",
  "regulatory-timeline.json",
  "current-use-cases.json",
  "proposed-changes.json",
];
const originals = new Map();
function snapshotData() {
  for (const f of PROTECTED) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) originals.set(f, fs.readFileSync(p, "utf8"));
  }
}
function restoreData() {
  for (const [f, body] of originals) fs.writeFileSync(path.join(DATA_DIR, f), body);
}

// Records every statement and models the `datasets` upsert so we can inspect
// what would actually have been persisted.
function makeRecordingPool() {
  const calls = [];
  const datasets = new Map();
  return {
    calls,
    datasets,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push({ sql, params });
      if (sql.includes("INSERT INTO datasets(name, data, updated_by, version)")) {
        const name = params[0];
        const data = JSON.parse(params[1]);
        const prev = datasets.get(name);
        datasets.set(name, {
          name,
          data,
          updated_by: params[2],
          version: prev ? prev.version + 1 : 1,
        });
      }
      return { rows: [] };
    },
  };
}

function makeProposal(id) {
  return {
    id,
    status: "pending",
    title: `Proposed update ${id}`,
    publisher: "Example Publisher",
    url: "https://example.com/proposed",
    publishedAt: "2026-09-08T00:00:00Z",
    publishedLabel: "Sep 2026",
    category: "timeline",
    suggestedEdit: "A newly integrated sentence about AI procurement.",
  };
}

test("integrating a proposed update persists it and stamps attribution", async (t) => {
  snapshotData();
  const pool = makeRecordingPool();
  attachDb(pool);
  srv.setProposedChanges({ items: [makeProposal("p_test_1")], integratedIds: [] });

  const app = srv.app;
  const realFetch = globalThis.fetch;
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));

  async function request(method, url, body) {
    const port = server.address().port;
    const opts = { method, headers: { accept: "application/json", connection: "close" } };
    if (body !== undefined) {
      opts.headers["content-type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await realFetch(`http://127.0.0.1:${port}${url}`, opts);
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
    return { status: res.status, body: json };
  }

  try {
    const first = await request("POST", "/api/proposed-changes/p_test_1/integrate");
    assert.strictEqual(first.status, 200, "first integrate must succeed");
    assert.strictEqual(first.body.persisted, true, "must write through to the database");
    assert.strictEqual(first.body.dataset, "regulatory-timeline");

    // The dataset row was actually written, with the new entry at the front.
    const row = pool.datasets.get("regulatory-timeline");
    assert.ok(row, "a `datasets` row must be upserted");
    const added = row.data.events[0];
    assert.strictEqual(added.title, "Proposed update p_test_1");

    // Attribution stamp — powers "Added by …" and lets a removal find this entry.
    assert.strictEqual(added.proposalId, "p_test_1", "proposalId is the key used to remove it later");
    assert.ok("addedBy" in added, "entries must carry addedBy");
    assert.ok("addedByEmail" in added, "entries must carry addedByEmail");
    assert.ok("addedAt" in added, "entries must carry addedAt");

    // A backup of the pristine seed is attempted before the first overwrite.
    assert.ok(
      pool.calls.some(c => c.sql.includes("INSERT INTO datasets_backups")),
      "must snapshot the seed before overwriting it"
    );

    // Idempotency: a second click (stale UI, second admin) must be rejected.
    const second = await request("POST", "/api/proposed-changes/p_test_1/integrate");
    assert.strictEqual(second.status, 409, "re-integrating must be refused");
    assert.strictEqual(second.body.status, "integrated");

    const after = srv.getProposedChanges().items.find(i => i.id === "p_test_1");
    assert.strictEqual(after.status, "integrated");
    assert.ok(after.integratedAt, "integration timestamp recorded");
    assert.ok(after.integratedEdit, "the integrated text is retained so it can be undone");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(r => server.close(r));
    attachDb(null);
    restoreData();
  }
});

test("with no database configured, integrate still succeeds (disk-only fallback)", async () => {
  snapshotData();
  attachDb(null); // no DATABASE_URL / pool
  srv.setProposedChanges({ items: [makeProposal("p_test_2")], integratedIds: [] });

  const app = srv.app;
  const realFetch = globalThis.fetch;
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));

  try {
    const port = server.address().port;
    const res = await realFetch(`http://127.0.0.1:${port}/api/proposed-changes/p_test_2/integrate`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", connection: "close" },
      body: JSON.stringify({}),
    });
    const body = await res.json();
    assert.strictEqual(res.status, 200, "must not fail just because there is no DB");
    assert.strictEqual(body.persisted, false, "reports that it was NOT durably saved");
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise(r => server.close(r));
    restoreData();
  }
});
