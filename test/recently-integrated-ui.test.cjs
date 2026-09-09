"use strict";

// Suggested Updates 2b-iii — the UI half.
//
// There is no frontend test harness, so these are source-level contracts plus
// the i18n dictionaries (which ARE loadable in Node). They exist to catch the
// two failures that are otherwise invisible until someone looks at the page:
//   1. a new string shipped in English only, leaving the Chinese UI half-English
//   2. the client and server drifting apart on a field or endpoint name

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { LOCALES, I18N_MAP } = require("../public/locales.js");

const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
const SERVER_JS = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// Every key the Recently integrated UI and the attribution chip rely on.
const NEW_KEYS = [
  "review.recent.title",
  "review.recent.hint",
  "review.removeEntry",
  "review.undoRemove",
  "review.flagRevert",
  "review.clearFlag",
  "review.removed",
  "review.revertRequested",
  "review.mergedInto",
  "kb.addedBy",
  "kb.updatedBy",
  "settings.profile.title",
  "settings.profile.hint",
  "settings.profile.save",
  "settings.profile.saved",
];

test("every new UI string exists in BOTH dictionaries", () => {
  for (const lang of ["en", "zh-CN"]) {
    const dict = LOCALES[lang];
    assert.ok(dict, `${lang} dictionary must exist`);
    for (const key of NEW_KEYS) {
      assert.ok(key in dict, `${lang} is missing ${key}`);
      assert.strictEqual(typeof dict[key], "string", `${lang}.${key} must be a string`);
      assert.ok(dict[key].trim().length > 0, `${lang}.${key} must not be empty`);
    }
  }
});

// The classic failure: a key added to `en` and forgotten in `zh-CN`, which then
// renders the raw key or falls back to English mid-sentence.
test("the new keys are translated, not copies of the English text", () => {
  for (const key of NEW_KEYS) {
    if (key === "settings.profile.save") continue; // "Save"/"保存" legitimately short
    assert.notStrictEqual(
      LOCALES["zh-CN"][key], LOCALES.en[key],
      `zh-CN.${key} looks like untranslated English`
    );
  }
});

test("the static-shell selectors are wired, and their keys resolve", () => {
  const mapped = I18N_MAP.filter((m) => [
    "#reviewRecentTitle", "#reviewRecentHint",
    "#settingsProfileTitle", "#settingsProfileHint", "#saveDisplayName",
  ].includes(m.sel));
  assert.strictEqual(mapped.length, 5, "all five static strings must be mapped");
  for (const m of mapped) {
    for (const lang of ["en", "zh-CN"]) {
      assert.ok(LOCALES[lang][m.key], `${lang} is missing ${m.key} (used by ${m.sel})`);
    }
  }
  // And the elements those selectors target actually exist in the markup.
  for (const sel of ["#reviewRecentTitle", "#reviewRecentHint", "#settingsProfileTitle",
    "#settingsProfileHint", "#saveDisplayName"]) {
    const id = sel.replace("#", "");
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `${sel} must exist in index.html`);
  }
});

test("the client reads the field the server actually sends", () => {
  // Server side: the read endpoint must expose `recentlyIntegrated`...
  assert.ok(
    SERVER_JS.includes("recentlyIntegrated"),
    "server must return a recentlyIntegrated array"
  );
  // ...and the client must consume that exact name. A rename on either side
  // would silently show an empty section with no error anywhere.
  assert.ok(
    /json\.recentlyIntegrated/.test(APP_JS),
    "app.js must render json.recentlyIntegrated"
  );
});

test("the client calls the three endpoints the server defines", () => {
  for (const route of ["/remove-integration", "/undo-removal", "/flag-revert"]) {
    assert.ok(SERVER_JS.includes(`/api/proposed-changes/:id${route}`), `server must define ${route}`);
    assert.ok(APP_JS.includes(route), `app.js must call ${route}`);
  }
});

test("the Recently integrated section renders inside the review panel", () => {
  for (const id of ["reviewRecentSection", "reviewRecentList"]) {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `${id} must exist in index.html`);
  }
  assert.ok(/renderRecentlyIntegrated\(/.test(APP_JS), "the section must be rendered");
  // Guarded: it is hidden when there is nothing to show, rather than showing an
  // empty heading.
  assert.ok(
    /reviewRecentSection[\s\S]{0,400}style\.display = "none"/.test(APP_JS),
    "the section must hide itself when the list is empty"
  );
});

// The label is public, so a name must never be able to inject markup.
test("attribution output is escaped, and absent when there is nothing to attribute", () => {
  assert.ok(
    /escapeHtml\(entry\.addedBy\)/.test(APP_JS),
    "the added-by name must be escaped before rendering"
  );
  assert.ok(
    /if \(!bits\.length\) return "";/.test(APP_JS),
    "entries without attribution must render no label at all"
  );
  // The chip is only ever built from the attribution fields — never from a raw
  // email, which would be a privacy leak in a public label.
  assert.ok(
    !/addedByEmail/.test(APP_JS),
    "the client must never render an attribution email address"
  );
});
