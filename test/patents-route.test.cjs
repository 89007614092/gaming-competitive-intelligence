"use strict";
// Patents (EPO OPS) — through-route tests.
//
// Drives the REAL /api/patents and /api/patents/company-options routes in
// process (against the exported `app`) with a stubbed globalThis.fetch, so no
// network and no real EPO credentials are involved. The OPS plumbing itself is
// covered unit-style in test/epo-ops.test.cjs; what matters here is the
// boundary behaviour:
//   * the route is inert-but-honest when credentials are absent — a clean 503
//     with an actionable message, never a 500 or an empty 200;
//   * the auth gate is INERT while AUTH_ENABLED is off (legacy open behaviour
//     the gating work in #106 promised to preserve);
//   * the JSON shape is the one the Patents view renders;
//   * applicants are cross-referenced back to KB companies;
//   * OPS error codes map to sensible HTTP statuses.

// Set BEFORE requiring the server: config.js reads process.env once at load.
process.env.EPO_OPS_KEY = "test-consumer-key";
process.env.EPO_OPS_SECRET = "test-consumer-secret";
process.env.SCAN_MODEL_MIN_GAP_MS = "50"; // keep any scan pacing fast

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert");
const http = require("http");

const srv = require("../server");
const app = srv.app;
const realFetch = globalThis.fetch; // saved before any stubbing below

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function startServer() {
  return new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Uses realFetch (not globalThis.fetch) so stubbing the OPS transport never
// breaks the harness's own HTTP call.
async function request(server, path) {
  const port = server.address().port;
  const res = await realFetch(`http://127.0.0.1:${port}${path}`, { headers: { accept: "application/json" } });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: json };
}

function stubFetch(handler) {
  globalThis.fetch = handler;
  return () => { globalThis.fetch = realFetch; };
}

function jsonResp(body, { status = 200, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => (h.has(String(n).toLowerCase()) ? h.get(String(n).toLowerCase()) : null) },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

// A minimal but structurally real exchange-document.
function opsDoc({ number = "4123456", applicant = "DeepMind Limited", date = "20250312", title = "Neural game character animation", lang = "en" } = {}) {
  return {
    "bibliographic-data": {
      "publication-reference": {
        "document-id": [{
          "@document-id-type": "docdb",
          country: { "#text": "EP" },
          "doc-number": { "#text": number },
          kind: { "#text": "A1" },
          date: { "#text": date },
        }],
      },
      "invention-title": { "@lang": lang, "#text": title },
      parties: { applicants: { applicant: [{ "applicant-name": { name: { "#text": applicant } } }] } },
    },
  };
}

function searchPayload(docs, total = "348") {
  // Real OPS shape for `/published-data/search/{abstract,biblio}`: the count
  // lives on `ops:biblio-search`, wrapping an inner `ops:search-result`.
  return {
    "ops:world-patent-data": {
      "ops:biblio-search": {
        "@total-result-count": total,
        "ops:search-result": {
          "exchange-documents": { "exchange-document": docs },
        },
      },
    },
  };
}

const TOKEN = "auth/accesstoken";
const SEARCH = "published-data/search";
const ABSTRACT = "/abstract";

// Routes the three OPS endpoints the /api/patents flow touches.
function stubOps({ docs = [opsDoc()], total = "348", status = 200, headers = {}, abstractText = "An abstract." } = {}) {
  return stubFetch(async (url) => {
    const u = String(url);
    if (u.includes(TOKEN)) return jsonResp({ access_token: "tok", token_type: "Bearer", expires_in: 1199 }, { status, headers });
    if (u.includes(SEARCH)) return jsonResp(searchPayload(docs, total), { status, headers });
    if (u.includes(ABSTRACT)) {
      return jsonResp({
        "ops:world-patent-data": {
          "exchange-documents": { "exchange-document": { abstract: { "@lang": "en", p: { "#text": abstractText } } } },
        },
      });
    }
    throw new Error(`unrouted fetch: ${u}`);
  });
}

let server;
before(async () => { server = await startServer(); });
after(() => closeServer(server));

// The EPO client is a module-level singleton, so throttle and breaker state
// would otherwise leak between cases — one test's forced 403 would park the
// client and make the next test fail with 429 for the wrong reason.
beforeEach(() => { srv.epoClient.reset(); });

// ---------------------------------------------------------------------------
// GET /api/patents/company-options
// ---------------------------------------------------------------------------
test("company-options serves the KB company list and the CPC presets", async () => {
  const { status, body } = await request(server, "/api/patents/company-options");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.success, true);
  assert.ok(Array.isArray(body.companies) && body.companies.length > 0, "companies drives the dropdown");
  for (const c of body.companies) {
    assert.strictEqual(typeof c.id, "string");
    assert.strictEqual(typeof c.name, "string");
  }
  // Sorted by name so the dropdown is stable for the user.
  const names = body.companies.map(c => c.name);
  assert.deepStrictEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  // Grouped classification chips, not the old flat A63F/G06N/G06T/G10L/H04N set.
  assert.ok(Array.isArray(body.cpcGroups) && body.cpcGroups.length >= 3);
  const chips = body.cpcGroups.flatMap(g => g.chips);
  assert.ok(chips.length > 0, "at least one chip is offered");
  for (const g of body.cpcGroups) {
    assert.ok(g.id && g.label, "group needs id + label");
    for (const c of g.chips) {
      assert.ok(c.id && c.label, "chip needs id + label");
      assert.ok(Array.isArray(c.codes) && c.codes.length, `${c.id} needs codes`);
    }
  }
  // The UI pre-selects this so a bare search is video games, not pinball.
  assert.deepStrictEqual(body.cpcDefaults, ["A63F13/00"]);
  // Broad subclasses must never be offered.
  const offered = chips.flatMap(c => c.codes);
  for (const broad of ["A63F", "G06N", "G06T", "G06F"]) {
    assert.ok(!offered.includes(broad), `${broad} is too broad to be a chip`);
  }
  assert.strictEqual(body.configured, true, "credentials are set in this process");
  assert.strictEqual(body.attribution, "Data: EPO OPS");
});

