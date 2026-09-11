"use strict";

// Suggested Updates 2b-i — profile display names and the "recently integrated"
// feed that surfaces who added what.
//
// The "Added by X" label is PUBLIC, so the rules that matter here are:
//   - a chosen name is used when one exists
//   - otherwise it falls back to the email LOCAL PART, never a full address
//   - nothing about the database failing may break an integrate
//   - integratedByEmail is never sent to the browser

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");
const fs = require("fs");
const path = require("path");

const srv = require("../server");
const { attachDb } = require("../lib/datasets");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

const {
  normaliseDisplayName,
  displayNameMatchKey,
  displayNameRejection,
  fallbackDisplayName,
  lookupDisplayName,
  saveDisplayName,
  DISPLAY_NAME_MAX,
} = srv;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test("normaliseDisplayName trims, collapses whitespace and caps the length", () => {
  assert.strictEqual(normaliseDisplayName("  Molly Barlow  "), "Molly Barlow");
  assert.strictEqual(normaliseDisplayName("Molly   Barlow"), "Molly Barlow");
  assert.strictEqual(normaliseDisplayName("x".repeat(500)).length, DISPLAY_NAME_MAX);
  assert.strictEqual(normaliseDisplayName(null), "");
  assert.strictEqual(normaliseDisplayName(undefined), "");
});

// The name is written into dataset JSON and rendered into HTML, so it must not
// be able to introduce structure into either.
test("normaliseDisplayName strips control characters", () => {
  // Written with escapes on purpose: raw control bytes in source are
  // invisible in a diff and easy for tooling to mangle.
  assert.strictEqual(normaliseDisplayName("Mol\nly"), "Mol ly");
  assert.strictEqual(normaliseDisplayName("Mol\tly"), "Mol ly");
  assert.strictEqual(normaliseDisplayName("Mol\u0000ly"), "Mol ly");
  assert.strictEqual(normaliseDisplayName("Mol\u007Fly"), "Mol ly");
});

test("fallbackDisplayName uses the email local part, never the whole address", () => {
  assert.strictEqual(fallbackDisplayName("mollybarlow@global.tencent.com"), "mollybarlow");
  assert.strictEqual(fallbackDisplayName(""), "unknown");
  assert.strictEqual(fallbackDisplayName(null), "unknown");
  // Guard: a full address must never become the public label.
  assert.ok(!fallbackDisplayName("a@b.com").includes("@"));
});

// ---------------------------------------------------------------------------
// Database-backed lookup — must always fail soft
// ---------------------------------------------------------------------------

test("lookupDisplayName returns the stored name when one is set", async () => {
  const pool = {
    async query(sql, params) {
      if (String(sql).includes("display_name")) {
        assert.strictEqual(params[0], "mollybarlow@global.tencent.com");
        return { rows: [{ display_name: "Molly" }] };
      }
      return { rows: [] };
    },
  };
  attachDb(pool);
  try {
    const name = await lookupDisplayName("mollybarlow@global.tencent.com");
    assert.strictEqual(name, "Molly");
  } finally {
    attachDb(null);
  }
});

test("lookupDisplayName falls back to the local part with no row / no pool / on error", async () => {
  // No row.
  attachDb({ async query() { return { rows: [] }; } });
  try {
    assert.strictEqual(await lookupDisplayName("someone@example.com"), "someone");
  } finally {
    attachDb(null);
  }

  // No pool at all.
  attachDb(null);
  assert.strictEqual(await lookupDisplayName("someone@example.com"), "someone");

  // A broken database must degrade, never throw — integrate depends on this.
  attachDb({ async query() { throw new Error("connection refused"); } });
  try {
    assert.strictEqual(await lookupDisplayName("someone@example.com"), "someone");
  } finally {
    attachDb(null);
  }
});

// The label is public ("Added by X"), so the risk being managed here is TRUST,
// not injection — the value is bound as a query parameter and escaped in HTML.
// What must not happen is a name that reads as the system or an official account.
test("names that could pass as the system or an authority are refused", () => {
  const mustBlock = [
    "root admin", "RoOt   AdMiN", "r00t 4dm1n", "root-admin", "admin (official)",
    "Admin", "administrator", "SYSTEM", "sysadmin", "superuser", "webmaster",
    "support", "helpdesk", "security", "official", "anonymous", "guest", "null",
    "drop table", "DROP TABLE", "'; drop table users; --", "delete from users",
  ];
  for (const name of mustBlock) {
    assert.strictEqual(
      displayNameRejection(normaliseDisplayName(name)), "reserved",
      `"${name}" must be refused`
    );
  }
});

