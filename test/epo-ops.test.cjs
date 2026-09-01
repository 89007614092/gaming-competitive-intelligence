"use strict";
// EPO OPS client (lib/epoOps.js) — unit tests with an injected fetch.
//
// Nothing here touches the network or needs real EPO keys: fetch, the clock and
// the logger are all dependency-injected, exactly like test/search-provider.test.cjs
// does for the web-search chain.
//
// The behaviours pinned below are the ones that keep the app inside EPO's Fair
// Use quota and keep a dead/expired credential from silently returning empty
// result sets:
//   * unconfigured -> one clear error code, never a confusing HTTP blast;
//   * the 20-minute token is cached and auto-renewed (incl. the stale-token retry);
//   * a 403 with Retry-After parks the client instead of hammering OPS;
//   * repeated failures open a circuit so OPS stops costing latency;
//   * the XML-ish OPS JSON normalises into the flat card shape the UI renders.

const test = require("node:test");
const assert = require("node:assert");
const {
  createEpoClient,
  buildCql,
  buildCacheKey,
  normaliseSearchResult,
  collectDocuments,
  companyTokens,
  applicantAliases,
  espacenetUrl,
  isoDate,
  CPC_GROUPS,
  CPC_CHIPS,
  CPC_ALL_CODES,
  CPC_DEFAULT_CODES,
  isCpcCode,
  MAX_ITEMS,
  MAX_ABSTRACT_LOOKUPS,
} = require("../lib/epoOps");

const KEYS = { EPO_OPS_KEY: "test-consumer-key", EPO_OPS_SECRET: "test-consumer-secret" };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function docDbId(country, number, kind, date) {
  return {
    "@document-id-type": "docdb",
    country: { "#text": country },
    "doc-number": { "#text": number },
    kind: { "#text": kind },
    date: { "#text": date },
  };
}

function exchangeDoc({ number = "4123456", country = "EP", kind = "A1", date = "20250312", title = "Neural game animation" } = {}) {
  return {
    "@family-id": "991",
    "bibliographic-data": {
      "publication-reference": {
        "document-id": [
          docDbId(country, number, kind, date),
          { "@document-id-type": "epodoc", "doc-number": { "#text": `${country}${number}` } },
        ],
      },
      "invention-title": [
        { "@lang": "fr", "#text": "Animation de personnage" },
        { "@lang": "en", "#text": title },
      ],
      parties: {
        applicants: { applicant: [{ "applicant-name": { name: { "#text": "Google DeepMind" } } }] },
        inventors: { inventor: [{ "inventor-name": { name: { "#text": "Jane Doe" } } }] },
      },
      "classifications-ipcr": { "classification-ipcr": [{ text: { "#text": "A63F 13/00" } }] },
    },
  };
}

