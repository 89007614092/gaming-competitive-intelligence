"use strict";

// Option B — shared, editable datasets (Supabase-backed) tests.
//
// Two layers, both exercised WITHOUT a live database:
//   1. lib/datasets cache semantics: DB-backed entries are STICKY (a disk
//      re-read can never shadow a DB write), while disk-backed entries still
//      refresh on mtime change (so the integrate path keeps working).
//   2. The PUT /api/datasets/:name route: gate (fail-closed), validation,
//      unknown-name 404, and the DB-not-configured 500 path.

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

// --- lib/datasets unit tests ------------------------------------------------
const {
  getDataset, clearDatasetCache, setDatasetCache, attachDb, primeDatasetCacheFromDb,
} = require("../lib/datasets");

test("primeDatasetCacheFromDb makes the DB value authoritative over disk", async () => {
  const fakePool = {
    query: async () => ({ rows: [{ name: "knowledge", data: { __fromDb: true } }] }),
  };
  attachDb(fakePool);
  await primeDatasetCacheFromDb();
  // Disk knowledge.json has a totally different shape, so this proves DB won.
  assert.deepStrictEqual(getDataset("knowledge"), { __fromDb: true });
  clearDatasetCache("knowledge");
});

test("setDatasetCache makes a PUT edit sticky (db-backed)", () => {
  setDatasetCache("network", { __put: true });
  assert.deepStrictEqual(getDataset("network"), { __put: true });
  clearDatasetCache("network");
});

test("clearDatasetCache drops a db-backed entry back to disk", () => {
  setDatasetCache("network", { __put: true });
  clearDatasetCache("network");
  const d = getDataset("network");
  assert.ok(!("__put" in d)); // real on-disk data, not the db put
});

// --- PUT /api/datasets/:name route tests ------------------------------------
// A trusted team reuses ADMIN_API_KEY as the gate. Subtests run serially so the
// fail-closed case (which temporarily unsets the key) can't race the others.
const srv = require("../server");
const app = srv.app;
const realFetch = globalThis.fetch;

function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}
async function request(server, method, path, body, headers = {}) {
  const port = server.address().port;
  const opts = { method, headers: { accept: "application/json", ...headers } };
  if (body !== undefined) {
    opts.headers["content-type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, opts);
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: res.status, body: json };
}

test("PUT /api/datasets/:name route", async (t) => {
  process.env.ADMIN_API_KEY = "test-editor-key";
  const server = await startServer();
  t.after(async () => { await closeServer(server); });

  await t.test("without a key is rejected (401)", async () => {
    const r = await request(server, "PUT", "/api/datasets/knowledge", { a: 1 });
    assert.strictEqual(r.status, 401);
  });

  await t.test("correct key but no DATABASE_URL -> 500 db-not-configured", async () => {
    const r = await request(server, "PUT", "/api/datasets/knowledge", { a: 1 },
      { "x-admin-key": "test-editor-key" });
    assert.strictEqual(r.status, 500);
    assert.strictEqual(r.body && r.body.error, "Database not configured");
  });

  await t.test("unknown dataset -> 404", async () => {
    const r = await request(server, "PUT", "/api/datasets/no-such", { a: 1 },
      { "x-admin-key": "test-editor-key" });
    assert.strictEqual(r.status, 404);
  });

  await t.test("non-object body -> 400", async () => {
    const r = await request(server, "PUT", "/api/datasets/knowledge", "not-an-object",
      { "x-admin-key": "test-editor-key" });
    assert.strictEqual(r.status, 400);
  });

  await t.test("fails closed when no editor key is configured (500)", async () => {
    const saved = process.env.ADMIN_API_KEY;
    delete process.env.ADMIN_API_KEY;
    try {
      const r = await request(server, "PUT", "/api/datasets/knowledge", { a: 1 },
        { "x-admin-key": "whatever" });
      assert.strictEqual(r.status, 500);
      assert.strictEqual(r.body && r.body.error, "Editor auth not configured");
    } finally {
      process.env.ADMIN_API_KEY = saved;
    }
  });
});
