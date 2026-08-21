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
  assert.strictEqual(dropped.dropped, true, "job posting should be dropped before the model runs");
  assert.strictEqual(dropped.reason, "job-posting");
});

test("extractJson parses raw, fenced, and prose-wrapped JSON", () => {
  assert.deepStrictEqual(srv.extractJson('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(srv.extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepStrictEqual(srv.extractJson('Here is the result: {"a":3} done.'), { a: 3 });
  assert.strictEqual(srv.extractJson("not json at all"), undefined);
});

test("splitSentences keeps decimal numbers intact (e.g. 22.3 not 3)", () => {
  // Regression guard for the bug where "22.3 Trillion Won Investment" was split
  // on the decimal point into a dropped "22" fragment and a "3 Trillion Won"
  // sentence, silently halving/garbling the figure in report output.
  const text =
    "MiHoYo Declares Full-Stack AI Ambition With 22.3 Trillion Won Investment " +
    "Chinese game giant aims to build self-optimizing AI system, co-founder says the move is strategic.";
  const sentences = srv.splitSentences(text);
  assert.ok(sentences.length >= 1, "expected at least one sentence");
  const joined = sentences.join(" ");
  assert.ok(joined.includes("22.3"), `decimal must survive, got: ${joined}`);
  // A standalone "3 Trillion" (i.e. with the "22." dropped) must NOT appear.
  // Strip the correctly-preserved "22.3" first so we don't trip on the ".3"
  // boundary inside "22.3 Trillion".
  const withoutPreserved = joined.replace(/22\.3/g, "");
  assert.ok(!/3\s+Trillion/.test(withoutPreserved), `must not read as '3 Trillion', got: ${joined}`);
});

test("splitSentences preserves decimals and abbreviations across sentences", () => {
  const text =
    "The U.S. firm reported 1.5 billion in revenue. Growth was 0.9% vs. last year, e.g. stronger in Q3.";
  const sentences = srv.splitSentences(text);
  assert.ok(sentences.length >= 1, "expected at least one sentence");
  const joined = sentences.join(" | ");
  assert.ok(joined.includes("1.5 billion"), `1.5 billion must survive, got: ${joined}`);
  assert.ok(joined.includes("0.9%"), `0.9% must survive, got: ${joined}`);
  assert.ok(joined.includes("U.S."), `U.S. abbreviation must survive, got: ${joined}`);
});

test("classifyItem drops items from a non-English-declared source (B)", () => {
  const enSource = { id: "s1", domain: "example.com", name: "Reuters", category: "regulation", language: "en" };
  const frSource = { id: "s2", domain: "example.fr", name: "Le Monde", category: "regulation", language: "fr" };
  const news = {
    title: "EU AI Act updated with new compliance deadline",
    description: "The European Commission fined a company under the AI Act for breaches.",
    url: "https://example.com/news/1",
    sourceName: "Reuters",
    publishedAt: new Date().toISOString(),
  };
  const index = [{
    dataset: "knowledge",
    recordId: "eu-ai-act",
    title: "EU AI Act",
    tokens: new Set(["eu", "ai", "act", "compliance", "deadline", "european", "commission"]),
    strong: new Set(["ai act"]),
  }];
  // English-declared source keeps the substantive news.
  assert.ok(srv.classifyItem(enSource, news, index), "English source should be proposed");
  // Non-English-declared source is dropped by the whitelist gate before any
  // language heuristic on the text runs.
  const frDrop = srv.classifyItem(frSource, news, index);
  assert.strictEqual(frDrop.dropped, true, "non-English source must be dropped");
  assert.strictEqual(frDrop.reason, "non-english-source");
});

test("classifyItem reports a reason for every drop path", () => {
  const regSource = { id: "s1", domain: "example.com", name: "Reuters", category: "regulation" };
  const index = [];
  const cases = [
    // no AI-policy anchor and not a strong reg/academic hit -> no-anchor
    [{ title: "Local bakery opens new branch", description: "A neighbourhood cafe expanded.", url: "https://x/1" }, "no-anchor"],
    // non-English text -> non-english
    [{ title: "人工智能监管新规出台", description: "这是关于人工智能监管的测试文本内容。", url: "https://x/2" }, "non-english"],
    // too short -> too-short
    [{ title: "AI", description: "", url: "https://x/3" }, "too-short"],
  ];
  for (const [item, reason] of cases) {
    const r = srv.classifyItem(regSource, item, index);
    assert.strictEqual(r.dropped, true, `expected drop for: ${item.title}`);
    assert.strictEqual(r.reason, reason, `expected reason ${reason} for: ${item.title}`);
    assert.ok(r.url && r.source, "dropped item should carry audit metadata");
  }
});

test("proposalLanguageOk purges non-English, keeps English (C)", () => {
  const english = { title: "EU AI Act sets new compliance rules", snippet: "The European Commission published guidance on the AI Act." };
  const cjk = { title: "人工智能监管新规出台", snippet: "这是关于人工智能监管的测试文本内容。" };
  const cyrillic = { title: "Новый закон об искусственном интеллекте", snippet: "Это новый закон об искусственном интеллекте в Европейском союзе." };
  const thin = { title: "AI", snippet: "" }; // too short to judge -> kept
  assert.strictEqual(srv.proposalLanguageOk(english), true, "English proposal must be kept");
  assert.strictEqual(srv.proposalLanguageOk(cjk), false, "CJK proposal must be purged");
  assert.strictEqual(srv.proposalLanguageOk(cyrillic), false, "Cyrillic proposal must be purged");
  assert.strictEqual(srv.proposalLanguageOk(thin), true, "thin-text proposal must be kept (judged on enrichment)");
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

test("stripHtml removes markup even when angle brackets are HTML-entity-encoded", () => {
  // Google News RSS delivers <description> with encoded markup like
  // &lt;a href=…&gt;Headline&lt;/a&gt;. The previous implementation stripped
  // tags *before* decoding entities, so the encoded brackets survived and
  // leaked into the UI as literal "<a…". Now decode must run first.
  const encoded = '&lt;a href="https://example.com/x" target="_blank"&gt;Headline text&lt;/a&gt;&nbsp;&lt;font color="#6f6f6f"&gt;Source&lt;/font&gt;';
  const out = srv.stripHtml(encoded);
  assert.ok(!out.includes("<"), `expected no literal tag in output, got: ${out}`);
  assert.ok(!out.includes("href"), `expected link attributes removed, got: ${out}`);
  assert.strictEqual(out, "Headline text Source");

  // Raw (un-encoded) markup still stripped, and entities like &amp; resolve.
  assert.strictEqual(srv.stripHtml("<b>AT&amp;T</b> wins"), "AT&T wins");
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

test("resolver chains: News enrichment and scanner use independent chains (no starvation)", async () => {
  // The two chain sets must be distinct objects so contention is impossible.
  assert.notStrictEqual(srv.newsChains, srv.scannerChains);

  // Seed the shared URL cache so resolveGoogleNewsUrl returns instantly without
  // touching any search engine (no network in this pure test).
  const gUrl = "https://news.google.com/rss/articles/ISOLATION_TEST_" + Date.now();
  const real = "https://real-publisher.example.com/article";
  srv.resolvedUrlMap.set(gUrl, real);

  // Resolve on the NEWS chain only.
  const beforeScannerDdg = srv.scannerChains.lastDdg;
  const got = await srv.resolveGoogleNewsUrl(gUrl, "Some headline", "example.com", srv.newsChains);
  assert.strictEqual(got, real);
  // The scanner's resolver chain must be completely untouched by a news resolution.
  assert.strictEqual(srv.scannerChains.lastDdg, beforeScannerDdg);
  assert.strictEqual(srv.scannerChains.lastDdg, 0);
  // And the news chain itself advanced (it performed the resolution slot bookkeeping).
  assert.ok(typeof srv.newsChains.lastDdg === "number");
});

test("enrichTopArticles: returns same array, never throws/hangs on unresolvable articles", async () => {
  // These articles have no real URL, so fetchArticleSubhead fails fast without
  // any network dependency. The function must (a) return the SAME array
  // reference (so background cache-warming mutates the cached objects), and
  // (b) complete quickly without throwing — the timeout cap must not hang.
  const arts = [
    { title: "A", url: "not-a-real-url", description: "desc a" },
    { title: "B", url: "also-not-real", description: "desc b" },
  ];
  const start = Date.now();
  let threw = false;
  let out;
  try {
    out = await srv.enrichTopArticles(arts, 6, 5, 2000);
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, "enrichTopArticles should never throw");
  assert.strictEqual(out, arts, "returns the same array reference for cache warming");
  assert.strictEqual(out[0].subhead, undefined, "no subhead set for unresolvable article");
  assert.ok(Date.now() - start < 5000, "completes within the timeout cap");
});

test("searchSubhead returns clean text or null and never throws when unconfigured", async () => {
  // With no search provider configured the chain rejects; searchSubhead must
  // swallow it and return null (so the caller falls back to keyless extraction)
  // — never throw.
  let threw = false;
  let out;
  try {
    out = await srv.searchSubhead("Tencent Cloud named a Leader in Omdia Market Radar");
  } catch (e) {
    threw = true;
  }
  assert.strictEqual(threw, false, "searchSubhead must not throw when search is unconfigured");
  assert.ok(out === null || (typeof out === "string" && out.length >= 30), `expected null or clean text, got: ${out}`);
  assert.ok(!srv.isGoogleNewsBoilerplate(out || ""), "must never surface the Google News boilerplate");
});

test("isGoogleNewsBoilerplate / pickSubheadCandidate reject the dispatcher boilerplate", () => {
  const boilerplate =
    "Comprehensive up-to-date news coverage, aggregated from sources all over the world by Google News.";
  assert.strictEqual(srv.isGoogleNewsBoilerplate(boilerplate), true);
  assert.strictEqual(srv.isGoogleNewsBoilerplate("  " + boilerplate + "  "), true);
  assert.strictEqual(
    srv.isGoogleNewsBoilerplate("Tencent Cloud has been named a Leader in the Omdia Market Radar"),
    false
  );

  // pickSubheadCandidate must skip the boilerplate and prefer a real lead.
  const real =
    "Tencent Cloud, the cloud business of Tencent, has been named a Leader in the Omdia Market Radar.";
  assert.strictEqual(srv.pickSubheadCandidate(boilerplate, real), real);
  assert.strictEqual(srv.pickSubheadCandidate(boilerplate), null, "only-boilerplate input yields null");
  assert.strictEqual(srv.pickSubheadCandidate(""), null, "empty input yields null");
});

test("fetchArticleSubhead never returns the Google News boilerplate", async () => {
  // Tavily unconfigured + an unresolvable URL => the fallback path runs and must
  // return null (not the boilerplate) rather than leaking the dispatcher line.
  const out = await srv.fetchArticleSubhead({ title: "Some headline", url: "not-a-real-url" });
  assert.ok(out === null || typeof out === "string", "returns null or a string");
  assert.ok(!srv.isGoogleNewsBoilerplate(out || ""), "must never return the Google News boilerplate");
});

// ===== Q&A citation gate + [S#] recovery nudge (composite a + b3) =====

test("evaluateCitationGate: one citation passes, zero citations fails", () => {
  const evidence = [
    { id: "A1", sourceType: "application" },
    { id: "A2", sourceType: "application" },
  ];
  const one = eng.evaluateCitationGate("This is grounded in [A1] clearly.", evidence);
  assert.strictEqual(one.pass, true, "answer with >=1 citation should pass (no forced extractive list)");
  assert.strictEqual(one.citationCount, 1);
  const none = eng.evaluateCitationGate("No sources cited at all here, just prose.", evidence);
  assert.strictEqual(none.pass, false, "wholly uncited answer must fail (extractive safety net)");
  assert.strictEqual(none.citationCount, 0);
});

test("evaluateCitationGate: [S#] attached but missing still passes when another source is cited", () => {
  const evidence = [
    { id: "S1", sourceType: "user" },
    { id: "A1", sourceType: "application" },
  ];
  const res = eng.evaluateCitationGate("Grounded in [A1] from the knowledge base, but the attached user article is not referenced here.", evidence);
  assert.strictEqual(res.pass, true, "cited [A1] => reasoned answer passes");
  assert.strictEqual(res.citedUser, false, "attached [S#] was not cited (nudge + client notice would handle it)");
});

test("nudgeForUserSources: recovers an attached [S#] when the model omits it", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "Now the saved article [S1] is reflected as requested, and this response is long enough to satisfy the minimum length requirement for acceptance." } }],
    }),
  });
  try {
    const evidence = [{ id: "S1", sourceType: "user" }];
    const out = await eng.nudgeForUserSources([{ role: "user", content: "q" }], "Answer without [S1].", evidence, ["S1"]);
    assert.ok(out.includes("[S1]"), "nudge should recover the attached [S#]");
  } finally {
    globalThis.fetch = original;
  }
});