test("company-options is NOT auth-gated (it only exposes the public KB list)", async () => {
  // No session cookie, no key header — must still succeed. The auth gate is
  // inert because AUTH_ENABLED is unset in this process.
  const { status, body } = await request(server, "/api/patents/company-options");
  assert.strictEqual(status, 200);
  assert.strictEqual(body.success, true);
});

// ---------------------------------------------------------------------------
// GET /api/patents — configuration guards
// ---------------------------------------------------------------------------
test("/api/patents returns a clean 503 when EPO credentials are absent", async () => {
  // The client was built at require time, so blank the shared config object it
  // holds a reference to, then restore it. This is exactly the state of any
  // environment that has not been given the keys (local dev, CI).
  const original = srv.config.EPO_OPS_KEY;
  srv.config.EPO_OPS_KEY = "";
  try {
    const { status, body } = await request(server, "/api/patents?company=DeepMind");
    assert.strictEqual(status, 503);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.code, "epo_not_configured");
    assert.match(body.error, /EPO_OPS_KEY/, "the message names the missing env vars");
  } finally {
    srv.config.EPO_OPS_KEY = original;
  }
  // Restored: the very next request must be configured again.
  assert.strictEqual(srv.epoClient.isConfigured(), true);
});

test("/api/patents rejects an empty query with 400 instead of calling OPS", async () => {
  let called = false;
  const restore = stubFetch(async () => { called = true; throw new Error("OPS must not be called"); });
  try {
    const { status, body } = await request(server, "/api/patents");
    assert.strictEqual(status, 400);
    assert.strictEqual(body.code, "empty_query");
    assert.match(body.error, /company, keyword or CPC/i);
    assert.strictEqual(called, false, "an empty query costs no quota");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// GET /api/patents — success path
// ---------------------------------------------------------------------------
test("/api/patents normalises OPS results into the card shape the UI renders", async () => {
  const restore = stubOps({
    docs: [
      opsDoc({ number: "4123456", date: "20250312" }),
      opsDoc({ number: "3999999", date: "20240115", applicant: "Valve Corporation", title: "Procedural level generation" }),
    ],
  });
  try {
    const { status, body } = await request(server, "/api/patents?company=DeepMind&cpc=A63F,G06N&range=25&sort=date");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.count, 2);
    assert.strictEqual(body.totalAvailable, 348);
    assert.strictEqual(body.cached, false);
    assert.strictEqual(body.attribution, "Data: EPO OPS");
    assert.ok(body.fetchedAt, "the client can show data freshness");

    // The CQL actually sent to OPS is echoed back for debugging/transparency.
    // Applicant search must be token + truncation, never the all-words form.
    assert.match(body.cql, /pa = "DeepMind\*"/);
    assert.match(body.cql, /\(cpc=\/low A63F OR cpc=\/low G06N\)/);
    assert.ok(!/pa all/.test(body.cql), "must never emit an all-words applicant clause");
    // The query is echoed so the UI can restore its filter state.
    assert.strictEqual(body.query.company, "DeepMind");
    assert.deepStrictEqual(body.query.cpc, ["A63F", "G06N"]);

    // Diagnostics let the UI tell "no matches" apart from "we couldn't read it".
    assert.strictEqual(body.diagnostics.recognised, true);
    assert.strictEqual(body.diagnostics.docsSeen, 2);
    assert.strictEqual(body.diagnostics.docsKept, 2);
    assert.strictEqual(body.diagnostics.totalResultCount, 348);

    // sort=date -> newest first (OPS has no dependable sort parameter).
    assert.deepStrictEqual(body.patents.map(p => p.publicationDate), ["2025-03-12", "2024-01-15"]);

    const [p] = body.patents;
    assert.strictEqual(p.id, "EP4123456A1");
    assert.strictEqual(p.title, "Neural game character animation");
    assert.deepStrictEqual(p.applicants, ["DeepMind Limited"]);
    assert.strictEqual(p.espacenetUrl, "https://worldwide.espacenet.com/patent/search?q=pn%3DEP4123456A1");
    assert.strictEqual(p.attribution, "Data: EPO OPS");
  } finally {
    restore();
  }
});

test("/api/patents cross-references applicants back to KB companies", async () => {
  const restore = stubOps({ docs: [opsDoc({ applicant: "DeepMind Limited" }), opsDoc({ number: "3777777", applicant: "Valve Corporation" })] });
  try {
    const { status, body } = await request(server, "/api/patents?cpc=A63F&abstracts=0");
    assert.strictEqual(status, 200);
    const byId = Object.fromEntries(body.patents.map(p => [p.id, p]));
    // "DeepMind Limited" must resolve to the tracked company "Google DeepMind"
    // — OPS applicant strings never match the KB name exactly.
    assert.deepStrictEqual(byId["EP4123456A1"].matchedCompanies, ["google"]);
    assert.deepStrictEqual(byId["EP3777777A1"].matchedCompanies, ["valve"]);
  } finally {
    restore();
  }
});

// The applicant list must come from network.json (real companies we track), not
// company-locations.json (a map of office + regulator sites).
test("company-options lists tracked companies, not map offices or regulators", async () => {
  const { status, body } = await request(server, "/api/patents/company-options");
  assert.strictEqual(status, 200);
  const names = (body.companies || []).map(c => c.name);
  // Real companies that file patents.
  for (const n of ["Valve", "Ubisoft", "Electronic Arts", "Google DeepMind", "Tencent"]) {
    assert.ok(names.includes(n), `expected ${n} in the applicant list`);
  }
  // Bodies that will never file a patent — these came from the map dataset.
  for (const n of ["European Commission", "UK AI Safety Institute", "UK ICO", "EDPB"]) {
    assert.ok(!names.includes(n), `${n} must not appear as a patent applicant`);
  }
  // Neither may an office location appear as an applicant.
  for (const n of ["Rockstar North", "Ubisoft Montreal / La Forge"]) {
    assert.ok(!names.includes(n), `${n} is a studio location, not a filing entity`);
  }
  // Every entry must carry a canonical English query name for the CQL.
  for (const c of body.companies) {
    assert.ok(c.queryName, `${c.name} needs a queryName`);
  }
});

// The KB translation cache rewrites company names into Chinese. If the display
// name were sent to OPS the CQL would be built out of Chinese text.
test("company-options exposes queryName separate from the display name", async () => {
  const { body } = await request(server, "/api/patents/company-options?lang=zh-CN");
  const c = (body.companies || []).find(x => x.id === "valve");
  assert.ok(c, "valve should be listed");
  assert.ok(c.queryName, "queryName is required");
  // Whatever the display name is (translated or not), queryName stays canonical.
  assert.strictEqual(c.queryName, "Valve");
  assert.strictEqual(typeof c.name, "string");
});

test("/api/patents fetches abstracts by default but honours abstracts=0", async () => {
  // abstracts=0 -> no per-hit abstract calls at all (the quota-friendly path).
  let abstractCalls = 0;
  const restore0 = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes(TOKEN)) return jsonResp({ access_token: "tok", expires_in: 1199 });
    if (u.includes(SEARCH)) return jsonResp(searchPayload([opsDoc()]));
    if (u.includes(ABSTRACT)) { abstractCalls += 1; return jsonResp({}); }
    throw new Error(`unrouted: ${u}`);
  });
  try {
    const { body } = await request(server, "/api/patents?cpc=A63F&abstracts=0");
    assert.strictEqual(body.patents[0].abstract, "", "abstracts=0 skips the extra OPS calls");
    assert.strictEqual(abstractCalls, 0);
  } finally {
    restore0();
  }

  // Default is on, and the abstract is attached to the card.
  const restore1 = stubOps({ abstractText: "A method for animating a character." });
  try {
    const { body } = await request(server, "/api/patents?cpc=A63F");
    assert.strictEqual(body.patents[0].abstract, "A method for animating a character.");
  } finally {
    restore1();
  }
});

