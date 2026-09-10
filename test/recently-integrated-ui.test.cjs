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
  "review.tab.pending",
  "review.tab.recent",
  "review.recent.empty",
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
    "#reviewTabPending .i18n-label", "#reviewTabRecent .i18n-label", "#reviewRecentHint",
    "#settingsProfileTitle", "#settingsProfileHint", "#saveDisplayName",
  ].includes(m.sel));
  assert.strictEqual(mapped.length, 6, "every static string must be mapped");
  for (const m of mapped) {
    for (const lang of ["en", "zh-CN"]) {
      assert.ok(LOCALES[lang][m.key], `${lang} is missing ${m.key} (used by ${m.sel})`);
    }
  }
  // And the elements those selectors target actually exist in the markup.
  for (const sel of ["#reviewTabPending", "#reviewTabRecent", "#reviewRecentHint",
    "#settingsProfileTitle", "#settingsProfileHint", "#saveDisplayName"]) {
    const id = sel.replace("#", "");
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `${sel} must exist in index.html`);
  }
});

test("the review panel has a tab per section, each with a count", () => {
  for (const id of ["reviewTabs", "reviewPanePending", "reviewPaneRecent",
    "reviewTabPendingCount", "reviewTabRecentCount"]) {
    assert.ok(INDEX_HTML.includes(`id="${id}"`), `${id} must exist in index.html`);
  }
  assert.ok(/setupReviewTabs\(/.test(APP_JS), "tabs must be wired up");
  assert.ok(
    /reviewTabPendingCount[\s\S]{0,200}textContent = String\(items\.length\)/.test(APP_JS),
    "the pending tab must show how many updates are waiting"
  );
  assert.ok(
    /reviewTabRecentCount[\s\S]{0,200}textContent = String\(items\.length\)/.test(APP_JS),
    "the recent tab must show how many have been integrated"
  );
});

// Molly asked for one specific change: the button that opens the panel reads
// "Updates", not "Suggested updates". Guarded because it is easy to revert by
// accident when editing copy, and there is no other test that would notice.
test("the landing-page button reads \"Updates\"", () => {
  assert.strictEqual(LOCALES.en["common.suggestedUpdates"], "Updates");
  assert.strictEqual(LOCALES["zh-CN"]["common.suggestedUpdates"], "更新");
  // The modal keeps its own, more descriptive title.
  assert.strictEqual(LOCALES.en["modal.review.title"], "Suggested updates");
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

test("the Recently integrated list renders, with an empty state", () => {
  assert.ok(INDEX_HTML.includes(`id="reviewRecentList"`), "reviewRecentList must exist");
  assert.ok(/renderRecentlyIntegrated\(/.test(APP_JS), "the list must be rendered");
  // An empty tab must explain itself rather than showing a blank panel.
  assert.ok(
    /review\.recent\.empty/.test(APP_JS),
    "an empty Recently integrated tab must show a message"
  );
});

// The bug Molly reported: switching "Add to" did nothing, because the section
// field was decided once at render time and no listener existed for the change.
test("the section field reacts to the Add to dropdown", () => {
  assert.ok(
    /addEventListener\("change"[\s\S]{0,400}select\.proposal-target/.test(APP_JS),
    "there must be a change listener on the target dropdown"
  );
  assert.ok(
    /proposal-field-category[\s\S]{0,300}sel\.value === "knowledge"/.test(APP_JS),
    "the section field must show for the Knowledge Base"
  );
});

// Users cannot know backend category keys, so the field must be a selector of
// real sections — built from the live KB, not a stale hard-coded list.
test("the section field is a selector built from real knowledge categories", () => {
  assert.ok(
    /<select class="proposal-catkey text-input">/.test(APP_JS),
    "the section field must be a <select>, not a free-text input"
  );
  assert.ok(
    !/<input class="proposal-catkey/.test(APP_JS),
    "the old free-text category input must be gone"
  );
  assert.ok(
    /function subTargetOptions/.test(APP_JS) && /kbData\.categories/.test(APP_JS),
    "options must come from the live knowledge-base categories"
  );
  // Risks are subdivided too, from a different dataset — so the options have to
  // depend on which target is selected, not be fixed at render time.
  assert.ok(
    /subTargetOptions\(sel\.value/.test(APP_JS),
    "switching target must rebuild the section options"
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