// A realistic search envelope. `docs` may be an object (single hit) or an array.
function searchPayload(docs, total = "348") {
  return {
    "ops:world-patent-data": {
      "ops:search-result": {
        "@total-result-count": total,
        "exchange-documents": { "exchange-document": docs },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------
// Routes by substring and records every call. `handler` may return a response
// object or throw (to simulate a network fault).
function router(handlers) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    calls.push(u);
    for (const [needle, handler] of Object.entries(handlers)) {
      if (u.includes(needle)) {
        const result = typeof handler === "function" ? handler(u, opts) : handler;
        if (result && typeof result.then === "function") return result;  // async handler
        return result;
      }
    }
    throw new Error(`unrouted fetch: ${u}`);
  };
  return { fetchImpl, calls };
}

function jsonResp(body, { status = 200, headers = {} } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [String(k).toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (h.has(String(name).toLowerCase()) ? h.get(String(name).toLowerCase()) : null) },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function tokenResp(expiresIn = 1199) {
  return jsonResp({ access_token: "tok-abc", token_type: "Bearer", expires_in: expiresIn });
}

const TOKEN_NEEDLE = "auth/accesstoken";
const SEARCH_NEEDLE = "published-data/search";
const ABSTRACT_NEEDLE = "/abstract";

// ---------------------------------------------------------------------------
// buildCql
// ---------------------------------------------------------------------------
test("buildCql ANDs company, keyword, CPC and date range", () => {
  const cql = buildCql({
    company: "Google DeepMind",
    keyword: "neural",
    cpc: ["A63F", "G06N"],
    from: "20240101",
    to: "20261231",
  });
  // Applicant: one phrase, right-truncated (see the tests below for why).
  assert.match(cql, /pa = "Google DeepMind\*"/);
  assert.match(cql, /ta all "neural"/);
  assert.match(cql, /cpc = "A63F"/);
  assert.match(cql, /cpc = "G06N"/);
  assert.match(cql, /pd within "20240101 20261231"/);
  // Multiple CPCs must be OR'd INSIDE a group, not AND'd flat.
  assert.match(cql, /\(cpc = "A63F" OR cpc = "G06N"\)/);
  // Clauses combine with AND.
  assert.ok(cql.includes(") AND "), `expected AND-joined clauses, got: ${cql}`);
});

// Two bugs shaped this, one on each side of "how loose is the applicant match":
//   * `pa all "Google DeepMind"` required EVERY word, so every compound name
//     matched nothing at all (PR #109, zero results for every company).
//   * Splitting the name into words and OR'ing them (`pa = "Google*" OR
//     "DeepMind*"`) was far too loose — "Rockstar North" retrieved NORTH
//     AMERICA and NORTHWESTERN, and "Warhorse" retrieved WARHORSE LOGISTICS
//     SUZHOU and WARHORSE BEIJING BEVERAGES.
// The name is matched as a PHRASE with right-truncation, which keeps the legal
// suffixes OPS stores ("WARHORSE STUDIOS A.S.") without matching by word.
test("the applicant clause is phrase-with-truncation, never word-level OR", () => {
  assert.strictEqual(buildCql({ company: "Google DeepMind" }), 'pa = "Google DeepMind*"');
  assert.strictEqual(buildCql({ company: "Valve" }), 'pa = "Valve*"');
  assert.strictEqual(buildCql({ company: "NVIDIA" }), 'pa = "NVIDIA*"');
  assert.strictEqual(buildCql({ company: "Stability AI" }), 'pa = "Stability AI*"');
  assert.strictEqual(buildCql({ company: "Creative Assembly" }), 'pa = "Creative Assembly*"');
  assert.strictEqual(buildCql({ company: "Games" }), 'pa = "Games*"');
  // Never the all-words-required form, and never a bare single-word clause
  // derived from a multi-word name.
  assert.ok(!/pa all/.test(buildCql({ company: "Google DeepMind" })));
  assert.ok(!/pa = "Warhorse\*"/.test(buildCql({ company: "Warhorse Studios" })));
  assert.ok(!/pa = "North\*"/.test(buildCql({ company: "Rockstar North" })));
});

// The two false-positive classes the user actually reported.
test("applicant search does not leak single words into unrelated applicants", () => {
  // Was pa = "North*" -> NORTH AMERICA, NORTHWESTERN.
  assert.strictEqual(buildCql({ company: "Rockstar North" }), 'pa = "Rockstar North*"');
  // Was pa = "Warhorse*" -> WARHORSE LOGISTICS SUZHOU, WARHORSE BEIJING BEVERAGES.
  assert.strictEqual(buildCql({ company: "Warhorse Studios" }), 'pa = "Warhorse Studios*"');
});

// A name listing several entities is a set of ALIASES, not a bag of words:
// each part is kept intact as a phrase, then OR'd.
test("multi-entity names split into aliases, each kept as a phrase", () => {
  assert.strictEqual(
    buildCql({ company: "Take-Two / Rockstar Games" }),
    '(pa = "Take Two*" OR pa = "Rockstar Games*")'
  );
  assert.strictEqual(
    buildCql({ company: "Creative Assembly / Sega" }),
    '(pa = "Creative Assembly*" OR pa = "Sega*")'
  );
  assert.strictEqual(buildCql({ company: "Decart x Etched" }), '(pa = "Decart*" OR pa = "Etched*")');
  // Parentheticals are noise, not part of the name.
  assert.strictEqual(buildCql({ company: "OpenArt (Worlds)" }), 'pa = "OpenArt*"');
  // A name with no separator stays one phrase — GSC must not be split out.
  assert.strictEqual(buildCql({ company: "GSC Game World" }), 'pa = "GSC Game World*"');
  assert.strictEqual(buildCql({ company: "UK ICO" }), 'pa = "UK ICO*"');
});

test("applicantAliases splits on separators and drops parentheticals", () => {
  assert.deepStrictEqual(applicantAliases("Take-Two / Rockstar Games"), ["Take Two", "Rockstar Games"]);
  assert.deepStrictEqual(applicantAliases("Decart x Etched"), ["Decart", "Etched"]);
  assert.deepStrictEqual(applicantAliases("OpenArt (Worlds)"), ["OpenArt"]);
  assert.deepStrictEqual(applicantAliases("GSC Game World"), ["GSC Game World"]);
  assert.deepStrictEqual(applicantAliases(""), []);
  // Fragments too short to search on are dropped.
  assert.deepStrictEqual(applicantAliases("AB / Sony"), ["Sony"]);
});

test("companyTokens still guards cross-reference matching", () => {
  // Matching is a substring test against OPS applicant strings, so it must stay
  // strict: "ico" would falsely match "MEXICO" or "ICON".
  assert.deepStrictEqual(companyTokens("UK ICO"), []);
  assert.deepStrictEqual(companyTokens("Google DeepMind"), ["google", "deepmind"]);
  assert.deepStrictEqual(companyTokens("Creative Assembly"), ["creative", "assembly"]);
});

test("buildCql strips quotes and rejects malformed CPC codes", () => {
  // A stray quote would otherwise break the whole CQL expression.
  const cql = buildCql({ company: 'Acme "Labs"\\' });
  // The name stays a single phrase; the quote cannot survive into the CQL.
  assert.strictEqual(cql, 'pa = "Acme Labs*"');
  assert.ok(!cql.includes('\\'));

  // Garbage CPC is dropped rather than sent to OPS and 400-ing.
  assert.strictEqual(buildCql({ cpc: ["ZZZZ", "not-a-code", "A63F"], keyword: "x" }), 'ta all "x" AND cpc = "A63F"');
});

test("buildCql returns empty for an empty query and supports open-ended dates", () => {
  assert.strictEqual(buildCql({}), "");
  assert.strictEqual(buildCql({ company: "", keyword: "", cpc: [] }), "");
  assert.match(buildCql({ from: "20250101" }), /pd >= "20250101"/);
  assert.match(buildCql({ to: "20250101" }), /pd <= "20250101"/);
});

// ---------------------------------------------------------------------------
// buildCacheKey
// ---------------------------------------------------------------------------
test("buildCacheKey is stable and CPC-order independent", () => {
  const a = buildCacheKey({ company: "DeepMind", cpc: ["A63F", "G06N"], range: 25, sort: "date" });
  const b = buildCacheKey({ company: "DeepMind", cpc: ["G06N", "A63F"], range: 25, sort: "date" });
  assert.strictEqual(a, b, "the same logical query must hit the same cache row");

  const c = buildCacheKey({ company: "DeepMind", cpc: ["A63F"], range: 25, sort: "date" });
  assert.notStrictEqual(a, c, "a different CPC set is a different query");
  // Case/whitespace noise must not create duplicate rows.
  assert.strictEqual(
    buildCacheKey({ company: "  deepmind ", keyword: "", cpc: [] }),
    buildCacheKey({ company: "DeepMind" })
  );
});

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------
test("normaliseSearchResult flattens an OPS envelope into patent cards", () => {
  const { patents, totalAvailable } = normaliseSearchResult(searchPayload(exchangeDoc()), 25);
  assert.strictEqual(totalAvailable, 348);
  assert.strictEqual(patents.length, 1);
  const p = patents[0];
  assert.strictEqual(p.id, "EP4123456A1");
  assert.strictEqual(p.country, "EP");
  assert.strictEqual(p.kind, "A1");
  // English title must win over the French one.
  assert.strictEqual(p.title, "Neural game animation");
  assert.deepStrictEqual(p.applicants, ["Google DeepMind"]);
  assert.deepStrictEqual(p.inventors, ["Jane Doe"]);
  assert.deepStrictEqual(p.classifications, ["A63F 13/00"]);
  assert.strictEqual(p.publicationDate, "2025-03-12");
  assert.strictEqual(p.espacenetUrl, espacenetUrl("EP4123456A1"));
  assert.strictEqual(p.attribution, "Data: EPO OPS");
});

test("normaliseSearchResult drops unparseable documents and honours the limit", () => {
  const docs = [
    exchangeDoc({ number: "1111111" }),
    { "bibliographic-data": { "invention-title": "no publication id" } }, // must be dropped
    exchangeDoc({ number: "2222222" }),
    null,
  ];
  const { patents } = normaliseSearchResult(searchPayload(docs), 25);
  assert.strictEqual(patents.length, 2, "only documents with a resolvable number survive");
  assert.deepStrictEqual(patents.map(p => p.number), ["1111111", "2222222"]);

  const capped = normaliseSearchResult(searchPayload(docs), 1);
  assert.strictEqual(capped.patents.length, 1, "the limit is applied");
});

test("normaliseSearchResult tolerates a single object instead of an array", () => {
  const { patents } = normaliseSearchResult(searchPayload(exchangeDoc({ number: "3333333" })), 25);
  assert.strictEqual(patents.length, 1, "OPS returns a bare object when there is exactly one hit");
  assert.strictEqual(patents[0].number, "3333333");
});

test("normaliseSearchResult degrades to empty (never throws) on an unknown shape", () => {
  for (const bad of [null, undefined, {}, { "ops:world-patent-data": {} }, { "ops:world-patent-data": { "ops:search-result": {} } }]) {
    const out = normaliseSearchResult(bad, 25);
    assert.deepStrictEqual(out.patents, []);
    assert.strictEqual(out.totalAvailable, 0);
  }
});

// ---------------------------------------------------------------------------
// Diagnostics — the guard against a silent empty result
// ---------------------------------------------------------------------------
// An unreadable OPS payload and a genuinely empty search look IDENTICAL to the
// user ("no patents matched"). These tests pin the distinction so a parse
// failure surfaces as a fault instead of masquerading as "no results".
test("diagnostics distinguish 'OPS found nothing' from 'we failed to parse it'", () => {
  // Genuinely empty: OPS returns a well-formed envelope reporting zero hits.
  // That is a successful read, NOT a fault — the UI must show a plain empty
  // state rather than "the response could not be read".
  const empty = normaliseSearchResult(searchPayload([], "0"), 25);
  assert.strictEqual(empty.patents.length, 0);
  assert.strictEqual(empty.diagnostics.totalResultCount, 0);
  assert.strictEqual(empty.diagnostics.recognised, true, "the envelope was read fine — it just had no hits");

  // Parse failure: OPS reports 12 hits but the documents carry no number.
  const broken = normaliseSearchResult({
    "ops:world-patent-data": {
      "ops:search-result": {
        "@total-result-count": "12",
        "exchange-documents": {
          "exchange-document": [{ "bibliographic-data": { "invention-title": "missing ids" } }],
        },
      },
    },
  }, 25);
  assert.strictEqual(broken.patents.length, 0);
  assert.strictEqual(broken.diagnostics.totalResultCount, 12, "OPS DID find hits");
  assert.strictEqual(broken.diagnostics.docsSeen, 1);
  assert.strictEqual(broken.diagnostics.docsKept, 0, "…but we parsed none of them");
  assert.strictEqual(broken.diagnostics.recognised, true, "the envelope was understood");
  // The route turns exactly this combination into a 502 rather than an empty 200.

  // Genuinely unreadable: no search envelope anywhere and no documents found.
  const junk = normaliseSearchResult({ unexpected: { shape: "entirely" } }, 25);
  assert.strictEqual(junk.patents.length, 0);
  assert.strictEqual(junk.diagnostics.recognised, false, "nothing recognisable was read");
});

test("a healthy search reports docsSeen == docsKept", () => {
  const out = normaliseSearchResult(searchPayload([exchangeDoc(), exchangeDoc({ number: "4222222" })]), 25);
  assert.strictEqual(out.diagnostics.docsSeen, 2);
  assert.strictEqual(out.diagnostics.docsKept, 2);
  assert.strictEqual(out.diagnostics.totalResultCount, 348);
  assert.strictEqual(out.diagnostics.strategy, "envelope");
});

test("an unrecognised envelope falls back to scanning for documents", () => {
  // Same document, but nested where the normal envelope path does not reach —
  // e.g. an OPS JSON serialisation that drops the ops: prefixes. This must not
  // silently become "no results".
  const out = normaliseSearchResult({
    "world-patent-data": { "exchange-documents": { "exchange-document": exchangeDoc({ number: "4555555" }) } },
  }, 25);
  assert.strictEqual(out.patents.length, 1, "the scan fallback rescues it");
  assert.strictEqual(out.patents[0].number, "4555555");
  assert.strictEqual(out.diagnostics.strategy, "scan");
});

test("collectDocuments finds document nodes at any depth and ignores junk", () => {
  const doc = exchangeDoc({ number: "4666666" });
  const found = collectDocuments({
    a: { b: [{ c: doc }] },
    junk: [{ nope: 1 }, "string", 42, null],
  });
  assert.strictEqual(found.length, 1, "one document-shaped node, found regardless of nesting");
  assert.strictEqual(found[0]["bibliographic-data"], doc["bibliographic-data"]);
  assert.deepStrictEqual(collectDocuments({ nothing: "here" }), []);
  assert.deepStrictEqual(collectDocuments(null), [], "never throws on junk input");
});

test("companyTokens keeps capitalisation for the query and lowercases for matching", () => {
  assert.deepStrictEqual(companyTokens("Google DeepMind", { lower: false }), ["Google", "DeepMind"]);
  assert.deepStrictEqual(companyTokens("Google DeepMind"), ["google", "deepmind"]);
  assert.deepStrictEqual(companyTokens("Ubisoft Montreal / La Forge", { lower: false }), ["Ubisoft", "Montreal", "Forge"]);
});

test("isoDate converts OPS YYYYMMDD and passes through ISO values", () => {
  assert.strictEqual(isoDate("20250312"), "2025-03-12");
  assert.strictEqual(isoDate("2025-03-12"), "2025-03-12");
  assert.strictEqual(isoDate(""), "");
  assert.strictEqual(isoDate("garbage"), "garbage", "raw value is preserved for debugging");
});

test("CPC filters are grouped, labelled, and default to video games", () => {
  assert.ok(CPC_GROUPS.length >= 3, "filters are presented in groups, not one flat row");
  for (const g of CPC_GROUPS) {
    assert.ok(g.id && g.label, "every group needs an id and a label");
    for (const c of g.chips) {
      assert.ok(c.id && c.label, "every chip needs an id and a label");
      assert.ok(Array.isArray(c.codes) && c.codes.length, `${c.id} needs codes`);
      // Every code the UI offers must survive the validator, or the chip is
      // dead on arrival — this is exactly how group-level codes were lost.
      for (const code of c.codes) {
        assert.strictEqual(isCpcCode(code), code, `${code} must be accepted by the validator`);
      }
    }
  }
  // The default is the tightest useful filter: video games only.
  assert.deepStrictEqual(CPC_DEFAULT_CODES, ["A63F13/00"]);
  // Broad subclasses are legal CPC but must never be offered as chips.
  const offered = CPC_CHIPS.flatMap(c => c.codes);
  for (const broad of ["A63F", "G06N", "G06T", "G06F"]) {
    assert.ok(!offered.includes(broad), `${broad} is too broad to be a chip`);
  }
});

test("broad A63F is what let pinball and roulette through — the default must not be it", () => {
  // A63F = "CARD, BOARD, OR ROULETTE GAMES; INDOOR GAMES USING SMALL MOVING
  // PLAYING BODIES; VIDEO GAMES; GAMES NOT OTHERWISE PROVIDED FOR".
  assert.strictEqual(buildCql({ cpc: ["A63F"] }), 'cpc = "A63F"');
  assert.strictEqual(buildCql({ cpc: ["A63F13/00"] }), 'cpc = "A63F13/00"');
  assert.notStrictEqual(CPC_DEFAULT_CODES[0], "A63F");
});

test("the CPC validator accepts subclasses, groups and subgroups", () => {
  for (const good of ["A63F", "G06N", "A63F13/00", "G06N3/092", "G06F40/35", "G06F9/50", "G06T13/40"]) {
    assert.strictEqual(isCpcCode(good), good.toUpperCase(), `${good} must be valid`);
  }
  // Case and stray whitespace are normalised.
  assert.strictEqual(isCpcCode(" a63f13/00 "), "A63F13/00");
  for (const bad of ["", "NOTACODE", "A63F13/", "ZZZZ", "123", null]) {
    assert.strictEqual(isCpcCode(bad), "", `${JSON.stringify(bad)} must be rejected`);
  }
});

// ---------------------------------------------------------------------------
// Not configured
// ---------------------------------------------------------------------------
test("an unconfigured client fails with one clear code and makes no HTTP call", async () => {
  const { fetchImpl, calls } = router({});
  const client = createEpoClient({ config: {}, fetchImpl });
  assert.strictEqual(client.isConfigured(), false);
  await assert.rejects(
    () => client.search({ company: "DeepMind" }),
    (err) => {
      assert.strictEqual(err.code, "epo_not_configured");
      assert.match(err.message, /not configured/i);
      return true;
    }
  );
  assert.strictEqual(calls.length, 0, "no keys -> no token request either");
});

test("search rejects a query with nothing to search for", async () => {
  const { fetchImpl, calls } = router({ [TOKEN_NEEDLE]: tokenResp() });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  await assert.rejects(() => client.search({}), /company, keyword or CPC/i);
  assert.strictEqual(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Token lifecycle
// ---------------------------------------------------------------------------
test("the access token is fetched once and reused across calls", async () => {
  const docs = [exchangeDoc()];
  const { fetchImpl, calls } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload(docs)),
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });

  await client.search({ company: "DeepMind" });
  await client.search({ keyword: "neural" });

  const tokenCalls = calls.filter(u => u.includes(TOKEN_NEEDLE));
  const searchCalls = calls.filter(u => u.includes(SEARCH_NEEDLE));
  assert.strictEqual(tokenCalls.length, 1, "the 20-minute token must be cached, not refetched per query");
  assert.strictEqual(searchCalls.length, 2);
  assert.strictEqual(client.status().tokenRequests, 1);
});

test("the token is renewed when it expires", async () => {
  const { fetchImpl, calls } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload([exchangeDoc()])),
  });
  let clock = 1_700_000_000_000;
  const client = createEpoClient({ config: KEYS, fetchImpl, now: () => clock });

  await client.search({ company: "DeepMind" });
  clock += 25 * 60 * 1000; // past the 20-minute lifetime
  await client.search({ company: "DeepMind" });

  assert.strictEqual(calls.filter(u => u.includes(TOKEN_NEEDLE)).length, 2, "an expired token is renewed");
});

