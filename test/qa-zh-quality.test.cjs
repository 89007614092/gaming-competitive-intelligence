"use strict";

// Chinese Q&A quality — two of the three causes diagnosed on 2026-09-17:
//
//   A. the output budget was language-blind, so a Chinese answer ran out of room
//      and the LAST section (## Conclusion) was the one that got squeezed
//   B. the section classifier only recognised English headings, so a translated
//      heading degraded to "other" and style selection silently broke
//
// (C — CJK web-source matching — is deliberately NOT covered here; it needs its
// own change and its own tests.)

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const engine = require("../summarise-engine.js");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

// --- A: language-aware budget ------------------------------------------------

test("the output budget is larger for Chinese than for English", () => {
  const en = engine.maxTokensForLang("en");
  const zh = engine.maxTokensForLang("zh-CN");
  assert.ok(zh > en, `Chinese needs a bigger budget than English (got zh=${zh}, en=${en})`);
  // Roughly 2x: Chinese carries meaning ~2-3x more densely per token, so an
  // unchanged budget silently halves the usable answer length.
  assert.ok(zh / en >= 2, `expected at least 2x, got ${(zh / en).toFixed(2)}x`);
});

test("unknown and missing languages keep the English budget", () => {
  assert.strictEqual(engine.maxTokensForLang("en"), engine.maxTokensForLang());
  assert.strictEqual(engine.maxTokensForLang("fr"), engine.maxTokensForLang("en"));
  // Guard: the budget must never collapse to 0/undefined, which would make every
  // answer degenerate and fall through to the extractive path.
  for (const lang of [undefined, "", "en", "zh-CN", "fr"]) {
    assert.ok(engine.maxTokensForLang(lang) > 0, `budget must be positive for ${String(lang)}`);
  }
});

test("looksTruncated spots a cut-off answer and ignores a finished one", () => {
  // Ends mid-sentence — what a budget-starved Chinese answer looks like.
  assert.strictEqual(engine.looksTruncated("这是一个关于游戏AI战略的分析，结论是"), true);
  assert.strictEqual(engine.looksTruncated(""), true);
  // Properly terminated, in both scripts.
  assert.strictEqual(engine.looksTruncated("这是一个完整的结论。[A1]"), false);
  assert.strictEqual(engine.looksTruncated("这是一个完整的结论。"), false);
  assert.strictEqual(engine.looksTruncated("The studios should act now."), false);
  // A trailing citation chip must not read as "unfinished" — the sentence
  // before it is complete, so the answer is complete.
  assert.strictEqual(engine.looksTruncated("这是一个完整的结论。[W2]"), false);
  assert.strictEqual(engine.looksTruncated("Studios should act now. [A3][W1]"), false);
  // But a chip after an UNFINISHED sentence is still truncated.
  assert.strictEqual(engine.looksTruncated("结论如下 [W2]"), true);
});

// --- B: bilingual heading contract -------------------------------------------

test("the Chinese directive requires the English headings verbatim", () => {
  const out = engine.applyLanguageInstruction("BASE PROMPT", "zh-CN");
  for (const heading of ["## Detailed Answer", "## Key Points", "## Conclusion"]) {
    assert.ok(out.includes(heading), `the zh-CN directive must name ${heading} verbatim`);
  }
  // ...and must say they are not to be translated.
  assert.ok(out.includes("不得翻译为"), "must forbid translating the headings");
  // Still appends rather than replacing, and English is untouched.
  assert.ok(out.startsWith("BASE PROMPT"));
  assert.strictEqual(engine.applyLanguageInstruction("BASE PROMPT", "en"), "BASE PROMPT");
});

