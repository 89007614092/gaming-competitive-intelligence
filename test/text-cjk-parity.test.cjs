"use strict";

// CJK PARITY — the guard against the CLASS of bug, not each instance.
//
// Six separate Chinese-language bugs in this codebase were all the same thing:
// the pipeline assumed English punctuation and metrics.
//
//   .!? sentence splitting        -> a Chinese passage was one run-on sentence
//   40-char sentence floor        -> ordinary Chinese sentences discarded
//   contiguous-phrase matching    -> Chinese web sources scored zero
//   [A1] bracket matching         -> 【A1】 citations counted as none
//   translated headings           -> section style selection broke
//   token-per-character density   -> the conclusion was truncated
//
// Each was fixed where it was found. The point of this file is that a SEVENTH
// should fail here immediately, rather than being discovered by a user.
//
// The pattern: every helper that touches free text is run over MATCHED English
// and Chinese samples, and must give a comparable, non-degenerate result.

process.env.OPEN_MODEL_API_KEY = "test-key";
process.env.OPEN_MODEL_BASE_URL = "http://localhost:9/v1";
process.env.OPEN_MODEL_NAME = "openai/gpt-oss-120b";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const textCjk = require("../lib/text-cjk.js");
const engine = require("../summarise-engine.js");
const { LOCALES } = require("../public/locales.js");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");
const ENGINE_JS = fs.readFileSync(path.join(__dirname, "..", "summarise-engine.js"), "utf8");
const INDEX_HTML = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

// Matched sample pair: same content, two scripts.
const SAMPLES = {
  en: {
    sentences: "Compliance risk is rising. Fines reach three percent of turnover.",
    query: "What are the main risks for Tencent?",
    doc: "Tencent faces compliance risk and needs watermarking controls.",
    cited: "Risk is rising [A1].",
    heading: "Conclusion",
  },
  zh: {
    sentences: "合规风险正在上升。罚款最高可达营业额的百分之三。",
    query: "腾讯最可能面临的风险有哪些？",
    doc: "腾讯在游戏领域面临合规风险，需要建立水印与溯源机制。",
    cited: "风险正在上升【A1】。",
    heading: "结论",
  },
};

test("sentence splitting yields multiple sentences in BOTH scripts", () => {
  for (const lang of ["en", "zh"]) {
    const parts = textCjk.splitSentences(SAMPLES[lang].sentences);
    assert.ok(parts.length >= 2, `${lang}: expected >=2 sentences, got ${parts.length}`);
    // The original terminator must survive — Chinese output must keep 。
    assert.ok(/[.!?。！？]/.test(parts[0]), `${lang}: terminator should be preserved`);
  }
});

test("the sentence-length floor is script-aware", () => {
  assert.strictEqual(textCjk.minSentenceLen(SAMPLES.zh.sentences), 10);
  assert.strictEqual(textCjk.minSentenceLen(SAMPLES.en.sentences), 40);
  // A normal Chinese sentence (12 chars) must clear the floor.
  assert.ok("生成式媒体必须被明确标识。".length >= textCjk.minSentenceLen("生成式媒体必须被明确标识。"));
});

test("bracket folding makes citations visible in both scripts", () => {
  assert.strictEqual(textCjk.foldBrackets(SAMPLES.zh.cited), "风险正在上升[A1]。");
  // Already-ASCII text is untouched.
  assert.strictEqual(textCjk.foldBrackets(SAMPLES.en.cited), SAMPLES.en.cited);
});

test("the citation gate accepts a cited answer in BOTH scripts", () => {
  const evidence = [{ id: "A1" }];
  for (const lang of ["en", "zh"]) {
    const gate = engine.evaluateCitationGate(textCjk.foldBrackets(SAMPLES[lang].cited), evidence);
    assert.strictEqual(gate.pass, true, `${lang}: a cited answer must pass the gate`);
  }
});

test("on-topic documents are matched in BOTH scripts", () => {
  // Chinese: the document phrases the idea differently, so only bigram matching
  // finds it. English: ordinary token matching.
  for (const lang of ["en", "zh"]) {
    const s = SAMPLES[lang];
    const out = engine.webResultRelevance(s.query, [{ title: s.doc, description: s.doc, url: `https://${lang}.example` }], 5);
    assert.strictEqual(out.length, 1, `${lang}: an on-topic document must be kept`);
  }
});

test("section headings are recognised in BOTH scripts", () => {
  const m = /const SECTION_IDS = \{[\s\S]*?\};/.exec(APP_JS);
  assert.ok(m, "SECTION_IDS must exist");
  // eslint-disable-next-line no-new-func
  const { SECTION_IDS } = new Function(`${m[0]}\nreturn { SECTION_IDS };`)();
  for (const lang of ["en", "zh"]) {
    const heading = SAMPLES[lang].heading;
    const id = SECTION_IDS[heading.toLowerCase()];
    assert.ok(id, `${lang}: heading "${heading}" must map to a section id`);
  }
});

test("the output budget is larger for Chinese than English", () => {
  assert.ok(
    engine.maxTokensForLang("zh-CN") > engine.maxTokensForLang("en"),
    "Chinese needs more room per unit of meaning"
  );
});

test("user-facing strings exist in BOTH dictionaries", () => {
  // Cheap but effective: any new zh-CN string must be translated, not copied.
  for (const [key, value] of Object.entries(LOCALES.en)) {
    if (!(key in LOCALES["zh-CN"])) continue; // server-only strings
    const zh = LOCALES["zh-CN"][key];
    // Numbers/URLs/short labels may legitimately match; prose must not.
    if (value.length > 24) {
      assert.notStrictEqual(zh, value, `${key} looks untranslated`);
    }
  }
});

// --- the "don't reintroduce" lock -------------------------------------------

test("no component re-implements its own sentence-splitting regex", () => {
  // A bare [.!?] split silently turns Chinese into one sentence. Anything
  // splitting sentences must call the shared helper.
  const badEn = /\[\^!\?\]\s*\+/.exec(ENGINE_JS); // e.g. [^.!?]+
  const badZh = /\[\^!\?。！？\]\s*\+/.exec(ENGINE_JS);
  assert.ok(!badEn && !badZh, "summarise-engine must use textCjk.splitSentences, not a private regex");
});

test("the browser loads the shared module rather than duplicating it", () => {
  assert.ok(INDEX_HTML.includes('src="text-cjk.js"'), "index.html must load the shared module");
  assert.ok(
    /TEXT_CJK\.foldBrackets|window\.TEXT_CJK/.test(APP_JS),
    "app.js must call the shared foldBrackets"
  );
  // The old inline bracket regex must be gone.
  assert.ok(!/u3010/.test(APP_JS), "app.js must not keep its own bracket regex");
});

test("there is exactly one copy of the CJK primitives", () => {
  // The whole point of the refactor: one file, two consumers.
  const libFile = path.join(__dirname, "..", "lib", "text-cjk.js");
  assert.ok(fs.existsSync(libFile), "lib/text-cjk.js must exist");
  assert.ok(
    /require\("\.\/lib\/text-cjk"\)/.test(ENGINE_JS),
    "the server must require the shared module"
  );
  // No second definition hiding in the engine.
  assert.ok(!/function cjkBigrams\(/.test(ENGINE_JS), "cjkBigrams must not be redefined in the engine");
  assert.ok(!/function minSentenceLen\(/.test(ENGINE_JS), "minSentenceLen must not be redefined in the engine");
});