test("a stale token reported by OPS triggers exactly one refresh + retry", async () => {
  let searchAttempts = 0;
  const { fetchImpl, calls } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => {
      searchAttempts += 1;
      // Only the FIRST search call sees the stale token; after the refresh the
      // retry succeeds. A third attempt would mean we are looping.
      return searchAttempts === 1
        ? jsonResp('{"fault":{"message":"invalid_access_token"}}', { status: 400 })
        : jsonResp(searchPayload([exchangeDoc()]));
    },
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });

  const res = await client.search({ company: "DeepMind" });
  assert.strictEqual(res.patents.length, 1, "the retry after re-auth succeeds");
  assert.strictEqual(searchAttempts, 2, "exactly one retry");
  assert.strictEqual(calls.filter(u => u.includes(TOKEN_NEEDLE)).length, 2);
  assert.strictEqual(client.status().failures, 0, "a token refresh is not a failure");
});

test("a non-auth 400 is a hard error, not an infinite retry", async () => {
  let searchAttempts = 0;
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => {
      searchAttempts += 1;
      return jsonResp('{"fault":{"message":"bad CQL"}}', { status: 400 });
    },
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  await assert.rejects(() => client.search({ cpc: ["A63F"] }), /HTTP 400/);
  assert.strictEqual(searchAttempts, 1, "only token errors are retried");
});

