// Suggested-Updates rebuild tests (PR #85):
//  - looksNonEnglish drops Latin-script European languages (the leak that let
//    Italian/French/German/Spanish items into Suggested Updates)
//  - enrichmentFailure enforces the simplified schema (combined styledSummary +
//    jurisdiction; the "why it matters" rationale is folded INTO styledSummary)
//  - enrichWithModel returns the combined styledSummary + jurisdiction, retries
//    once on a validation failure, and flags for manual review when both fail.
process.env.SCAN_MODEL_MIN_GAP_MS = "50"; // keep any paced retry fast

const test = require("node:test");
const assert = require("node:assert");

const summariseEngine = require("../summarise-engine");
const srv = require("../server");

// The combined entry: what the source says AND why it matters as an update.
const GOOD = JSON.stringify({
  updateCategory: "new-development",
  styledSummary:
    "The European Data Protection Board issued guidance clarifying data-subject rights under the GDPR, including stronger consent and access obligations for AI processors from next year. This raises the compliance bar for model operators handling personal data.",
  jurisdiction: "EU",
});

// A schema-incomplete response: summary too short, no jurisdiction.
const BAD = JSON.stringify({
  updateCategory: "new-development",
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

test("enrichmentFailure enforces the simplified schema", () => {
  assert.strictEqual(srv.enrichmentFailure(JSON.parse(GOOD), prop()), null, "valid output passes");
  const longSummary = "x".repeat(90);
  assert.match(srv.enrichmentFailure({ styledSummary: longSummary }, prop()), /jurisdiction/, "missing jurisdiction fails");
  // Tiny summary fails on length before the other checks.
  assert.match(srv.enrichmentFailure({ styledSummary: "too short", jurisdiction: "EU" }, prop()), /too short/, "tiny summary fails");
  // Pure headline restatement fails.
  const title = "EU AI Act updated with compliance deadline";
  const restate = { styledSummary: `${title}. ${title}.`, jurisdiction: "EU" };
  assert.match(srv.enrichmentFailure(restate, { title }), /restates/, "headline echo fails");
});

test("enrichWithModel returns the combined entry on a good response", async () => {
  summariseEngine.runModelChat = async () => GOOD;
  try {
    const out = await srv.enrichWithModel(prop(), "source text", { allowReject: true });
    assert.ok(out && out.styledSummary, "summary present");
    assert.strictEqual(out.jurisdiction, "EU", "jurisdiction captured");
    assert.strictEqual(out.whyItMatters, undefined, "no separate whyItMatters field");
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