test("nudgeForUserSources: keeps original answer when nudge does not recover [S#]", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: "Still no citation of the saved article appears here, but this response is long enough to clear the minimum length guard and should not be accepted." } }],
    }),
  });
  try {
    const evidence = [{ id: "S1", sourceType: "user" }];
    const baseline = "Answer without [S1].";
    const out = await eng.nudgeForUserSources([{ role: "user", content: "q" }], baseline, evidence, ["S1"]);
    assert.strictEqual(out, baseline, "nudge that fails to recover [S#] must return the original answer");
  } finally {
    globalThis.fetch = original;
  }
});

test("nudgeForUserSources: network failure is best-effort (returns original answer)", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("network down"); };
  try {
    const evidence = [{ id: "S1", sourceType: "user" }];
    const baseline = "Answer without [S1].";
    const out = await eng.nudgeForUserSources([{ role: "user", content: "q" }], baseline, evidence, ["S1"]);
    assert.strictEqual(out, baseline, "nudge failure must return the original answer");
  } finally {
    globalThis.fetch = original;
  }
});

// --- Bing News RSS fallback (Google-News-blocked path) ---

test("unwrapBingNewsLink unwraps Bing apiclick redirector to publisher URL", () => {
  const redirector = "http://www.bing.com/news/apiclick.aspx?ref=FexRss&aid=&tid=abc&url=https%3a%2f%2fwww.lawgazette.co.uk%2fnews%2feu-ai-act%2f5127695.article&c=1&mkt=en-gb";
  assert.strictEqual(
    srv.unwrapBingNewsLink(redirector),
    "https://www.lawgazette.co.uk/news/eu-ai-act/5127695.article"
  );
});