// ---------------------------------------------------------------------------
// Throttling (Fair Use quota)
// ---------------------------------------------------------------------------
test("a 403 with Retry-After parks the client instead of hammering OPS", async () => {
  let searchAttempts = 0;
  const { fetchImpl, calls } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => {
      searchAttempts += 1;
      return jsonResp("", { status: 403, headers: { "Retry-After": "120", "X-Rejection-Reason": "Individual per hour traffic limit exceeded" } });
    },
  });
  let clock = 1_700_000_000_000;
  const client = createEpoClient({ config: KEYS, fetchImpl, now: () => clock });

  await assert.rejects(
    () => client.search({ company: "DeepMind" }),
    (err) => {
      assert.strictEqual(err.code, "epo_throttled");
      assert.match(err.message, /quota rejected/i);
      return true;
    }
  );
  assert.strictEqual(searchAttempts, 1);
  assert.strictEqual(client.status().throttled, true);

  // The very next query must be rejected LOCALLY — no HTTP at all.
  await assert.rejects(() => client.search({ company: "DeepMind" }), (err) => {
    assert.strictEqual(err.code, "epo_throttled");
    return true;
  });
  assert.strictEqual(searchAttempts, 1, "no request is made while throttled");

  // Once Retry-After elapses, OPS is tried again.
  clock += 121 * 1000;
  assert.strictEqual(client.status().throttled, false);
  await assert.rejects(() => client.search({ company: "DeepMind" }), /quota rejected/);
  assert.strictEqual(searchAttempts, 2, "the client retries after the wait");
  // 1 token + 1 search, then 1 more search reusing the cached token; the
  // throttled attempt in between cost no HTTP.
  assert.strictEqual(calls.length, 3);
  assert.strictEqual(calls.filter(u => u.includes(TOKEN_NEEDLE)).length, 1);
  // A quota rejection is NOT a provider fault, so it must not trip the breaker.
  assert.strictEqual(client.status().circuitOpen, false);
});