// Over-blocking is its own bug: a blocklist that eats ordinary names is worse
// than no blocklist.
test("ordinary names are left alone", () => {
  for (const name of ["Molly Barlow", "Molly", "mollybarlow", "Sam L", "Modesto", "Olivia", "Li Wei"]) {
    assert.strictEqual(
      displayNameRejection(normaliseDisplayName(name)), null,
      `"${name}" must be allowed`
    );
  }
});

test("the reserved match folds case, spacing, punctuation and leetspeak", () => {
  // All of these are the same word as far as the check is concerned.
  assert.strictEqual(displayNameMatchKey("Admin"), "admin");
  assert.strictEqual(displayNameMatchKey("  ad-min  "), "admin");
  assert.strictEqual(displayNameMatchKey("4DM1N"), "admin");
  assert.strictEqual(displayNameMatchKey("r00t"), "root");
});

// Invisible characters are the sneaky ones: a right-to-left override can make a
// name DISPLAY as something else, and zero-width characters can make two
// different names look identical.
test("invisible and bidi-control characters are stripped", () => {
  assert.strictEqual(normaliseDisplayName("Mol\u200Bly"), "Molly", "zero-width space");
  assert.strictEqual(normaliseDisplayName("Molly\u202Egnp"), "Mollygnp", "right-to-left override");
  assert.strictEqual(normaliseDisplayName("Mol\u00ADly"), "Molly", "soft hyphen");
  assert.strictEqual(normaliseDisplayName("Molly\uFEFF"), "Molly", "byte-order mark");
  // Two names that look the same on screen must be the same stored value.
  assert.strictEqual(normaliseDisplayName("Molly\u200B"), normaliseDisplayName("Molly"));
});

test("a name with no visible characters is refused, not stored as blank", async () => {
  attachDb({ async query() { return { rows: [] }; } });
  try {
    const r = await saveDisplayName("someone@example.com", "\u200B\u200C\u200D");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "no-visible-characters", "must not silently become blank attribution");
  } finally {
    attachDb(null);
  }
});

test("a refused name is never written to the database", async () => {
  const calls = [];
  attachDb({
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [] };
    },
  });
  try {
    const r = await saveDisplayName("someone@example.com", "root admin");
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, "reserved");
    assert.ok(r.message && r.message.length > 10, "the user gets a reason, not a bare error code");
    assert.strictEqual(calls.length, 0, "nothing must be persisted");
  } finally {
    attachDb(null);
  }
});

// --- Client mirror ----------------------------------------------------------
// The browser keeps its own copy of the blocklist so the field can warn as you
// type. That copy is a liability the moment it disagrees with the server: it
// either blocks real names or waves through names the server then refuses.
// These tests load the browser's ACTUAL code and run it, so a divergence in
// either the data or the logic fails here.

function loadClientValidator() {
  const grab = (re, what) => {
    const m = re.exec(APP_JS);
    assert.ok(m, `could not find ${what} in app.js`);
    return m[0];
  };
  const src = [
    grab(/const RESERVED_EXACT_NAMES = \[[^\]]*\];/, "RESERVED_EXACT_NAMES"),
    grab(/const RESERVED_SUBSTRING_NAMES = \[[^\]]*\];/, "RESERVED_SUBSTRING_NAMES"),
    grab(/const LEET_MAP = \{[^}]*\};/, "LEET_MAP"),
    grab(/function displayNameMatchKey\(name\) \{[\s\S]*?\n\}/, "displayNameMatchKey"),
    grab(/function displayNameRejection\(name\) \{[\s\S]*?\n\}/, "displayNameRejection"),
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(`${src}\nreturn { RESERVED_EXACT_NAMES, RESERVED_SUBSTRING_NAMES, LEET_MAP, displayNameMatchKey, displayNameRejection };`)();
}

test("the browser's reserved-name lists are identical to the server's", () => {
  const client = loadClientValidator();
  assert.deepStrictEqual(
    client.RESERVED_EXACT_NAMES, srv.RESERVED_EXACT_NAMES,
    "the client blocklist has drifted from the server's"
  );
  assert.deepStrictEqual(
    client.RESERVED_SUBSTRING_NAMES, srv.RESERVED_SUBSTRING_NAMES,
    "the client substring list has drifted from the server's"
  );
  assert.deepStrictEqual(client.LEET_MAP, srv.LEET_MAP, "the client leet map has drifted");
});

