// Pure-function test harness (node:test). Run with: node --test
// Requires server.js (which is importable without booting, thanks to the
// require.main === module guards) and summarise-engine.
process.env.SCAN_MODEL_MIN_GAP_MS = "50"; // keep the pacing test fast

const test = require("node:test");
const assert = require("node:assert");

const srv = require("../server");
const eng = require("../summarise-engine");

test("isLikelyEnglish accepts English, rejects obvious non-English", () => {
  assert.strictEqual(srv.isLikelyEnglish("The EU AI Act sets new compliance rules"), true);
  // Non-Latin scripts must be rejected. CJK is the important case: it has no
  // spaces, so it tokenizes to <4 tokens and skips the Latin-ratio check --
  // it can ONLY be caught by the non-Latin glyph counter (regression guard for
  // the missing /g flag on NON_LATIN, which made that counter dead code).
  assert.strictEqual(srv.isLikelyEnglish("这是一个关于人工智能监管的测试文本内容"), false);
  assert.strictEqual(srv.isLikelyEnglish("Это новый закон об искусственном интеллекте в Европейском союзе"), false);
  // The heuristic is deliberately permissive: accented / Latin-script text is
  // NOT rejected, so European-language items can still get through. Documented
  // behaviour, asserted so a future "tightening" is a conscious decision.
  assert.strictEqual(srv.isLikelyEnglish("Sanci\u00f3n de la Comisi\u00f3n Europea sobre la ley"), true);
});

test("overlap computes shared token count and Jaccard score", () => {
  const a = new Set(["ai", "act", "eu"]);
  const b = new Set(["ai", "act"]);
  const { shared, score } = srv.overlap(a, b);
  assert.strictEqual(shared, 2);
  assert.ok(score > 0 && score <= 1, "Jaccard score in (0,1]");
});

test("bestMatch returns the best-matching record from an index", () => {
  const index = [{
    tokens: new Set(["ai", "act", "eu", "compliance"]),
    strong: new Set(["ai act"]),
    title: "EU AI Act",
  }];
  const itemTokens = new Set(["ai", "act"]);
  const itemStrong = new Set(["ai act"]);
  const best = srv.bestMatch(itemTokens, itemStrong, index);
  assert.ok(best, "expected a match");
  assert.strictEqual(best.title, "EU AI Act");
});

test("detectKnowledgeCategory returns a category key", () => {
  const cat = srv.detectKnowledgeCategory("New EU AI Act compliance deadline", "regulation");
  assert.strictEqual(typeof cat, "string");
  assert.ok(cat.length > 0);
});

test("looksLikeJobPosting drops recruitment noise, keeps real news", () => {
  assert.strictEqual(srv.looksLikeJobPosting("Machine Learning Intern — Apply Now"), true);
  assert.strictEqual(srv.looksLikeJobPosting("EU AI Act enters into force"), false);
  assert.strictEqual(srv.looksLikeJobPosting("We are seeking public comment on the draft bill"), false);
  // word-boundary: should NOT match 'internet'/'internal'
  assert.strictEqual(srv.looksLikeJobPosting("Internet regulator issued a ruling"), false);
  assert.strictEqual(srv.looksLikeJobPosting("Internal review found enforcement gaps"), false);
});