test("a 403 without Retry-After still backs off on the throttle floor", async () => {
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp("", { status: 403, headers: { "X-Throttling-Control": "idle (0/hour)" } }),
  });
  let clock = 1_700_000_000_000;
  const client = createEpoClient({ config: KEYS, fetchImpl, now: () => clock, throttleFloorMs: 3600_000 });
  await assert.rejects(() => client.search({ cpc: ["A63F"] }), /quota rejected/);
  assert.strictEqual(client.status().throttled, true, "no wait hint -> back off anyway");
  assert.strictEqual(client.status().throttlingControl, "idle (0/hour)");
});

test("an auth-flavoured 403 is a fault, not a quota lockout", async () => {
  // OPS also returns 403 for an UNAUTHENTICATED request (verified live against
  // the real endpoint). Parking the client for an hour over a bad credential
  // would make a fixable problem look exactly like an exhausted quota.
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp("", { status: 403, headers: { "X-Rejection-Reason": "Anonymous requests are not allowed" } }),
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  await assert.rejects(() => client.search({ cpc: ["A63F"] }), /rejected/i);
  assert.strictEqual(client.status().throttled, false, "an auth 403 must not park the client");
  assert.strictEqual(client.status().failures, 1, "it is recorded as a provider fault instead");
});

test("throttling headers are recorded on successful responses too", async () => {
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload([exchangeDoc()]), {
      headers: { "X-Throttling-Control": "idle (4/hour)" },
    }),
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  await client.search({ cpc: ["A63F"] });
  assert.strictEqual(client.status().throttled, false, "an 'idle' quota is not a throttle");
  assert.strictEqual(client.status().throttlingControl, "idle (4/hour)");
});

