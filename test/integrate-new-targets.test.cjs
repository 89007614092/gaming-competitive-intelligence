"use strict";

// Suggested Updates — the four additional "Add to" targets: network (Competitor
// Web), tencent-products, risks and company-locations.
//
// Two things matter here:
//   1. each dataset gets an entry appended in ITS OWN shape, carrying the
//      attribution stamp and a proposalId so it can be removed later
//   2. the knowledge category list must not drift from the real categories

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

const srv = require("../server");
const { attachDb, clearDatasetCache } = require("../lib/datasets");

// SHARED ON-DISK FIXTURE: these tests genuinely rewrite data/*.json, so the
// suite must run with --test-concurrency=1 (see the `test` script in
// package.json). In parallel, files clobber each other's restore and leak.
const DATA_DIR = path.join(__dirname, "..", "data");
const PROTECTED = [
  "knowledge.json", "regulatory-timeline.json", "current-use-cases.json",
  "proposed-changes.json", "network.json", "tencent-products.json",
  "risks.json", "company-locations.json",
];
const originals = new Map();
function snapshotData() {
  for (const f of PROTECTED) {
    const p = path.join(DATA_DIR, f);
    if (fs.existsSync(p)) originals.set(f, fs.readFileSync(p, "utf8"));
    clearDatasetCache(f.replace(/\.json$/, ""));
  }
}
function restoreData() {
  for (const [f, body] of originals) {
    fs.writeFileSync(path.join(DATA_DIR, f), body);
    // Restoring the file is NOT enough: persistDataset() calls setDatasetCache(),
    // which makes a dataset STICKY, so the next test would keep reading this
    // test's mutated copy from the cache instead of the restored file.
    clearDatasetCache(f.replace(/\.json$/, ""));
  }
}

