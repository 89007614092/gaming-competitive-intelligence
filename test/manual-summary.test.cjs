// Manual-store summary generation (Phase 3 quick win #1).
// Verifies that a stored/ingested item with a body but no AI summary gets one
// generated via the existing scan enrichment prompt, and that we never clobber
// an existing summary or waste a model call on too-short text.
process.env.SCAN_MODEL_MIN_GAP_MS = "50";

const test = require("node:test");
const assert = require("node:assert");

const summariseEngine = require("../summarise-engine");
const srv = require("../server");

const FAKE_SUMMARY = JSON.stringify({
  updateCategory: "new-development",
  updateReason: "Manually submitted analyst item.",
  styledSummary: "The EU AI Act's high-risk obligations take effect in August 2026, tightening transparency rules for general-purpose models.",
});

let originalRun = null;
function stubModel() {
  originalRun = summariseEngine.runModelChat;
  summariseEngine.runModelChat = async () => FAKE_SUMMARY;
}
function restoreModel() {
  if (originalRun) summariseEngine.runModelChat = originalRun;
}

test("summariseStoredItem generates a styledSummary for a manual item", async () => {
  stubModel();
  try {
    const prop = {
      id: "manual-1",
      title: "EU AI Act update",
      body: "The European Commission confirmed the AI Act's high-risk obligations take effect in August 2026, with new transparency mandates for general-purpose models and penalties for non-compliance.",
      preview: "",
      snippet: "",
    };
    const summary = await srv.summariseStoredItem(prop, { force: true });
    assert.ok(summary, "a summary string is returned");
    assert.strictEqual(prop.styledSummary, summary, "prop.styledSummary is set from the model output");
    assert.strictEqual(prop.enrichStatus, "done");
    assert.strictEqual(prop.updateCategory, "new-development");
  } finally {
    restoreModel();
  }
});

test("summariseStoredItem is a no-op when a summary already exists", async () => {
  stubModel();
  try {
    const prop = {
      id: "manual-2",
      body: "Sufficiently long body text so the length gate passes and the model would normally be called, but an existing summary must be preserved here without a new call.",
      styledSummary: "EXISTING SUMMARY",
    };
    const summary = await srv.summariseStoredItem(prop, { force: true });
    assert.strictEqual(summary, null, "returns null when already summarised");
    assert.strictEqual(prop.styledSummary, "EXISTING SUMMARY", "existing summary untouched");
  } finally {
    restoreModel();
  }
});

test("summariseStoredItem skips text shorter than the threshold", async () => {
  stubModel();
  try {
    let called = false;
    summariseEngine.runModelChat = async () => { called = true; return FAKE_SUMMARY; };
    const prop = { id: "manual-3", body: "too short" };
    const summary = await srv.summariseStoredItem(prop, { force: true });
    assert.strictEqual(summary, null);
    assert.strictEqual(called, false, "model must NOT be called for too-short text");
  } finally {
    restoreModel();
  }
});