// ---------------------------------------------------------------------------
// Circuit breaker
// ---------------------------------------------------------------------------
test("repeated failures open the circuit and it re-closes after the cooldown", async () => {
  let searchAttempts = 0;
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => {
      searchAttempts += 1;
      if (searchAttempts <= 2) return jsonResp("boom", { status: 500 });
      return jsonResp(searchPayload([exchangeDoc()]));
    },
  });
  let clock = 1_700_000_000_000;
  const client = createEpoClient({ config: KEYS, fetchImpl, now: () => clock, threshold: 2, cooldownMs: 60_000 });

  await assert.rejects(() => client.search({ cpc: ["A63F"] }), /HTTP 500/);
  await assert.rejects(() => client.search({ cpc: ["A63F"] }), /HTTP 500/);
  assert.strictEqual(client.status().circuitOpen, true, "two consecutive failures trip it");

  const before = searchAttempts;
  await assert.rejects(() => client.search({ cpc: ["A63F"] }), (err) => {
    assert.strictEqual(err.code, "epo_circuit_open");
    return true;
  });
  assert.strictEqual(searchAttempts, before, "an open circuit costs no HTTP call");

  clock += 61_000;
  const res = await client.search({ cpc: ["A63F"] });
  assert.strictEqual(res.patents.length, 1, "the client is retried after the cooldown");
  assert.strictEqual(client.status().circuitOpen, false);
  assert.strictEqual(client.status().failures, 0, "a success resets the counter");
});

