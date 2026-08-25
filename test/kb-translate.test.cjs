'use strict';

// Tests for lib/kbTranslate.js — the hash-gated KB/news translation cache.
// The shared pg pool (datasets.getDbPool) and the MT provider
// (mtService.translateBatch) are mocked so no database or network is touched.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert");

const datasets = require("../lib/datasets");
const mt = require("../lib/mtService");
const kb = require("../lib/kbTranslate");

// ---- fakes ----------------------------------------------------------------

let kbRow = null; // simulates an existing kb_translations row (cache hit)
let upsertCalls = [];
let translateCalls = 0;
let fakeData = {};

const fakePool = {
  query(sql, params) {
    if (/CREATE TABLE/.test(sql)) return Promise.resolve({});
    if (/SELECT .* FROM kb_translations/.test(sql)) {
      return Promise.resolve({ rows: kbRow ? [kbRow] : [] });
    }
    if (/SELECT .* FROM news_translations/.test(sql)) {
      return Promise.resolve({ rows: [] });
    }
    if (/INSERT INTO (kb|news)_translations/.test(sql)) {
      upsertCalls.push(params);
      return Promise.resolve({});
    }
    if (/DELETE FROM/.test(sql)) return Promise.resolve({ rowCount: 0 });
    return Promise.resolve({ rows: [] });
  },
};

// Deterministic transform that preserves citation chips verbatim.
mt.translateBatch = async (texts) => {
  translateCalls += texts.length;
  return texts.map((t) => "ZH|" + t);
};
datasets.getDbPool = () => fakePool;
datasets.getDataset = (name) => fakeData[name] || null;

function reset() {
  kbRow = null;
  upsertCalls = [];
  translateCalls = 0;
  fakeData = {};
  process.env.DEEPL_API_KEY = "test:fx"; // exercise the translate path
}
beforeEach(reset);

// ---- shouldTranslate ------------------------------------------------------

test("shouldTranslate skips codes/numbers but keeps prose", () => {
  assert.strictEqual(kb.shouldTranslate("gpt-4"), false);
  assert.strictEqual(kb.shouldTranslate("A12"), false);
  assert.strictEqual(kb.shouldTranslate("2024"), false);
  assert.strictEqual(kb.shouldTranslate("GDPR"), false); // short alnum token
  assert.strictEqual(kb.shouldTranslate(""), false);
  assert.strictEqual(kb.shouldTranslate("Hello world"), true);
  assert.strictEqual(kb.shouldTranslate("The EU AI Act"), true);
});

// ---- translateJsonDeep ----------------------------------------------------

test("translateJsonDeep preserves keys/structure, translates values, keeps chips", async () => {
  const input = {
    name: "Foo", // short token → not translated
    desc: "See [A1] now", // prose → translated, chip preserved
    code: "gpt-4", // not translated
    n: 3,
    list: ["Small text", "Hello there"],
    nested: { title: "Big title here", id: "X9" },
  };
  const out = await kb.translateJsonDeep(input, "zh-CN");
  assert.deepStrictEqual(Object.keys(out).sort(), ["code", "desc", "list", "n", "name", "nested"]);
  assert.strictEqual(out.name, "Foo");
  assert.strictEqual(out.code, "gpt-4");
  assert.strictEqual(out.n, 3);
  assert.strictEqual(out.desc, "ZH|See [A1] now");
  assert.strictEqual(out.list[0], "ZH|Small text");
  assert.strictEqual(out.list[1], "ZH|Hello there");
  assert.strictEqual(out.nested.title, "ZH|Big title here");
  assert.strictEqual(out.nested.id, "X9"); // code-like → untouched
});

// ---- getDatasetTranslated ------------------------------------------------

test("getDatasetTranslated: hash miss translates + caches", async () => {
  fakeData.knowledge = { a: "Hello world", b: "gpt-4" };
  const res = await kb.getDatasetTranslated("knowledge", "zh-CN");
  assert.ok(translateCalls > 0);
  assert.strictEqual(upsertCalls.length, 1);
  assert.deepStrictEqual(res, { a: "ZH|Hello world", b: "gpt-4" });
});

test("getDatasetTranslated: hash hit returns cached translation, no re-translate", async () => {
  const src = { a: "Hello world" };
  fakeData.knowledge = src;
  kbRow = { content_hash: kb.hashJson(src), translated_json: { a: "CACHED" } };
  const res = await kb.getDatasetTranslated("knowledge", "zh-CN");
  assert.strictEqual(res.a, "CACHED");
  assert.strictEqual(translateCalls, 0);
  assert.strictEqual(upsertCalls.length, 0);
});