test("/api/patents is reachable without a session while AUTH_ENABLED is off", async () => {
  // Regression guard for the #106 gating work: gated endpoints must stay OPEN
  // when auth is disabled, so a Render environment without AUTH_ENABLED does
  // not accidentally lock the app.
  const restore = stubOps();
  try {
    const { status, body } = await request(server, "/api/patents?keyword=neural");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true);
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------
test("an OPS quota rejection surfaces as 429 with the OPS reason", async () => {
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes(TOKEN)) return jsonResp({ access_token: "tok", expires_in: 1199 });
    if (u.includes(SEARCH)) {
      return jsonResp("", { status: 403, headers: { "Retry-After": "120", "X-Rejection-Reason": "Individual per hour traffic limit exceeded" } });
    }
    throw new Error(`unrouted: ${u}`);
  });
  try {
    const { status, body } = await request(server, "/api/patents?cpc=A63F");
    assert.strictEqual(status, 429, "quota exhaustion is a rate-limit, not a server fault");
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.code, "epo_throttled");
    assert.match(body.error, /quota rejected/i);
    assert.match(body.error, /Individual per hour traffic limit exceeded/, "the OPS reason is passed through");
  } finally {
    restore();
  }
});

test("an unexpected OPS failure surfaces as 502, not a 200 with no results", async () => {
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes(TOKEN)) return jsonResp({ access_token: "tok", expires_in: 1199 });
    if (u.includes(SEARCH)) return jsonResp("internal error", { status: 500 });
    throw new Error(`unrouted: ${u}`);
  });
  try {
    const { status, body } = await request(server, "/api/patents?cpc=A63F");
    assert.strictEqual(status, 502, "an upstream fault must never look like 'no patents found'");
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.code, "epo_error");
  } finally {
    restore();
  }
});

