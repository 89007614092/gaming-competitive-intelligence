// Suggested-Updates overhaul tests (PR #81):
//  - looksNonEnglish drops Latin-script European languages (the leak that let
//    Italian/French/German/Spanish items into Suggested Updates)
//  - enrichmentFailure enforces the structured schema
//  - enrichWithModel returns jurisdiction + whyItMatters, retries once on a
//    validation failure, and flags for manual review when both attempts fail.
process.env.SCAN_MODEL_MIN_GAP_MS = "50"; // keep any paced retry fast

const test = require("node:test");
const assert = require("node:assert");

const summariseEngine = require("../summarise-engine");
const srv = require("../server");

const GOOD = JSON.stringify({
  updateCategory: "new-development",
  updateReason: "Regulator published new guidance.",
  styledSummary:
    "The European Data Protection Board issued detailed guidance clarifying data-subject rights under the GDPR, including stronger consent and access obligations that apply to AI processors from next year.",
  jurisdiction: "EU",
  whyItMatters:
    "It tightens how AI systems handling personal data must obtain and demonstrate valid consent, raising the compliance bar for model operators.",
});

// A schema-incomplete response: summary too short, no jurisdiction, no whyItMatters.
const BAD = JSON.stringify({
  updateCategory: "new-development",
  updateReason: "x",
  styledSummary: "Short summary that is too brief.",
});

const prop = () => ({ title: "EDPB guidance on data subject rights", detectedAction: "new", snippet: "some source text" });

test("looksNonEnglish drops Latin-script European languages, keeps English", () => {
  assert.strictEqual(srv.looksNonEnglish("Linee guida sui tuoi diritti", 2), true, "Italian must be dropped");
  assert.strictEqual(srv.looksNonEnglish("Le gouvernement publie la loi IA", 2), true, "French must be dropped");
  assert.strictEqual(srv.looksNonEnglish("Die Regierung beschließt das neue KI-Gesetz", 2), true, "German must be dropped");
  assert.strictEqual(srv.looksNonEnglish("La Comisión publica la ley de IA", 2), true, "Spanish must be dropped");
  assert.strictEqual(srv.looksNonEnglish("The EU AI Act sets new compliance rules", 2), false, "English must be kept");
  // Too short to judge reliably -> admitted (never dropped on thin text alone).
  assert.strictEqual(srv.looksNonEnglish("AI", 2), false, "very short text is admitted");
  // Proper-noun English headline with no function words is NOT falsely dropped.
  assert.strictEqual(srv.looksNonEnglish("Nvidia Blackwell GPU Announced", 2), false, "English proper-noun headline kept");
});

test("enrichmentFailure enforces the structured schema", () => {
  assert.strictEqual(srv.enrichmentFailure(JSON.parse(GOOD), prop()), null, "valid output passes");
  const longSummary = "x".repeat(90);
  assert.match(srv.enrichmentFailure({ styledSummary: longSummary }, prop()), /jurisdiction/, "missing jurisdiction fails");
  assert.match(srv.enrichmentFailure({ styledSummary: longSummary, jurisdiction: "EU" }, prop()), /whyItMatters/, "missing whyItMatters fails");
  // Tiny summary fails on length before the other checks.
  assert.match(srv.enrichmentFailure({ styledSummary: "too short", jurisdiction: "EU", whyItMatters: "x".repeat(30) }, prop()), /too short/, "tiny summary fails");
  // Pure headline restatement fails.
  const title = "EU AI Act updated with compliance deadline";
  const restate = { styledSummary: `${title}. ${title}.`, jurisdiction: "EU", whyItMatters: "x".repeat(30) };
  assert.match(srv.enrichmentFailure(restate, { title }), /restates/, "headline echo fails");
});

test("enrichWithModel returns structured fields on a good response", async () => {
  summariseEngine.runModelChat = async () => GOOD;
  try {
    const out = await srv.enrichWithModel(prop(), "source text", { allowReject: true });
    assert.ok(out && out.styledSummary, "summary present");
    assert.strictEqual(out.jurisdiction, "EU", "jurisdiction captured");
    assert.ok(out.whyItMatters && out.whyItMatters.length >= 30, "whyItMatters captured");
    assert.strictEqual(out.blocked, undefined, "not blocked on success");
  } finally {
    delete summariseEngine.runModelChat;
  }
});

test("enrichWithModel retries once on validation failure, then succeeds", async () => {
  let n = 0;
  summariseEngine.runModelChat = async () => (n++ === 0 ? BAD : GOOD);
  try {
    const out = await srv.enrichWithModel(prop(), "source text", { allowReject: true });
    assert.strictEqual(n, 2, "exactly one retry occurred");
    assert.strictEqual(out.blocked, undefined, "not blocked when retry succeeds");
    assert.strictEqual(out.jurisdiction, "EU", "valid fields from the retry are used");
  } finally {
    delete summariseEngine.runModelChat;
  }
});

test("enrichWithModel flags for manual review when both attempts fail", async () => {
  summariseEngine.runModelChat = async () => BAD;
  try {
    const out = await srv.enrichWithModel(prop(), "source text", { allowReject: true });
    assert.strictEqual(out.blocked, true, "flagged for manual review");
    assert.ok(out.partial, "partial fields surfaced for the reviewer");
  } finally {
    delete summariseEngine.runModelChat;
  }
});

test("enrichWithModel does not block analyst (manual) items on validation failure", async () => {
  summariseEngine.runModelChat = async () => BAD;
  try {
    const out = await srv.enrichWithModel(prop(), "source text", { allowReject: false });
    assert.strictEqual(out.blocked, undefined, "manual item is never blocked");
    assert.ok(out.styledSummary, "best-effort summary returned");
  } finally {
    delete summariseEngine.runModelChat;
  }
});
