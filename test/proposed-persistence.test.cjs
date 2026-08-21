"use strict";

// Leg 2 — Suggested Updates durable store.
//
// Verifies that proposed-changes survive a "cold start": we persist a known
// store to the (fake) Supabase pool via saveProposed(), wipe the in-memory
// copy, then primeProposedFromDb() restores it from the DB. This is what makes
// "over time, all Suggested Updates get refreshed" possible on Render's
// ephemeral disk.
//
// ../server is required once at module load; its boot only attaches a pool /
// starts crons when run as the main module, so nothing connects or ticks here.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");

const srv = require("../server");
const { attachDb } = require("../lib/datasets");

// In-memory fake pool that mimics the two statements the store issues.
function makeFakePool() {
  const store = new Map();
  return {
    store,
    async query(text, params = []) {
      if (/INSERT INTO proposed_changes/i.test(text)) {
        const [id, data, status] = params;
        store.set(id, { id, data, status });
        return { rows: [] };
      }
      if (/SELECT data FROM proposed_changes WHERE id/i.test(text)) {
        const row = store.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      return { rows: [] };
    },
  };
}

test("Leg 2 — proposed-changes round-trips through the DB store (fake pool)", async () => {
  // Prevent the disk fallback from touching the real data/proposed-changes.json.
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = () => {};
  try {
    const pool = makeFakePool();
    attachDb(pool);

    const sample = {
      items: [
        { id: "p1", status: "pending", title: "AI Act update", styledSummary: null, enrichStatus: "pending" },
        { id: "p2", status: "integrated", title: "CMA guidance", styledSummary: "x", enrichStatus: "done" },
      ],
      dismissedIds: ["p9"],
      integratedIds: ["p2"],
    };
    srv.setProposedChanges(sample);
    await srv.saveProposed(); // persists to the fake pool (DB)

    // Simulate a cold start: in-memory copy is gone, only the DB has it.
    srv.setProposedChanges({ items: [], dismissedIds: [], integratedIds: [] });
    await srv.primeProposedFromDb();

    const loaded = srv.getProposedChanges();
    assert.strictEqual(loaded.items.length, 2, "both items restored from DB");
    assert.strictEqual(loaded.items[0].id, "p1");
    assert.strictEqual(loaded.items[1].id, "p2");
    assert.deepStrictEqual(loaded.dismissedIds, ["p9"]);
    assert.deepStrictEqual(loaded.integratedIds, ["p2"]);
    assert.strictEqual(pool.store.has("__store"), true, "store row written under __store key");
  } finally {
    fs.writeFileSync = origWrite;
  }
});