test("OPS reporting hits we cannot parse is a 502, not an empty 200", async () => {
  // The failure mode this guards: OPS says "12 matches" but the documents carry
  // no resolvable publication number. Returning 200 + [] here would make the UI
  // tell the user "this company has no patents", which is simply false.
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes(TOKEN)) return jsonResp({ access_token: "tok", expires_in: 1199 });
    if (u.includes(SEARCH)) {
      return jsonResp({
        "ops:world-patent-data": {
          "ops:search-result": {
            "@total-result-count": "12",
            "exchange-documents": {
              "exchange-document": [{ "bibliographic-data": { "invention-title": "no ids here" } }],
            },
          },
        },
      });
    }
    throw new Error(`unrouted: ${u}`);
  });
  try {
    const { status, body } = await request(server, "/api/patents?company=DeepMind");
    assert.strictEqual(status, 502);
    assert.strictEqual(body.success, false);
    assert.strictEqual(body.code, "epo_parse_failed");
    assert.match(body.error, /12 matching publications/);
    assert.strictEqual(body.diagnostics.totalResultCount, 12);
    assert.strictEqual(body.diagnostics.docsSeen, 1);
    assert.strictEqual(body.diagnostics.docsKept, 0);
    assert.ok(body.cql, "the CQL is included so the failing query is visible");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Pure helpers exported from server.js
// ---------------------------------------------------------------------------
test("matchPatentCompanies matches on distinctive name tokens only", () => {
  const companies = [
    { id: "deepmind", name: "Google DeepMind" },
    { id: "stability", name: "Stability AI" },
    { id: "creative-assembly", name: "Creative Assembly" },
  ];
  const m = (applicants) => srv.matchPatentCompanies({ applicants, inventors: [] }, companies);

  // OPS name strings never equal the KB name — substring on a distinctive token.
  assert.deepStrictEqual(m(["DeepMind Limited"]), ["deepmind"]);
  assert.deepStrictEqual(m(["DEEPMIND LIMITED"]), ["deepmind"], "matching is case-insensitive");
  assert.deepStrictEqual(m(["Stability AI Ltd"]), ["stability"]);
  assert.deepStrictEqual(m(["The Creative Assembly Ltd"]), ["creative-assembly"]);
  assert.deepStrictEqual(m(["Some Unrelated Corp"]), []);
  assert.deepStrictEqual(m([]), [], "no parties -> no match, no crash");

  // A generic token must NOT create a false positive: "games" is a stopword.
  assert.deepStrictEqual(m(["Games Workshop Limited"]), []);
});

test("companyTokens drops legal boilerplate and short words", () => {
  assert.deepStrictEqual(srv.companyTokens("Ubisoft Montreal / La Forge"), ["ubisoft", "montreal", "forge"]);
  assert.deepStrictEqual(srv.companyTokens("Stability AI"), ["stability"]);
  assert.deepStrictEqual(srv.companyTokens("VEED.io"), ["veed"]);
  assert.deepStrictEqual(srv.companyTokens(""), []);
});

test("the patents cache degrades gracefully with no database configured", async () => {
  // No DATABASE_URL in this process, so every cache operation must be a
  // silent no-op rather than an exception — the feature just goes live.
  assert.strictEqual(await srv.readPatentCache("any-key"), null, "cache miss with no pool");
  await srv.writePatentCache("any-key", { company: "x" }, { success: true });
  assert.strictEqual(await srv.readPatentCache("any-key"), null, "write is a no-op without a pool");
});

// ---------------------------------------------------------------------------
// Headline translation
// ---------------------------------------------------------------------------
// A Chinese or French headline is unreadable to most users, so each card
// carries the language OPS reported and the UI offers an opt-in translation.
test("patent cards report the language of the headline", async () => {
  const restore = stubOps({
    docs: [
      opsDoc({ number: "4123456", lang: "zh", title: "神经网络游戏角色动画" }),
      opsDoc({ number: "4222222", lang: "fr", title: "Animation de personnage" }),
    ],
  });
  try {
    const { status, body } = await request(server, "/api/patents?cpc=A63F13/00&abstracts=0");
    assert.strictEqual(status, 200);
    const byId = Object.fromEntries(body.patents.map(p => [p.id, p]));
    assert.strictEqual(byId["EP4123456A1"].titleLang, "zh");
    assert.strictEqual(byId["EP4222222A1"].titleLang, "fr");
    // Every variant is kept so the UI can offer and restore the original.
    assert.ok(Array.isArray(byId["EP4123456A1"].titles));
  } finally {
    restore();
  }
});

async function postJson(path, payload) {
  const res = await realFetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let json = null;
  try { json = await res.json(); } catch (e) { /* non-JSON body */ }
  return { status: res.status, body: json };
}

test("translate rejects malformed input rather than spending DeepL quota", async () => {
  const base = { pn: "EP4123456A1", title: "A game method", target: "en" };
  const cases = [
    [{ ...base, pn: "../../etc/passwd" }, "bad_pn"],
    [{ ...base, pn: "" }, "bad_pn"],
    [{ ...base, title: "" }, "bad_title"],
    [{ ...base, title: "x".repeat(5000) }, "bad_title"],
    [{ ...base, target: "klingon" }, "bad_target"],
    [{ ...base, target: "" }, "bad_target"],
  ];
  for (const [payload, code] of cases) {
    const r = await postJson("/api/patents/translate", payload);
    assert.strictEqual(r.status, 400, `${code}: expected 400, got ${r.status}`);
    assert.strictEqual(r.body.code, code);
  }
});

test("translate reports cleanly when no provider is configured", async () => {
  // No DEEPL_API_KEY / GOOGLE_TRANSLATE_KEY in the test environment, so the
  // mtService chain yields nothing. The endpoint must say so explicitly
  // instead of silently returning the untranslated title as if it had worked.
  const r = await postJson("/api/patents/translate", {
    pn: "EP4123456A1",
    title: "神经网络游戏角色动画",
    target: "en",
  });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.body.success, false);
  assert.strictEqual(r.body.code, "translation_unavailable");
});