// ---------------------------------------------------------------------------
// search / biblio / abstract
// ---------------------------------------------------------------------------
test("search normalises hits and reports the CQL actually sent", async () => {
  const { fetchImpl, calls } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload([exchangeDoc(), exchangeDoc({ number: "4222222", date: "20240115" })])),
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  const res = await client.search({ company: "Google DeepMind", cpc: ["A63F"] }, { limit: 25 });

  assert.strictEqual(res.patents.length, 2);
  assert.match(res.cql, /pa = "Google DeepMind\*"/, "the CQL is echoed back for transparency");
  assert.strictEqual(res.totalAvailable, 348);
  const url = calls.find(u => u.includes(SEARCH_NEEDLE));
  // The constituents are load-bearing: without `biblio` OPS returns only
  // publication references, so no card would have a title or applicant.
  assert.match(url, /published-data\/search\/abstract,biblio\?q=/, "biblio + abstract constituents requested");
  assert.match(url, /Range=1-25/, "the range is bounded");
  assert.match(url, /pa%20%3D%20%22Google%20DeepMind\*%22/, "the CQL is URL-encoded");
});

// Regression: the first version read only `bibliographic-data`, so a bare search
// response (number carried as @country/@doc-number/@kind attributes) produced
// ZERO cards for every query — which looked exactly like "no patents found".
test("a bare search hit (attributes only, no biblio) still becomes a card", () => {
  const bare = {
    "@country": "US",
    "@doc-number": "20240123456",
    "@kind": "A1",
    "@family-id": "77",
  };
  const out = normaliseSearchResult({
    "ops:world-patent-data": {
      "ops:search-result": {
        "@total-result-count": "1",
        "exchange-documents": { "exchange-document": [bare] },
      },
    },
  }, 25);
  assert.strictEqual(out.patents.length, 1, "the hit must not be dropped");
  assert.strictEqual(out.patents[0].id, "US20240123456A1");
  assert.strictEqual(out.patents[0].country, "US");
  assert.match(out.patents[0].espacenetUrl, /espacenet\.com/);
  assert.strictEqual(out.diagnostics.docsSeen, 1);
  assert.strictEqual(out.diagnostics.docsKept, 1);
});

// Asking for `abstract` in the search call should remove the need for any
// per-hit abstract round-trip — that is up to 10 fewer OPS calls per search.
test("abstracts delivered in the search response cost no extra OPS calls", async () => {
  let abstractCalls = 0;
  const withAbstract = exchangeDoc({ number: "4777777" });
  withAbstract.abstract = { "@lang": "en", p: { "#text": "Inline abstract." } };
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload([withAbstract])),
    [ABSTRACT_NEEDLE]: () => { abstractCalls += 1; return jsonResp({}); },
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  const res = await client.search({ company: "DeepMind" });
  assert.strictEqual(res.patents[0].abstract, "Inline abstract.", "the inline abstract is parsed");
  await client.enrichWithAbstracts(res.patents);
  assert.strictEqual(abstractCalls, 0, "nothing left to fetch — no wasted quota");
});

test("the item count is clamped to OPS's maximum range", async () => {
  const { fetchImpl, calls } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload([exchangeDoc()])),
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  await client.search({ cpc: ["A63F"] }, { limit: 500 });
  const url = calls.find(u => u.includes(SEARCH_NEEDLE));
  assert.match(url, new RegExp(`Range=1-${MAX_ITEMS}`), "must never request more than OPS allows");
});

test("biblio returns a single normalised card", async () => {
  const { fetchImpl, calls } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    "/biblio": () => jsonResp({ "ops:world-patent-data": { "exchange-documents": { "exchange-document": exchangeDoc() } } }),
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  const card = await client.biblio("EP4123456A1");
  assert.strictEqual(card.id, "EP4123456A1");
  assert.strictEqual(card.applicants[0], "Google DeepMind");
  assert.ok(calls.some(u => u.includes("/biblio")));
  await assert.rejects(() => client.biblio(""), /Publication number is required/);
});

test("fetchAbstract reads the English abstract from the abstract endpoint", async () => {
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [ABSTRACT_NEEDLE]: () => jsonResp({
      "ops:world-patent-data": {
        "exchange-documents": {
          "exchange-document": {
            abstract: [
              { "@lang": "de", p: { "#text": "Deutsche Zusammenfassung" } },
              { "@lang": "en", p: [{ "#text": "A method for" }, { "#text": "animating a character." }] },
            ],
          },
        },
      },
    }),
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  const text = await client.fetchAbstract("EP4123456A1");
  assert.strictEqual(text, "A method for animating a character.", "English is preferred and paragraphs are joined");
});

