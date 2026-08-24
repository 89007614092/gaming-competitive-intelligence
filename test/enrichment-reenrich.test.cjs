// Re-enrichment tests (Step 0 + Step 1 of the Suggested Updates recovery):
//  - needsEnrichment() flags pre-#81 items (no jurisdiction/whyItMatters) and
//    short/legacy summaries so scans + the admin re-enrich endpoint upgrade them.
//  - enrichOneProposal() re-enriches a stale item into the full #81 schema
//    (jurisdiction + whyItMatters), and correctly routes rate-limited / blocked
//    / non-English outcomes.
process.env.SCAN_MODEL_MIN_GAP_MS = "10"; // keep paced calls fast

const test = require("node:test");
const assert = require("node:assert");

const summariseEngine = require("../summarise-engine");
const srv = require("../server");

const resetBudget = () => {
  const ss = srv.getSourceState();
  ss.scanBudget = { day: new Date().toISOString().slice(0, 10), used: 0 };
};

const GOOD = JSON.stringify({
  updateCategory: "new-development",
  updateReason: "Regulator published new guidance.",
  styledSummary:
    "The OECD AI Policy Observatory set out a five-step roadmap to close the AI evaluation gap, covering benchmark methodology, independent auditing, incident reporting, red-teaming standards and public evaluation leaderboards for general-purpose models.",
  jurisdiction: "global",
  whyItMatters:
    "It gives regulators a shared vocabulary for assessing model capability and safety, shaping how governments procure and govern high-risk AI.",
});

const fetcher = async (prop, opts) => ({
  text: "The OECD AI Policy Observatory published a five-step roadmap to close the AI evaluation gap, covering benchmarking, auditing, incident reporting, red-teaming and public leaderboards.",
  blocked: false,
});

const staleProp = () => ({
  id: "stale1",
  title: "OECD five-step roadmap to close the AI evaluation gap",
  detectedAction: "new",
  category: "regulation",
  snippet: "A five-step roadmap to closing the AI evaluation gap",
  publisher: "OECD AI Policy Observatory",
  status: "pending",
  enrichStatus: "done",
  // Deliberately pre-#81: a legacy one-line summary, NO jurisdiction/whyItMatters.
  styledSummary: "The OECD published a five-step roadmap to close the AI evaluation gap.",
  preview: "old preview text",
});

test("needsEnrichment: false for a fully #81-enriched item", () => {
  const full = {
    preview: "p", updateCategory: "new-development",
    styledSummary: "x".repeat(90), jurisdiction: "EU", whyItMatters: "y".repeat(40),
  };
  assert.strictEqual(srv.needsEnrichment(full), false);
});

test("needsEnrichment: true for pre-#81 item (no jurisdiction/whyItMatters)", () => {
  const legacy = {
    preview: "p", updateCategory: "new-development", styledSummary: "x".repeat(90),
  };
  assert.strictEqual(srv.needsEnrichment(legacy), true, "missing jurisdiction/whyItMatters must re-enrich");
});

test("needsEnrichment: true for a short/legacy summary", () => {
  const short = {
    preview: "p", updateCategory: "new-development",
    styledSummary: "Too brief.", jurisdiction: "EU", whyItMatters: "y".repeat(40),
  };
  assert.strictEqual(srv.needsEnrichment(short), true, "sub-80-char summary must re-enrich");
});

test("needsEnrichment: true when the heuristic reason is missing", () => {
  const noReason = {
    preview: "p", styledSummary: "x".repeat(90), jurisdiction: "EU", whyItMatters: "y".repeat(40),
  };
  assert.strictEqual(srv.needsEnrichment(noReason), true);
});

test("enrichOneProposal upgrades a stale item to the full #81 schema", async () => {
  resetBudget();
  summariseEngine.runModelChat = async () => GOOD;
  try {
    const prop = staleProp();
    const status = await srv.enrichOneProposal(prop, { callsThisRun: 0 }, fetcher);
    assert.strictEqual(status, "enriched", "stale item should re-enrich successfully");
    assert.strictEqual(prop.jurisdiction, "global", "jurisdiction captured by re-enrichment");
    assert.ok(prop.whyItMatters && prop.whyItMatters.length >= 30, "whyItMatters captured");
    assert.ok(prop.styledSummary.length >= 80, "new summary is substantive, not the legacy one-liner");
    assert.notStrictEqual(prop.styledSummary, staleProp().styledSummary, "legacy summary replaced");
    assert.strictEqual(prop.enrichStatus, "done");
  } finally {
    delete summariseEngine.runModelChat;
  }
});

