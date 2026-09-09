"use strict";

// Suggested Updates 2b-ii — removing and flagging finished integrations.
//
// The asymmetry is the whole point of this file:
//   - an update that CREATED an entry can be removed, and put back (Undo)
//   - an update that was MERGED into curated text must never be auto-removed,
//     because deleting the record would destroy the original content. Those can
//     only be flagged for a human to revert.

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

const srv = require("../server");
const { attachDb } = require("../lib/datasets");

// SHARED ON-DISK FIXTURE: these tests genuinely rewrite data/*.json, so the
// suite must run with --test-concurrency=1 (see the `test` script in
// package.json). In parallel, files clobber each other's restore and leak.
const DATA_DIR = path.join(__dirname, "..", "data");
const PROTECTED = ["knowledge.json", "regulatory-timeline.json", "current-use-cases.json", "proposed-changes.json"];
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

// Models the `datasets` upsert so we can inspect what would have been written.
function makeRecordingPool() {
  const datasets = new Map();
  return {
    datasets,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (sql.includes("INSERT INTO datasets(name, data, updated_by, version)")) {
        const name = params[0];
        const prev = datasets.get(name);
        datasets.set(name, {
          name,
          data: JSON.parse(params[1]),
          updated_by: params[2],
          version: prev ? prev.version + 1 : 1,
        });
      }
      return { rows: [] };
    },
  };
}

async function startServer() {
  const s = http.createServer(srv.app);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  return s;
}
async function closeServer(s) {
  if (s.closeAllConnections) s.closeAllConnections();
  await new Promise((r) => s.close(r));
}
async function request(server, method, url, body) {
  const port = server.address().port;
  const opts = { method, headers: { accept: "application/json", connection: "close" } };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`http://127.0.0.1:${port}${url}`, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

function newEntryProposal(id, extra = {}) {
  return Object.assign({
    id,
    status: "pending",
    title: `Proposed update ${id}`,
    publisher: "Example Publisher",
    url: "https://example.com/proposed",
    publishedAt: "2026-09-08T00:00:00Z",
    publishedLabel: "Sep 2026",
    category: "timeline",
    suggestedEdit: "A newly integrated sentence about AI procurement.",
  }, extra);
}

// ---------------------------------------------------------------------------

test("removing a newly-created entry deletes it, and Undo puts it back", async () => {
  snapshotData();
  const pool = makeRecordingPool();
  attachDb(pool);
  srv.setProposedChanges({ items: [newEntryProposal("p_rm_1")], integratedIds: [] });
  const server = await startServer();

  try {
    const integrated = await request(server, "POST", "/api/proposed-changes/p_rm_1/integrate", {});
    assert.strictEqual(integrated.status, 200, "integrate succeeds");
    assert.strictEqual(integrated.body.persisted, true);

    const withEntry = pool.datasets.get("regulatory-timeline").data.events;
    const baseline = withEntry.length;
    assert.strictEqual(withEntry[0].proposalId, "p_rm_1", "the entry is present after integrating");

    // --- Remove ---
    const removed = await request(server, "POST", "/api/proposed-changes/p_rm_1/remove-integration", {});
    assert.strictEqual(removed.status, 200, "a new entry can be removed");
    assert.strictEqual(removed.body.entryFound, true);
    assert.strictEqual(removed.body.persisted, true, "the removal is durable");

    const afterRemoval = pool.datasets.get("regulatory-timeline").data.events;
    assert.strictEqual(afterRemoval.length, baseline - 1, "exactly one entry was deleted");
    assert.ok(
      !afterRemoval.some((e) => e.proposalId === "p_rm_1"),
      "the entry is gone"
    );

    const propAfter = srv.getProposedChanges().items.find((i) => i.id === "p_rm_1");
    assert.strictEqual(propAfter.status, "removed");
    assert.ok(propAfter.removedAt, "removal timestamp recorded");
    // The snapshot is what makes Undo exact rather than a re-generation.
    assert.ok(propAfter.removedEntry && propAfter.removedEntry.entry, "the removed entry is snapshotted");

    // --- Undo ---
    const undone = await request(server, "POST", "/api/proposed-changes/p_rm_1/undo-removal", {});
    assert.strictEqual(undone.status, 200, "undo succeeds");
    assert.strictEqual(undone.body.persisted, true);

    const afterUndo = pool.datasets.get("regulatory-timeline").data.events;
    assert.strictEqual(afterUndo.length, baseline, "the entry is back, with no duplicate");
    assert.strictEqual(afterUndo.filter((e) => e.proposalId === "p_rm_1").length, 1);
    assert.strictEqual(afterUndo[0].proposalId, "p_rm_1", "restored at its original position");

    const propUndone = srv.getProposedChanges().items.find((i) => i.id === "p_rm_1");
    assert.strictEqual(propUndone.status, "integrated");
    assert.strictEqual(propUndone.removedEntry, null, "snapshot cleared");
  } finally {
    await closeServer(server);
    attachDb(null);
    restoreData();
  }
});

test("an update merged into existing text cannot be removed — it must be flagged instead", async () => {
  snapshotData();
  attachDb(null);
  const timeline = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "regulatory-timeline.json"), "utf8"));
  const existingEvent = timeline.events[0];
  const originalDescription = existingEvent.description;

  srv.setProposedChanges({
    items: [
      {
        id: "p_edit_rm", status: "pending", title: "Merged into an existing event",
        publisher: "Example Publisher", url: "https://example.com/x",
        category: "timeline", suggestedEdit: "An appended sentence.",
        matchedRecord: { dataset: "timeline", title: existingEvent.title },
      },
    ],
    integratedIds: [],
  });
  const server = await startServer();

  try {
    const integrated = await request(server, "POST", "/api/proposed-changes/p_edit_rm/integrate", {});
    assert.strictEqual(integrated.status, 200);
    const prop = () => srv.getProposedChanges().items.find((i) => i.id === "p_edit_rm");
    assert.strictEqual(prop().integratedMode, "edit");

    // Removal must be REFUSED — deleting the record would take the curated
    // original with it.
    const removed = await request(server, "POST", "/api/proposed-changes/p_edit_rm/remove-integration", {});
    assert.strictEqual(removed.status, 409, "edit-path updates are not removable");
    assert.strictEqual(removed.body.mode, "edit");

    assert.strictEqual(prop().status, "integrated", "status unchanged by the refusal");
    const after = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "regulatory-timeline.json"), "utf8"));
    const stillThere = after.events.find((e) => e.title === existingEvent.title);
    assert.ok(stillThere, "the curated record was NOT deleted");
    assert.ok(stillThere.description.startsWith(originalDescription), "its original text is intact");
  } finally {
    await closeServer(server);
    restoreData();
  }
});