test("getDatasetTranslated: missing DEEPL_API_KEY serves English, no translate", async () => {
  const prev = process.env.DEEPL_API_KEY;
  delete process.env.DEEPL_API_KEY;
  fakeData.knowledge = { a: "Hello world" };
  const res = await kb.getDatasetTranslated("knowledge", "zh-CN");
  assert.strictEqual(translateCalls, 0);
  assert.strictEqual(upsertCalls.length, 0);
  assert.deepStrictEqual(res, { a: "Hello world" });
  process.env.DEEPL_API_KEY = prev;
});

test("getDatasetTranslated: DB unavailable translates but does not write cache", async () => {
  datasets.getDbPool = () => null;
  fakeData.knowledge = { a: "Hello world" };
  const res = await kb.getDatasetTranslated("knowledge", "zh-CN");
  assert.strictEqual(res.a, "ZH|Hello world");
  assert.strictEqual(upsertCalls.length, 0);
  datasets.getDbPool = () => fakePool; // restore
});

// ---- translateNewsSummaries ----------------------------------------------

test("translateNewsSummaries: persists only saved articles", async () => {
  const articles = [
    { id: "n1", styledSummary: "Hello world" },
    { id: "n2", styledSummary: "Big news" },
    { id: "n3" }, // no summary
  ];
  const res = await kb.translateNewsSummaries(articles, "zh-CN", ["n1"]);
  assert.strictEqual(res[0].styledSummary, "ZH|Hello world");
  assert.strictEqual(res[1].styledSummary, "ZH|Big news");
  assert.strictEqual(res[2].styledSummary, undefined);
  const savedUpserts = upsertCalls.filter((p) => p[0] === "n1");
  const otherUpserts = upsertCalls.filter((p) => p[0] === "n2");
  assert.strictEqual(savedUpserts.length, 1);
  assert.strictEqual(otherUpserts.length, 0);
});

test("translateNewsSummaries: en lang returns unchanged, no translate", async () => {
  const articles = [{ id: "n1", styledSummary: "Hello" }];
  const res = await kb.translateNewsSummaries(articles, "en", ["n1"]);
  assert.strictEqual(translateCalls, 0);
  assert.strictEqual(res[0].styledSummary, "Hello");
});

// ---- translateEvidence ----------------------------------------------------

test("translateEvidence: translates free-text fields, keeps ids; en unchanged", async () => {
  const ev = [
    { id: "A1", text: "Hello world", excerpt: "Short desc", title: "T", section: "S" },
    { id: "W1", text: "Web text" },
  ];
  const out = await kb.translateEvidence(ev, "zh-CN");
  assert.strictEqual(out[0].id, "A1");
  assert.strictEqual(out[0].text, "ZH|Hello world");
  assert.strictEqual(out[0].excerpt, "ZH|Short desc");
  assert.strictEqual(out[0].title, "ZH|T");
  assert.strictEqual(out[1].text, "ZH|Web text");

  const out2 = await kb.translateEvidence(ev, "en");
  assert.strictEqual(out2[0].text, "Hello world");
});

// ---- retranslateAllKb (PR #95) -------------------------------------------

test("retranslateAllKb: reports ok when translation produces Chinese", async () => {
  const orig = mt.translateBatch;
  // CJK-producing mock so the report shows success.
  mt.translateBatch = async (texts) => texts.map((t) => "中文|" + t);
  for (const n of kb.KB_DATASET_NAMES) fakeData[n] = { a: "Hello world" };
  const report = await kb.retranslateAllKb("zh-CN");
  assert.strictEqual(report.keyPresent, true);
  assert.strictEqual(report.results.length, kb.KB_DATASET_NAMES.length);
  assert.ok(report.results.every((r) => r.ok === true), "all datasets should report ok");
  assert.ok(report.results.every((r) => (r.chineseCharsAdded || 0) > 0));
  mt.translateBatch = orig;
});

test("retranslateAllKb: reports failure when translate throws (key broken)", async () => {
  const orig = mt.translateBatch;
  mt.translateBatch = async () => { throw new Error("DeepL 500"); };
  for (const n of kb.KB_DATASET_NAMES) fakeData[n] = { a: "Hello world" };
  const report = await kb.retranslateAllKb("zh-CN");
  assert.strictEqual(report.keyPresent, true);
  assert.ok(report.results.every((r) => r.ok === false), "all datasets should report failure");
  assert.ok(report.results.every((r) => r.changed === false));
  mt.translateBatch = orig;
});

test("retranslateAllKb: key absent reports keyPresent false, no results", async () => {
  const prev = process.env.DEEPL_API_KEY;
  delete process.env.DEEPL_API_KEY;
  const report = await kb.retranslateAllKb("zh-CN");
  assert.strictEqual(report.keyPresent, false);
  assert.strictEqual(report.results.length, 0);
  process.env.DEEPL_API_KEY = prev;
});