test("classifyItem drops job postings and keeps substantive AI-policy news", () => {
  const source = { id: "s1", domain: "example.com", name: "Reuters", category: "regulation" };
  const news = {
    title: "EU AI Act updated with new compliance deadline",
    description: "The European Commission fined a company under the AI Act for breaches.",
    url: "https://example.com/news/1",
    sourceName: "Reuters",
    publishedAt: new Date().toISOString(),
  };
  const job = {
    title: "Machine Learning Intern — Applications open",
    description: "Apply now for our research internship programme.",
    url: "https://example.com/jobs/1",
    sourceName: "Careers",
    publishedAt: new Date().toISOString(),
  };
  // NB: the third parameter is the CORPUS INDEX (array of existing records),
  // not a positional counter. classifyItem only proposes an item when it can
  // anchor it to an existing record via bestMatch.
  const index = [{
    dataset: "knowledge",
    recordId: "eu-ai-act",
    title: "EU AI Act",
    tokens: new Set(["eu", "ai", "act", "compliance", "deadline", "european", "commission"]),
    strong: new Set(["ai act"]),
  }];
  const kept = srv.classifyItem(source, news, index);
  const dropped = srv.classifyItem(source, job, index);
  assert.ok(kept, "substantive news should produce a proposal");
  assert.strictEqual(kept.status, "pending");
  assert.strictEqual(kept.matchedRecord.recordId, "eu-ai-act");
  assert.strictEqual(dropped, null, "job posting should be dropped before the model runs");
});

test("extractJson parses raw, fenced, and prose-wrapped JSON", () => {
  assert.deepStrictEqual(srv.extractJson('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(srv.extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepStrictEqual(srv.extractJson('Here is the result: {"a":3} done.'), { a: 3 });
  assert.strictEqual(srv.extractJson("not json at all"), undefined);
});

test("scanBudget / scanBudgetRemaining report usage within the daily cap", () => {
  const b = srv.scanBudget();
  assert.strictEqual(typeof b.used, "number");
  assert.strictEqual(b.day, new Date().toISOString().slice(0, 10));
  const remaining = srv.scanBudgetRemaining();
  assert.ok(remaining >= 0, "remaining must not be negative");
  assert.ok(remaining <= srv.config.SCAN_DAILY_CALL_BUDGET, "remaining cannot exceed the daily cap");
});

test("paceScanModelCall reserves spaced slots (global pacing)", async () => {
  const a = Date.now();
  await srv.paceScanModelCall();
  await srv.paceScanModelCall();
  const elapsed = Date.now() - a;
  // Two calls back-to-back must be separated by >= the configured gap (50ms in
  // this test process; 4000ms in production). Allow a small scheduler slack.
  assert.ok(elapsed >= 40, `expected >= 40ms between calls, got ${elapsed}ms`);
});

test("msUntilNextWallClockInZone lands in the future and within 24h", () => {
  const ms = eng.msUntilNextWallClockInZone("America/Los_Angeles", 0, 5);
  assert.ok(ms > 0, "must be a future instant");
  assert.ok(ms < 24 * 3600 * 1000, "must be within 24h");
});

test("cooldownFrom429: Retry-After wins; daily cap waits for midnight PT; else 60m", () => {
  // NB: cooldownFrom429(resp, txt) reads the body from its SECOND argument --
  // resp.text() is never called -- so the body must be passed as `txt`.
  const mk = (retryAfter) => ({ headers: { get: (h) => (h.toLowerCase() === "retry-after" ? retryAfter : null) } });

  // 1. Retry-After header takes precedence and is converted seconds -> ms.
  assert.strictEqual(eng.cooldownFrom429(mk("2"), "free-models-per-day exceeded"), 2000);

  // 2. Daily-cap wording (no header) -> wait until just after midnight PT.
  //    Compare against a freshly computed target rather than a magic number,
  //    so the test does not go flaky depending on the hour it runs.
  const daily = eng.cooldownFrom429(mk(""), "free-models-per-day exceeded");
  const expected = eng.msUntilNextWallClockInZone("America/Los_Angeles", 0, 5);
  assert.ok(Math.abs(daily - expected) < 2000, `expected ~${expected}ms, got ${daily}ms`);
  assert.ok(daily > 0 && daily <= 24 * 3600 * 1000, "cooldown must be inside a 24h window");
  // 'per day' / 'TPD' phrasing must hit the same branch.
  assert.ok(Math.abs(eng.cooldownFrom429(mk(""), "rate limit exceeded: 50 per day") - expected) < 2000);

  // 3. Generic 429 with no header and no daily wording -> flat 60 minutes.
  assert.strictEqual(eng.cooldownFrom429(mk(""), "rate limited"), 3600000);
});