function makeRecordingPool() {
  const datasets = new Map();
  return {
    datasets,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      if (sql.includes("INSERT INTO datasets(name, data, updated_by, version)")) {
        const name = params[0];
        const prev = datasets.get(name);
        datasets.set(name, { name, data: JSON.parse(params[1]), updated_by: params[2], version: prev ? prev.version + 1 : 1 });
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

function proposal(id, extra = {}) {
  return Object.assign({
    id, status: "pending", title: `Proposed update ${id}`,
    publisher: "Example Publisher", url: "https://example.com/p",
    publishedAt: "2026-09-09T00:00:00Z", publishedLabel: "Sep 2026",
    suggestedEdit: "A newly integrated sentence.",
  }, extra);
}

test("each new target appends an entry in its own shape, with attribution", async () => {
  snapshotData();
  const pool = makeRecordingPool();
  attachDb(pool);
  srv.setProposedChanges({
    items: [
      proposal("p_net", { targetDataset: "network" }),
      proposal("p_tp", { targetDataset: "tencent-products" }),
      proposal("p_risk", { targetDataset: "risks" }),
      proposal("p_loc", { targetDataset: "company-locations" }),
    ],
    integratedIds: [],
  });
  const server = await startServer();

  try {
    // The target comes from the request body, not the stored proposal — that is
    // what the "Add to" dropdown sends.
    const targets = { p_net: "network", p_tp: "tencent-products", p_risk: "risks", p_loc: "company-locations" };
    for (const [id, target] of Object.entries(targets)) {
      const res = await request(server, "POST", `/api/proposed-changes/${id}/integrate`, { targetDataset: target });
      assert.strictEqual(res.status, 200, `${id} must integrate`);
      assert.strictEqual(res.body.persisted, true, `${id} must be durable`);
      assert.strictEqual(res.body.dataset, target, `${id} must land in ${target}`);
    }

    // Competitor Web — a competitor entry, not a knowledge subsection.
    const net = pool.datasets.get("network").data;
    assert.strictEqual(net.competitors[0].name, "Proposed update p_net");
    assert.strictEqual(net.competitors[0].proposalId, "p_net");
    assert.ok(net.competitors[0].addedBy, "carries attribution");

    // Tencent Products.
    const tp = pool.datasets.get("tencent-products").data;
    assert.strictEqual(tp.products[0].name, "Proposed update p_tp");
    assert.strictEqual(tp.products[0].proposalId, "p_tp");

    // Risks — nested one level deeper: categories[key].risks[].
    const rk = pool.datasets.get("risks").data;
    const withNew = Object.entries(rk.categories).filter(([, c]) => (c.risks || []).some((r) => r.proposalId === "p_risk"));
    assert.strictEqual(withNew.length, 1, "the risk lands in exactly one category");

    // Company Locations — no coordinates, because a text update cannot know
    // where a company is. The map filters these out rather than plotting 0,0.
    const cl = pool.datasets.get("company-locations").data;
    const added = cl.companies.find((c) => c.proposalId === "p_loc");
    assert.ok(added, "company appended");
    assert.strictEqual(added.lat, undefined, "no fake coordinates");
    assert.strictEqual(added.lon, undefined, "no fake coordinates");
  } finally {
    await closeServer(server);
    attachDb(null);
    restoreData();
  }
});

test("an entry added to a new target can be removed again", async () => {
  snapshotData();
  attachDb(null);
  srv.setProposedChanges({ items: [proposal("p_net_rm", { targetDataset: "network" })], integratedIds: [] });
  const server = await startServer();
  try {
    await request(server, "POST", "/api/proposed-changes/p_net_rm/integrate", { targetDataset: "network" });
    const before = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "network.json"), "utf8"));
    const baseline = before.competitors.length;
    assert.ok(before.competitors.some((c) => c.proposalId === "p_net_rm"));

    const removed = await request(server, "POST", "/api/proposed-changes/p_net_rm/remove-integration", {});
    assert.strictEqual(removed.status, 200, "removal must work for the new targets too");
    assert.strictEqual(removed.body.entryFound, true);

    const after = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "network.json"), "utf8"));
    assert.strictEqual(after.competitors.length, baseline - 1);
    assert.ok(!after.competitors.some((c) => c.proposalId === "p_net_rm"));
  } finally {
    await closeServer(server);
    restoreData();
  }
});

test("a risk integration requires a real risk category", async () => {
  snapshotData();
  attachDb(null);
  srv.setProposedChanges({ items: [proposal("p_risk_bad", { targetDataset: "risks" })], integratedIds: [] });
  const server = await startServer();
  try {
    const res = await request(server, "POST", "/api/proposed-changes/p_risk_bad/integrate", {
      targetDataset: "risks",
      targetCategoryKey: "not-a-real-risk-category",
    });
    assert.strictEqual(res.status, 400, "an invented risk category must be refused");
  } finally {
    await closeServer(server);
    restoreData();
  }
});

// The drift that started this: the server's list offered a category that does
// not exist in knowledge.json and omitted one that does.
test("CATEGORY_LABELS matches the real knowledge categories", () => {
  const knowledge = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "knowledge.json"), "utf8"));
  const real = Object.keys(knowledge.categories || {}).sort();
  const labels = Object.keys(srv.CATEGORY_LABELS || {}).sort();
  assert.deepStrictEqual(labels, real, "the allowed category list must equal the real categories");
  // Every label should be human-readable, not a raw key.
  for (const [key, label] of Object.entries(srv.CATEGORY_LABELS || {})) {
    assert.ok(label && label.length > 2, `${key} needs a readable label`);
  }
});

// The monitor can only propose against datasets it indexes.
test("the monitor indexes the new datasets, not just the original three", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  for (const name of ["network", "tencent-products", "risks", "company-locations"]) {
    assert.ok(
      new RegExp(`getDataset\\("${name}"\\)[\\s\\S]{0,400}push\\("${name}"`).test(src),
      `${name} must be indexed so updates can be matched against it`
    );
  }
});