test("the browser and server agree on every kind of name", () => {
  const client = loadClientValidator();
  const samples = [
    "Molly Barlow", "Molly", "mollybarlow", "Sam L", "Modesto", "Olivia", "Li Wei",
    "root admin", "RoOt   AdMiN", "r00t 4dm1n", "root-admin", "admin (official)",
    "Admin", "administrator", "SYSTEM", "support", "official", "anonymous", "test",
    "drop table", "DROP TABLE", "'; drop table users; --", "delete from users",
    "Mol\u200Bly", "\u200B\u200C\u200D", "", "   ", "A",
  ];
  for (const name of samples) {
    // Compare on the SAME normalised input, so this checks the decision logic
    // rather than re-testing sanitisation.
    const normalised = srv.normaliseDisplayName(name);
    assert.strictEqual(
      client.displayNameRejection(normalised), srv.displayNameRejection(normalised),
      `browser and server disagree about ${JSON.stringify(name)}`
    );
  }
});

// Instant feedback only works if something listens for typing.
test("the field validates as the user types", () => {
  assert.ok(
    /displayNameInput[\s\S]{0,2000}addEventListener\("input", validate\)/.test(APP_JS),
    "the display-name input must validate on input"
  );
  // ...and Save is blocked while the name is refused, not merely warned about.
  assert.ok(
    /saveBtn\.disabled = !!problem/.test(APP_JS),
    "Save must be disabled while the name is reserved"
  );
  // The server still re-checks: the client check is a courtesy, not the gate.
  assert.ok(
    /if \(!validate\(\)\) return;/.test(APP_JS),
    "save must refuse to submit a name the client knows is reserved"
  );
});

test("saveDisplayName upserts by email, and an empty name clears it to NULL", async () => {
  const calls = [];
  const pool = {
    async query(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, " ").trim(), params });
      return { rows: [] };
    },
  };
  attachDb(pool);
  try {
    const r = await saveDisplayName("Molly@Example.com", "  Molly Barlow  ");
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.displayName, "Molly Barlow", "normalised before storing");

    // Email is lower-cased so the row matches what auth looks up.
    assert.strictEqual(calls[0].params[0], "molly@example.com");
    assert.ok(calls[0].sql.includes("ON CONFLICT (email) DO UPDATE"), "upsert, not insert");

    // Empty clears, so the label reverts to the fallback instead of showing "".
    const cleared = await saveDisplayName("molly@example.com", "   ");
    assert.strictEqual(cleared.displayName, "");
    assert.strictEqual(calls[1].params[1], null, "stores NULL, not an empty string");
  } finally {
    attachDb(null);
  }
});

// ---------------------------------------------------------------------------
// Profile endpoints + the recently-integrated projection
// ---------------------------------------------------------------------------

// SHARED ON-DISK FIXTURE: the integrate tests below genuinely rewrite
// data/*.json, so the suite must run with --test-concurrency=1 (see the `test`
// script in package.json). In parallel, files clobber each other's restore.
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

test("profile endpoints require a signed-in session", async () => {
  attachDb(null);
  const server = await startServer();
  try {
    // Auth is off in this harness, so there is no req.user — the route must
    // refuse rather than invent an identity.
    const get = await request(server, "GET", "/api/profile");
    assert.strictEqual(get.status, 401);
    const put = await request(server, "PUT", "/api/profile", { displayName: "Nope" });
    assert.strictEqual(put.status, 401);
  } finally {
    await closeServer(server);
  }
});