// Even with the directive, the model may translate the headings — so the client
// must survive that. This runs the browser's REAL classifier.
function loadClientClassifier() {
  const m = /const SECTION_IDS = \{[\s\S]*?\};/.exec(APP_JS);
  assert.ok(m, "could not find SECTION_IDS in app.js");
  const c = /const classify = \(title\) => SECTION_IDS\[title\.trim\(\)\.toLowerCase\(\)\] \|\| "other";/.exec(APP_JS);
  assert.ok(c, "could not find classify() in app.js");
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\n${c[0]}\nreturn { SECTION_IDS, classify };`)();
}

test("the browser classifies Chinese headings as well as English ones", () => {
  const { classify } = loadClientClassifier();
  // English (unchanged behaviour).
  assert.strictEqual(classify("Detailed Answer"), "detailed");
  assert.strictEqual(classify("Key Points"), "keyPoints");
  assert.strictEqual(classify("Conclusion"), "conclusion");
  // Chinese aliases — without these, a translated heading becomes "other" and
  // selecting the "Conclusion" style shows the whole answer instead.
  assert.strictEqual(classify("详细回答"), "detailed");
  assert.strictEqual(classify("关键点"), "keyPoints");
  assert.strictEqual(classify("结论"), "conclusion");
  assert.strictEqual(classify("结论与建议"), "conclusion");
  // Case/whitespace tolerance must survive.
  assert.strictEqual(classify("  conclusion  "), "conclusion");
  // Anything genuinely different is still "other".
  assert.strictEqual(classify("Random Heading"), "other");
});

test("every style can still find the section it needs in both languages", () => {
  const { SECTION_IDS } = loadClientClassifier();
  // sectionsForStyle() looks sections up by id, so each id must be reachable
  // from at least one Chinese heading too — otherwise a Chinese answer has no
  // "conclusion" to show.
  for (const id of ["detailed", "keyPoints", "conclusion"]) {
    const cn = Object.entries(SECTION_IDS).filter(([, v]) => v === id);
    assert.ok(cn.length >= 2, `"${id}" must be reachable from more than just the English heading`);
  }
});

// === Full-width citation brackets (2026-09-25) ==============================
// Chinese models routinely write 【A1】 instead of [A1]. Everything downstream —
// the citation gate, the invalid-id strip, the browser's chip renderer — matches
// ASCII brackets, so a well-cited answer scored ZERO citations and was replaced
// by the extractive evidence dump.

test('normaliseCitations folds full-width brackets back to ASCII', () => {
  assert.strictEqual(engine.normaliseCitations('结论【A1】'), '结论[A1]');
  assert.strictEqual(engine.normaliseCitations('混合［W2］与【S1】'), '混合[W2]与[S1]');
  // Already-correct text is untouched.
  assert.strictEqual(engine.normaliseCitations('结论 [A1]'), '结论 [A1]');
});

test('the citation gate accepts a full-width-bracket answer once normalised', () => {
  const evidence = [{ id: 'A1' }, { id: 'W1' }, { id: 'S2' }];
  const withFullWidth = '腾讯面临监管风险【A1】，供应链风险【W1】。';
  // THE BUG: unnormalised this scores zero and falls back to the extractive dump.
  assert.strictEqual(engine.evaluateCitationGate(withFullWidth, evidence).pass, false);
  assert.strictEqual(engine.evaluateCitationGate(engine.normaliseCitations(withFullWidth), evidence).pass, true);
});

test('the browser renders full-width citations as chips too', () => {
  // The server folds these before storing, but cached/older answers still carry
  // them, and without this they render as inert text. It must come from the
  // SHARED module (lib/text-cjk.js) rather than a private copy.
  assert.ok(/TEXT_CJK\.foldBrackets/.test(APP_JS), 'parseAnswer must fold via the shared module');
  assert.ok(!/u3010/.test(APP_JS), 'and must not keep its own bracket regex');
});

test('the model generation path normalises before the gate inspects it', () => {
  assert.ok(
    /let answer = normaliseCitations\(rawAnswer\)/.test(
      require('fs').readFileSync(require('path').join(__dirname, '..', 'summarise-engine.js'), 'utf8')
    ),
    'rawAnswer must be normalised before citation counting'
  );
});

test('the zh-CN directive forbids a conclusion written as an instruction list', () => {
  const zh = engine.applyLanguageInstruction('BASE', 'zh-CN');
  // The observed output read as a chain of imperatives ("应加强…、完善…、关注…").
  assert.ok(zh.includes('指令清单'), 'must ban the instruction-list style');
  assert.ok(zh.includes('陈述性'), 'and require a declarative conclusion');
  // The earlier rules must survive the edit.
  assert.ok(zh.includes('## Conclusion'), 'English headings still required');
});

test('the gate fallback keeps the chosen style and language', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'summarise-engine.js'), 'utf8');
  // Previously this dropped both, so a failed model silently gave you the full
  // English answer regardless of what you asked for.
  assert.ok(
    /return buildExtractiveAnswer\(question, evidence, style, lang\);/.test(src),
    'the gate fallback must pass style and lang'
  );
});
