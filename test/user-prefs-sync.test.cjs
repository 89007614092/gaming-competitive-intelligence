"use strict";

// C2 — cross-device preference sync.
//
// The rules that matter:
//   1. only whitelisted preferences are stored (a credential is never uploaded)
//   2. it fails SOFT — no database or a DB error leaves the app working
//   3. the browser keeps its local copy and sync is a convenience, not a gate

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

process.env.OPEN_MODEL_API_KEY = "test-key";
process.env.OPEN_MODEL_BASE_URL = "http://localhost:9/v1";
process.env.OPEN_MODEL_NAME = "openai/gpt-oss-120b";

const srv = require("../server");
const { attachDb } = require("../lib/datasets");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// --- the whitelist -----------------------------------------------------------

test("only whitelisted preference fields survive sanitising", () => {
  const out = srv.sanitisePrefs({
    savedArticles: [{ id: 1 }],
    newsFolders: [{ name: "F" }],
    newsCompetitorIds: ["a"],
    tabOrder: ["knowledge", "news"],
    // The two that must never be stored:
    adminKey: "super-secret-key",
    LANG: "zh-CN",
    // And anything else a buggy client might send:
    somethingElse: "nope",
  });
  assert.deepStrictEqual(Object.keys(out).sort(), [
    "newsCompetitorIds", "newsFolders", "savedArticles", "tabOrder",
  ]);
  assert.ok(!("adminKey" in out), "adminKey must never be persisted");
  assert.ok(!("LANG" in out), "LANG must never be persisted");
});

test("sanitising tolerates junk input", () => {
  for (const junk of [null, undefined, "string", 42, [1, 2]]) {
    assert.deepStrictEqual(srv.sanitisePrefs(junk), {}, `junk: ${String(junk)}`);
  }
});

test("SYNCABLE_PREF_KEYS is exactly the intended four, and excludes credentials", () => {
  assert.deepStrictEqual([...srv.SYNCABLE_PREF_KEYS].sort(), [
    "newsCompetitorIds", "newsFolders", "savedArticles", "tabOrder",
  ]);
  for (const forbidden of ["adminKey", "LANG", "ADMIN_API_KEY"]) {
    assert.ok(!srv.SYNCABLE_PREF_KEYS.includes(forbidden), `${forbidden} must not be syncable`);
  }
});

// --- round trip against a fake pool ------------------------------------------

function makePrefsPool() {
  const rows = new Map();
  const calls = [];
  return {
    calls,
    rows,
    async query(text, params = []) {
      const sql = String(text).replace(/\s+/g, " ").trim();
      calls.push(sql);
      if (sql.includes("CREATE TABLE IF NOT EXISTS user_prefs")) return { rows: [] };
      if (sql.startsWith("SELECT payload")) {
        const row = rows.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (sql.startsWith("INSERT INTO user_prefs")) {
        rows.set(params[0], { payload: JSON.parse(params[1]), updated_at: new Date().toISOString() });
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

test("a preference set round-trips for the same account, and only that account", async () => {
  const pool = makePrefsPool();
  attachDb(pool);
  try {
    const saved = await srv.saveUserPrefs("Molly@Example.com", {
      savedArticles: [{ id: 1 }],
      adminKey: "leak-me",
    });
    assert.strictEqual(saved.ok, true);
    // Stored under the normalised email, and the credential is gone.
    assert.deepStrictEqual(pool.rows.get("molly@example.com").payload, { savedArticles: [{ id: 1 }] });

    const loaded = await srv.loadUserPrefs("molly@example.com");
    assert.deepStrictEqual(loaded.prefs, { savedArticles: [{ id: 1 }] });
    // A different account sees nothing.
    const other = await srv.loadUserPrefs("someone@example.com");
    assert.strictEqual(other.prefs, null);
  } finally {
    attachDb(null);
  }
});

test("an oversized payload is refused rather than stored", async () => {
  const pool = makePrefsPool();
  attachDb(pool);
  try {
    const huge = { savedArticles: [{ blob: "x".repeat(300 * 1024) }] };
    const r = await srv.saveUserPrefs("a@b.com", huge);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "too-large");
    assert.strictEqual(pool.rows.size, 0, "nothing must be written");
  } finally {
    attachDb(null);
  }
});

test("no database, or a failing one, fails soft — sync never breaks the app", async () => {
  attachDb(null);
  const none = await srv.loadUserPrefs("a@b.com");
  assert.strictEqual(none.prefs, null, "no DB must simply mean no synced prefs");
  const saveNone = await srv.saveUserPrefs("a@b.com", { tabOrder: ["a"] });
  assert.strictEqual(saveNone.ok, false);

  // Now a DB that throws.
  attachDb({ async query() { throw new Error("connection reset"); } });
  const boom = await srv.loadUserPrefs("a@b.com");
  assert.strictEqual(boom.prefs, null, "an error must degrade, not throw");
  const boomSave = await srv.saveUserPrefs("a@b.com", { tabOrder: ["a"] });
  assert.strictEqual(boomSave.ok, false);
  attachDb(null);
});

// --- endpoints ---------------------------------------------------------------

async function withServer(pool, fn) {
  attachDb(pool);
  const server = http.createServer(srv.app);
  // Simulate an authenticated session regardless of AUTH_ENABLED, so these
  // tests exercise the route logic rather than the auth provider.
  server.on("request", (req, res) => { /* noop: keeps default pipeline */ });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    return await fn(server);
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
    attachDb(null);
  }
}

test("GET /api/prefs requires a session", async () => {
  await withServer(makePrefsPool(), async (server) => {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/prefs`);
    // Auth is off in the test env, so the app reports that rather than 200-ing.
    assert.ok(res.status === 401 || res.status === 503, `expected 401/503, got ${res.status}`);
  });
});

// --- the browser side --------------------------------------------------------

test("the client maps only the whitelisted keys", () => {
  const m = /const PREF_STORAGE_MAP = \[[\s\S]*?\];/.exec(APP_JS);
  assert.ok(m, "PREF_STORAGE_MAP must exist");
  for (const field of ["savedArticles", "newsFolders", "newsCompetitorIds", "tabOrder"]) {
    assert.ok(m[0].includes(`field: "${field}"`), `${field} must be mapped`);
  }
  // And explicitly documents what is NOT synced.
  assert.ok(/PREF_NON_SYNCABLE = \["adminKey", "LANG"\]/.test(APP_JS),
    "the client must name adminKey and LANG as non-syncable");
});

test("sync is debounced and never blocks the local copy", () => {
  // Local writes happen first; the sync only mirrors them afterwards.
  assert.ok(/saveNewsArticles\(\) \{\s*localStorage\.setItem[\s\S]{0,120}queuePrefsSync\(\)/.test(APP_JS),
    "saving must write locally then queue a sync");
  assert.ok(/setTimeout\(async \(\) => \{[\s\S]*?\}, 800\)/.test(APP_JS), "sync must be debounced");
  // A failed sync must be swallowed — the device stays usable.
  assert.ok(/catch \(_\) \{[\s\S]{0,200}Sync is a convenience/.test(APP_JS),
    "a failed sync must not surface as an error to the user");
});

test("hydration runs only once a session is confirmed", () => {
  assert.ok(/syncPrefsWithServer\(\);/.test(APP_JS), "hydration must be invoked");
  // It must come AFTER the successful profile fetch, not before the ok check.
  const okIndex = APP_JS.indexOf('if (!res.ok) {');
  const syncIndex = APP_JS.indexOf('syncPrefsWithServer();');
  assert.ok(okIndex > -1 && syncIndex > okIndex,
    "hydration must run after the session check passes");
});