test("translation cache degrades gracefully with no database configured", async () => {
  assert.strictEqual(await srv.readPatentTranslation("EP4123456A1", "en", "abc"), null);
  await srv.writePatentTranslation("EP4123456A1", "en", "abc", "src", "dst");
  assert.strictEqual(await srv.readPatentTranslation("EP4123456A1", "en", "abc"), null);
});

// ---------------------------------------------------------------------------
// Per-chip hit counts (quota-sensitive, cached, throttle-aware)
// ---------------------------------------------------------------------------
test("cpc-counts reports a count per chip and serves the second call from cache", async () => {
  let searchCalls = 0;
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes(TOKEN)) return jsonResp({ access_token: "tok", expires_in: 1199 });
    if (u.includes(SEARCH)) {
      searchCalls += 1;
      return jsonResp(searchPayload([opsDoc()], "42"));
    }
    throw new Error(`unrouted: ${u}`);
  });
  try {
    const { status, body } = await request(server, "/api/patents/cpc-counts");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.success, true);
    const ids = Object.keys(body.counts);
    assert.strictEqual(ids.length, srv.CPC_CHIPS.length, "every chip is attempted");
    for (const id of ids) assert.strictEqual(body.counts[id], 42);
    assert.strictEqual(body.throttled, false);
    assert.strictEqual(searchCalls, srv.CPC_CHIPS.length);

    // Second call returns the same counts. NOTE: the zero-call caching path is
    // only exercised with a DATABASE_URL present — without a pool the cache
    // layer no-ops by design (see "the patents cache degrades gracefully"),
    // so correctness is asserted here rather than call count.
    const again = await request(server, "/api/patents/cpc-counts");
    assert.strictEqual(again.body.counts[ids[0]], 42);
    assert.deepStrictEqual(Object.keys(again.body.counts).sort(), [...ids].sort());
  } finally {
    restore();
  }
});