test("unwrapBingNewsLink passes through non-Bing and non-apiclick URLs", () => {
  assert.strictEqual(srv.unwrapBingNewsLink("https://example.com/story"), "https://example.com/story");
  assert.strictEqual(srv.unwrapBingNewsLink("https://www.bing.com/news/search?q=ai&format=RSS"), "https://www.bing.com/news/search?q=ai&format=RSS");
  // apiclick with no url param must fall through unchanged (never drop an item)
  assert.strictEqual(srv.unwrapBingNewsLink("http://www.bing.com/news/apiclick.aspx?ref=x"), "http://www.bing.com/news/apiclick.aspx?ref=x");
  assert.strictEqual(srv.unwrapBingNewsLink(""), "");
});

test("isBingRedirector detects only apiclick links", () => {
  assert.strictEqual(srv.isBingRedirector("https://www.bing.com/news/apiclick.aspx?url=https%3a%2f%2fx.com"), true);
  assert.strictEqual(srv.isBingRedirector("https://bing.com/news/apiclick.aspx"), true);
  assert.strictEqual(srv.isBingRedirector("https://www.bing.com/news/search?q=ai&format=RSS"), false);
  assert.strictEqual(srv.isBingRedirector("https://example.com/news/apiclick.aspx"), false);
});

test("parseBingNewsRss extracts namespaced source, unwraps links, excludes blocked domains", () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:News="http://www.example.com/news">
  <channel>
    <item>
      <title>EU AI Act deadline nears</title>
      <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=abc&amp;url=https%3a%2f%2fwww.lawgazette.co.uk%2fnews%2feu-ai-act%2f5127695.article&amp;c=1&amp;mkt=en-gb</link>
      <description>Regulators finalize compliance rules.</description>
      <pubDate>Mon, 17 Aug 2026 06:43:00 GMT</pubDate>
      <News:Source>The Law Society Gazette</News:Source>
    </item>
    <item>
      <title>AI misuse reports surge</title>
      <link>https://en.wikipedia.org/wiki/AI</link>
      <description>Should be excluded by domain.</description>
      <pubDate>Mon, 17 Aug 2026 05:00:00 GMT</pubDate>
      <News:Source>Wikipedia</News:Source>
    </item>
    <item>
      <title>No link item</title>
      <description>Dropped for missing link.</description>
      <News:Source>Somewhere</News:Source>
    </item>
  </channel>
</rss>`;
  const out = srv.parseBingNewsRss(xml, "AI Regulation", "AI regulation", 20);
  assert.strictEqual(out.length, 1, "only the non-excluded item with a link should survive");
  const article = out[0];
  assert.strictEqual(article.title, "EU AI Act deadline nears");
  assert.strictEqual(article.sourceName, "The Law Society Gazette");
  assert.strictEqual(article.url, "https://www.lawgazette.co.uk/news/eu-ai-act/5127695.article");
  assert.strictEqual(article.topicCategory, "AI Regulation");
  assert.strictEqual(article.publishedAt, "2026-08-17T06:43:00.000Z");
});

test("parseBingNewsRss falls back to plain <source> when <News:Source> absent", () => {
  const xml = `<rss version="2.0"><channel><item>
    <title>AI policy shift</title>
    <link>https://www.computing.co.uk/news/ai-policy</link>
    <description>Plain source fallback.</description>
    <source>Computing</source>
  </item></channel></rss>`;
  const out = srv.parseBingNewsRss(xml, "AI Regulation", "AI regulation", 10);
  assert.strictEqual(out.length, 1);
  assert.strictEqual(out[0].sourceName, "Computing");
  assert.strictEqual(out[0].url, "https://www.computing.co.uk/news/ai-policy");
});