test("flagging an edit-path update records who and why, and never touches the content", async () => {
  snapshotData();
  attachDb(null);
  const timeline = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "regulatory-timeline.json"), "utf8"));
  const existingEvent = timeline.events[0];

  srv.setProposedChanges({
    items: [
      {
        id: "p_flag_1", status: "pending", title: "Merged, then disputed",
        publisher: "Example Publisher", url: "https://example.com/y",
        category: "timeline", suggestedEdit: "An appended sentence.",
        matchedRecord: { dataset: "timeline", title: existingEvent.title },
      },
    ],
    integratedIds: [],
  });
  const server = await startServer();

  try {
    const before = fs.readFileSync(path.join(DATA_DIR, "regulatory-timeline.json"), "utf8");
    await request(server, "POST", "/api/proposed-changes/p_flag_1/integrate", {});

    const flagged = await request(server, "POST", "/api/proposed-changes/p_flag_1/flag-revert", {
      note: "  The date looks wrong — check the official source.  ",
    });
    assert.strictEqual(flagged.status, 200);
    assert.strictEqual(flagged.body.revertRequested, true);
    assert.strictEqual(flagged.body.mode, "edit");

    const prop = srv.getProposedChanges().items.find((i) => i.id === "p_flag_1");
    assert.strictEqual(prop.revertRequested, true);
    assert.ok(prop.revertRequestedAt, "timestamp recorded");
    assert.ok(prop.revertRequestedBy, "who flagged it is recorded");
    assert.strictEqual(prop.revertNote, "The date looks wrong — check the official source.", "note is trimmed");
    // Crucially: flagging is NOT a revert. The content is untouched.
    assert.strictEqual(prop.status, "integrated", "still integrated, not removed");
    assert.notStrictEqual(
      fs.readFileSync(path.join(DATA_DIR, "regulatory-timeline.json"), "utf8"), before,
      "the file changed only because of the integrate, not the flag"
    );

    // Clearing the flag puts it back to normal.
    const cleared = await request(server, "POST", "/api/proposed-changes/p_flag_1/flag-revert", { flag: false });
    assert.strictEqual(cleared.body.revertRequested, false);
    const prop2 = srv.getProposedChanges().items.find((i) => i.id === "p_flag_1");
    assert.strictEqual(prop2.revertRequested, false);
    assert.strictEqual(prop2.revertNote, null);
    assert.strictEqual(prop2.status, "integrated", "clearing does not remove it either");
  } finally {
    await closeServer(server);
    restoreData();
  }
});