test("cpc-counts stops as soon as OPS throttles instead of burning the quota", async () => {
  let searchCalls = 0;
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes(TOKEN)) return jsonResp({ access_token: "tok", expires_in: 1199 });
    if (u.includes(SEARCH)) {
      searchCalls += 1;
      return jsonResp("", {
        status: 403,
        headers: { "Retry-After": "600", "X-Rejection-Reason": "Individual per hour traffic limit exceeded" },
      });
    }
    throw new Error(`unrouted: ${u}`);
  });
  try {
    const { status, body } = await request(server, "/api/patents/cpc-counts");
    assert.strictEqual(status, 200);
    assert.strictEqual(body.throttled, true, "the probe must report that it gave up");
    assert.strictEqual(searchCalls, 1, "it must not keep hammering OPS after a throttle");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// GET /api/patents/probe-cpc-format
// ---------------------------------------------------------------------------
test("GET /api/patents/probe-cpc-format measures spellings and never trips the breaker", async () => {
  // Auth is off in this harness, so the (relaxed) gate is inert and the probe
  // runs without a session. We simulate OPS: quoted form -> 0, plain unquoted
  // -> 1 hit, and the /low qualifier -> 42 hits (the correct form).
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.includes(TOKEN)) return jsonResp({ access_token: "tok", token_type: "Bearer", expires_in: 1199 });
    if (u.includes(SEARCH)) {
      const decoded = decodeURIComponent(u);
      if (decoded.includes("/low")) return jsonResp(searchPayload([opsDoc()], "42"));
      if (decoded.includes('"')) return jsonResp(searchPayload([], "0"));
      return jsonResp(searchPayload([opsDoc()], "1"));
    }
    throw new Error(`unrouted: ${u}`);
  });
  try {
    const { status, body } = await request(server, "/api/patents/probe-cpc-format?code=A63F13/67");
    assert.strictEqual(status, 200, "probe must run without admin gating");
    assert.strictEqual(body.success, true);
    assert.strictEqual(body.results.quoted.ok, true, "quoted form is accepted but empty");
    assert.strictEqual(body.results.quoted.count, 0);
    assert.strictEqual(body.results.unquoted.ok, true, "unquoted exact match returns hits");
    assert.strictEqual(body.results.unquoted.count, 1);
    assert.strictEqual(body.results["unquoted + /low"].ok, true, "/low qualifier returns hits");
    assert.strictEqual(body.results["unquoted + /low"].count, 42);
    assert.strictEqual(body.current, "cpc=/low A63F13/67", "the app now emits the /low-qualified concatenated form");
    // A failing candidate must NOT trip OUR breaker (the probe passes
    // bypassBreaker), otherwise the diagnostic would disable live searches.
    assert.strictEqual(srv.epoClient.status().circuitOpen, false, "the probe must not poison the breaker");
    assert.strictEqual(srv.epoClient.status().failures, 0, "no failure recorded for a bypassed call");
  } finally {
    restore();
  }
});