test("enrichOneProposal returns rate-limited + sets a backoff on a 429", async () => {
  resetBudget();
  summariseEngine.runModelChat = async () => ({ rateLimited: true });
  try {
    const prop = { id: "rl1", title: "X", detectedAction: "new", category: "regulation", snippet: "y", status: "pending", enrichStatus: "rate-limited" };
    const status = await srv.enrichOneProposal(prop, { callsThisRun: 0 }, fetcher);
    assert.strictEqual(status, "rate-limited");
    assert.ok(prop.enrichCooldownUntil, "per-proposal backoff must be set");
    assert.ok(new Date(prop.enrichCooldownUntil).getTime() > Date.now(), "backoff is in the future");
    assert.strictEqual(prop.enrichStatus, "rate-limited");
  } finally {
    delete summariseEngine.runModelChat;
  }
});

test("enrichOneProposal returns blocked when the fetch hits a bot-wall", async () => {
  resetBudget();
  const blockedFetcher = async () => ({ text: "", blocked: true });
  const prop = { id: "blk", title: "X", detectedAction: "new", category: "regulation", snippet: "y", status: "pending" };
  const status = await srv.enrichOneProposal(prop, { callsThisRun: 0 }, blockedFetcher);
  assert.strictEqual(status, "blocked");
  assert.strictEqual(prop.fetchStatus, "blocked");
});

test("enrichOneProposal rejects a non-English (Latin-script) body", async () => {
  resetBudget();
  const itFetcher = async () => ({ text: "Linee guida sui tuoi diritti pubblicate dal governo", blocked: false });
  const prop = { id: "it1", title: "X", detectedAction: "new", category: "regulation", snippet: "y", status: "pending" };
  const status = await srv.enrichOneProposal(prop, { callsThisRun: 0 }, itFetcher);
  assert.strictEqual(status, "rejected");
  assert.strictEqual(prop.status, "rejected");
  assert.strictEqual(prop.rejectedByLanguage, true);
});

// --- Step 2: enrichment must consume the FULL body, not just the short card lead ---
const LONG_BODY =
  "The OECD AI Policy Observatory published a five-step roadmap to close the AI evaluation gap. " +
  "Step 1 establishes a benchmark methodology for evaluating general-purpose models. " +
  "Step 2 mandates independent auditing of frontier systems. " +
  "Step 3 requires incident reporting. " +
  "Step 4 sets red-teaming standards. " +
  "Step 5 creates public evaluation leaderboards for transparency.";
const SHORT_LEAD = "The OECD published a five-step roadmap to close the AI evaluation gap.";

test("Step 2: model receives the full body (not just the card lead)", async () => {
  resetBudget();
  const captured = { user: "" };
  summariseEngine.runModelChat = async (system, user) => { captured.user = user; return GOOD; };
  try {
    const bodyFetcher = async () => ({ text: SHORT_LEAD, body: LONG_BODY, blocked: false });
    const prop = { id: "step2a", title: "OECD roadmap", detectedAction: "new", category: "regulation", snippet: "y", status: "pending" };
    const status = await srv.enrichOneProposal(prop, { callsThisRun: 0 }, bodyFetcher);
    assert.strictEqual(status, "enriched");
    // The body-only phrase must reach the model prompt...
    assert.ok(captured.user.includes("Step 1 establishes a benchmark methodology"), "model must see body content beyond the lead");
    // ...and the card preview must stay the short lead, NOT the long body.
    assert.strictEqual(prop.preview, SHORT_LEAD, "card preview stays the short lead");
    assert.ok(prop.preview.length < 200, "card preview is short");
    assert.ok(prop.styledSummary && prop.styledSummary.length >= 80, "substantive summary produced");
  } finally {
    delete summariseEngine.runModelChat;
  }
});

test("Step 2: falls back to the lead when the fetcher returns no body (legacy shape)", async () => {
  resetBudget();
  const captured = { user: "" };
  summariseEngine.runModelChat = async (system, user) => { captured.user = user; return GOOD; };
  try {
    // Legacy fetcher shape: { text, blocked } with no `body` field.
    const legacyFetcher = async () => ({ text: SHORT_LEAD, blocked: false });
    const prop = { id: "step2b", title: "OECD roadmap", detectedAction: "new", category: "regulation", snippet: "y", status: "pending" };
    const status = await srv.enrichOneProposal(prop, { callsThisRun: 0 }, legacyFetcher);
    assert.strictEqual(status, "enriched");
    assert.ok(captured.user.includes("five-step roadmap to close the AI evaluation gap"), "model sees the lead text");
    assert.strictEqual(prop.preview, SHORT_LEAD);
  } finally {
    delete summariseEngine.runModelChat;
  }
});