test("removal finds knowledge entries across categories, and refuses invalid states", async () => {
  snapshotData();
  attachDb(null);
  srv.setProposedChanges({
    items: [
      newEntryProposal("p_kb_1", { category: "knowledge", targetCategory: "regulations" }),
      newEntryProposal("p_pending_1"),
    ],
    integratedIds: [],
  });
  const server = await startServer();

  try {
    // A pending update has nothing to remove.
    const tooSoon = await request(server, "POST", "/api/proposed-changes/p_pending_1/remove-integration", {});
    assert.strictEqual(tooSoon.status, 409, "cannot remove something not yet integrated");

    // Target explicitly: the category -> dataset default only maps "academic"
    // to knowledge, so a knowledge integration has to name its dataset.
    await request(server, "POST", "/api/proposed-changes/p_kb_1/integrate", {
      targetDataset: "knowledge",
      targetCategoryKey: "regulations",
    });
    const kb = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "knowledge.json"), "utf8"));
    const inCategory = kb.categories.regulations.subsections.find((s) => s.proposalId === "p_kb_1");
    assert.ok(inCategory, "the entry landed in the requested category");

    // Knowledge has eight categories — this proves the search finds the right one.
    const removed = await request(server, "POST", "/api/proposed-changes/p_kb_1/remove-integration", {});
    assert.strictEqual(removed.status, 200);
    assert.strictEqual(removed.body.entryFound, true, "found even though it was in one of many categories");

    const kbAfter = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "knowledge.json"), "utf8"));
    assert.ok(
      !kbAfter.categories.regulations.subsections.some((s) => s.proposalId === "p_kb_1"),
      "removed from the knowledge dataset"
    );

    // Removing twice must not be allowed to do anything further.
    const twice = await request(server, "POST", "/api/proposed-changes/p_kb_1/remove-integration", {});
    assert.strictEqual(twice.status, 409, "already removed");
  } finally {
    await closeServer(server);
    restoreData();
  }
});

test("removal is idempotent when the entry has already gone from the dataset", async () => {
  snapshotData();
  attachDb(null);
  srv.setProposedChanges({
    items: [{
      id: "p_ghost", status: "integrated", title: "Integrated but the entry is gone",
      integratedTarget: "timeline", integratedMode: "new",
      integratedAt: "2026-09-09T09:00:00.000Z", integratedBy: "someone",
    }],
    integratedIds: [],
  });
  const server = await startServer();
  try {
    const res = await request(server, "POST", "/api/proposed-changes/p_ghost/remove-integration", {});
    assert.strictEqual(res.status, 200, "must not fail just because the entry is missing");
    assert.strictEqual(res.body.entryFound, false, "reports that nothing was actually deleted");
    const prop = srv.getProposedChanges().items.find((i) => i.id === "p_ghost");
    assert.strictEqual(prop.status, "removed", "still marked removed so the panel can drop the row");
  } finally {
    await closeServer(server);
    restoreData();
  }
});