// ---------------------------------------------------------------------------
// enrichWithAbstracts — the quota guard
// ---------------------------------------------------------------------------
test("enrichWithAbstracts fills missing abstracts but is strictly bounded", async () => {
  const docs = [];
  for (let i = 0; i < 20; i += 1) docs.push(exchangeDoc({ number: `400000${i}` }));
  let abstractCalls = 0;
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload(docs)),
    [ABSTRACT_NEEDLE]: () => {
      abstractCalls += 1;
      return jsonResp({
        "ops:world-patent-data": {
          "exchange-documents": { "exchange-document": { abstract: { "@lang": "en", p: { "#text": `Abstract ${abstractCalls}` } } } },
        },
      });
    },
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  const res = await client.search({ company: "DeepMind" });
  await client.enrichWithAbstracts(res.patents);

  assert.strictEqual(abstractCalls, MAX_ABSTRACT_LOOKUPS, `at most ${MAX_ABSTRACT_LOOKUPS} extra OPS calls per search`);
  assert.strictEqual(res.patents.filter(p => p.abstract).length, MAX_ABSTRACT_LOOKUPS);
  assert.strictEqual(res.patents[0].abstract, "Abstract 1");
});

test("enrichWithAbstracts honours a lower cap and skips hits that already have one", async () => {
  let abstractCalls = 0;
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload([exchangeDoc({ number: "4000001" }), exchangeDoc({ number: "4000002" })])),
    [ABSTRACT_NEEDLE]: () => {
      abstractCalls += 1;
      return jsonResp({
        "ops:world-patent-data": {
          "exchange-documents": { "exchange-document": { abstract: { p: "filled" } } },
        },
      });
    },
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  const res = await client.search({ company: "DeepMind" });

  await client.enrichWithAbstracts(res.patents, 1);
  assert.strictEqual(abstractCalls, 1, "the cap is respected");
  assert.ok(res.patents[0].abstract, "the first hit is filled");
  assert.strictEqual(res.patents[1].abstract, "", "a cap of 1 leaves the second hit alone");

  // Raising the cap fills only what is still missing.
  await client.enrichWithAbstracts(res.patents, 10);
  assert.strictEqual(abstractCalls, 2, "one further call for the one remaining hit");
  assert.ok(res.patents[1].abstract);

  // Everything is populated now — no further OPS calls.
  await client.enrichWithAbstracts(res.patents, 10);
  assert.strictEqual(abstractCalls, 2, "hits that already have an abstract cost nothing");
});

test("enrichWithAbstracts stops immediately when OPS throttles mid-batch", async () => {
  let abstractCalls = 0;
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload([exchangeDoc({ number: "4000001" }), exchangeDoc({ number: "4000002" })])),
    [ABSTRACT_NEEDLE]: () => {
      abstractCalls += 1;
      return jsonResp("", { status: 403, headers: { "Retry-After": "600" } });
    },
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });
  const res = await client.search({ company: "DeepMind" });
  await client.enrichWithAbstracts(res.patents, 10);
  assert.strictEqual(abstractCalls, 1, "bails after the first failure rather than burning the quota");
  assert.strictEqual(client.status().throttled, true);
  assert.strictEqual(res.patents.filter(p => p.abstract).length, 0, "partial abstracts are acceptable");
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------
test("status() reports configuration and breaker state for /healthz", async () => {
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => jsonResp(searchPayload([exchangeDoc()])),
  });
  const client = createEpoClient({ config: KEYS, fetchImpl });

  assert.strictEqual(client.status().configured, true);
  assert.strictEqual(client.status().tokenCached, false, "no token before the first call");

  await client.search({ cpc: ["A63F"] });
  const st = client.status();
  assert.strictEqual(st.configured, true);
  assert.strictEqual(st.circuitOpen, false);
  assert.strictEqual(st.throttled, false);
  assert.strictEqual(st.tokenCached, true);
  assert.strictEqual(st.tokenRequests, 1);
  assert.strictEqual(st.failures, 0);
});

test("reset() clears token, breaker and throttle state (test seam)", async () => {
  let searchAttempts = 0;
  const { fetchImpl } = router({
    [TOKEN_NEEDLE]: tokenResp(1199),
    [SEARCH_NEEDLE]: () => {
      searchAttempts += 1;
      return jsonResp("boom", { status: 500 });
    },
  });
  let clock = 1_700_000_000_000;
  const client = createEpoClient({ config: KEYS, fetchImpl, now: () => clock, threshold: 2, cooldownMs: 60_000 });
  await assert.rejects(() => client.search({ cpc: ["A63F"] }));
  await assert.rejects(() => client.search({ cpc: ["A63F"] }));
  assert.strictEqual(client.status().circuitOpen, true);

  client.reset();
  assert.strictEqual(client.status().circuitOpen, false);
  assert.strictEqual(client.status().failures, 0);
  assert.strictEqual(client.status().tokenCached, false);
  await assert.rejects(() => client.search({ cpc: ["A63F"] }), /HTTP 500/);
  assert.strictEqual(searchAttempts, 3, "OPS is contacted again after a reset");
});