test("GET /api/proposed-changes reports recently integrated work without exposing emails", async () => {
  snapshotData();
  attachDb(null);
  srv.setProposedChanges({
    items: [
      {
        id: "p_done_1", status: "integrated", title: "A deadline that was added",
        publisher: "Example Publisher", url: "https://example.com/a",
        integratedBy: "Molly", integratedByEmail: "mollybarlow@global.tencent.com",
        integratedAt: "2026-09-09T09:15:50.000Z", integratedTarget: "timeline",
        integratedMode: "new",
      },
      {
        id: "p_done_2", status: "removed", title: "A deadline that was taken back out",
        integratedBy: "Sam", integratedByEmail: "sam@example.com",
        integratedAt: "2026-09-08T09:15:50.000Z", integratedTarget: "knowledge",
        integratedMode: "edit", matchedRecord: { dataset: "knowledge", title: "Some entry" },
        removedBy: "Molly", removedAt: "2026-09-08T10:00:00.000Z",
      },
      // Pending items with no summary are hidden as unenriched placeholders, so
      // this one needs a styledSummary to be queued at all.
      { id: "p_pending", status: "pending", title: "Still to review", styledSummary: ["A point."] },
    ],
    integratedIds: [],
  });
  const server = await startServer();
  try {
    const { status, body } = await request(server, "GET", "/api/proposed-changes");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.pending.length, 1, "only pending items are queued");

    const recent = body.recentlyIntegrated;
    assert.strictEqual(recent.length, 2, "integrated + removed, newest first");
    assert.strictEqual(recent[0].id, "p_done_1");
    assert.strictEqual(recent[1].id, "p_done_2");

    // Attribution is public...
    assert.strictEqual(recent[0].integratedBy, "Molly");
    // ...but the email is not.
    const serialised = JSON.stringify(body);
    assert.ok(!serialised.includes("mollybarlow@global.tencent.com"), "no email in the payload");
    assert.ok(!serialised.includes("sam@example.com"), "no email in the payload");

    // The mode tells the UI whether it can remove it or only flag it.
    assert.strictEqual(recent[0].integratedMode, "new");
    assert.strictEqual(recent[1].integratedMode, "edit");
    assert.strictEqual(recent[1].matchedRecordTitle, "Some entry");
  } finally {
    await closeServer(server);
    restoreData();
  }
});

test("integrate records the mode so removal knows which path applies", async () => {
  snapshotData();
  attachDb(null); // disk-only: we are asserting proposal metadata, not persistence

  const timeline = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "regulatory-timeline.json"), "utf8"));
  const existingEvent = timeline.events[0];
  const originalDescription = existingEvent.description;

  srv.setProposedChanges({
    items: [
      {
        id: "p_edit_1", status: "pending", title: "Ignored — merges into a match",
        publisher: "Example Publisher", url: "https://example.com/b",
        category: "timeline", suggestedEdit: "An appended sentence about procurement.",
        matchedRecord: { dataset: "timeline", title: existingEvent.title },
      },
      {
        id: "p_new_1", status: "pending", title: "A brand new deadline",
        publisher: "Example Publisher", url: "https://example.com/c",
        category: "timeline", publishedAt: "2026-09-08T00:00:00Z",
        suggestedEdit: "A newly created entry.",
      },
    ],
    integratedIds: [],
  });

  const server = await startServer();
  try {
    const editRes = await request(server, "POST", "/api/proposed-changes/p_edit_1/integrate", {});
    assert.strictEqual(editRes.status, 200, "edit-path integrate succeeds");

    const newRes = await request(server, "POST", "/api/proposed-changes/p_new_1/integrate", {});
    assert.strictEqual(newRes.status, 200, "new-entry integrate succeeds");

    const items = srv.getProposedChanges().items;
    const edited = items.find((i) => i.id === "p_edit_1");
    const created = items.find((i) => i.id === "p_new_1");

    assert.strictEqual(edited.integratedMode, "edit", "merged into an existing record");
    assert.strictEqual(created.integratedMode, "new", "created a self-contained entry");

    // The exact pre-edit text, so reverting later is a restore and not surgery.
    assert.strictEqual(
      edited.integratedPreviousContent, originalDescription,
      "the previous content is snapshotted verbatim"
    );
    assert.ok(!("integratedPreviousContent" in created), "new entries have nothing to restore");

    // The edit merged into the existing event; the other proposal added one.
    const after = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "regulatory-timeline.json"), "utf8"));
    assert.strictEqual(
      after.events.length, timeline.events.length + 1,
      "the edit merged rather than duplicating; the new proposal added exactly one"
    );
    // Find by title — the new entry was unshifted to the front, so index 0 is
    // not the record that was edited.
    const merged = after.events.find((e) => e.title === existingEvent.title);
    assert.ok(merged, "the matched event still exists");
    assert.ok(merged.description.includes("procurement"), "the edit was appended");
    assert.ok(
      merged.description.startsWith(originalDescription),
      "the original curated text is preserved, not replaced"
    );
    assert.strictEqual(merged.lastUpdatedBy, "unknown", "edits say who last updated, not who added");
  } finally {
    await closeServer(server);
    restoreData();
  }
});
