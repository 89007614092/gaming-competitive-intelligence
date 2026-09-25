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
  assert.ok(
    /TEXT_CJK\.normaliseCitations/.test(APP_JS),
    'parseAnswer must normalise citations via the shared module'
  );
  assert.ok(!/u3010/.test(APP_JS), 'and must not keep its own bracket regex');
  // The "not cited" badge must judge the same normalised text, or it contradicts
  // what the reader can see.
  assert.ok(
    /lastAnswerText = \(window\.TEXT_CJK \|\| \{\}\)\.normaliseCitations/.test(APP_JS),
    'the not-cited badge must use the normalised answer'
  );
});

test('a run of citations is bracketed, not just its first id', () => {
  const t = require('../lib/text-cjk.js');
  // Models habitually write "[A1]A7" — only the first id resolves.
  assert.strictEqual(t.normaliseCitations('罚款[A1]A7。'), '罚款[A1][A7]。');
  assert.strictEqual(t.normaliseCitations('[S2]S3'), '[S2][S3]');
  assert.strictEqual(t.normaliseCitations('[A1]A7W2S1'), '[A1][A7][W2][S1]');
  // Full-width plus a run, together.
  assert.strictEqual(t.normaliseCitations('【A1】A7'), '[A1][A7]');
  // Prose containing a capital letter must be left alone.
  assert.strictEqual(t.normaliseCitations('[A1] and A7'), '[A1] and A7');
});

test('the model generation path normalises, and brackets known ids, before the gate', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'summarise-engine.js'), 'utf8');
  // Fold bracket variants AND bracket bare ids we issued, before citation counting.
  assert.ok(
    /bracketKnownIds\(normaliseCitations\(rawAnswer\), validCitationIds\)/.test(src),
    'rawAnswer must be normalised and known ids bracketed before citation counting'
  );
});

test('bare ids count as citations once they are known ids', () => {
  const t = require('../lib/text-cjk.js');
  const ev = new Set(['A1', 'W1']);
  // "风险A1" previously scored as citing nothing at all.
  const normalised = t.bracketKnownIds(t.normaliseCitations('腾讯面临监管风险A1与网络安全风险W1。'), ev);
  assert.ok(/\[A1\]/.test(normalised) && /\[W1\]/.test(normalised), 'known bare ids must be bracketed');
  assert.strictEqual(engine.evaluateCitationGate(normalised, [{ id: 'A1' }, { id: 'W1' }]).pass, true);
  // An id we never issued must be left as prose.
  assert.ok(!/\[X9\]/.test(t.bracketKnownIds('型号X9芯片', ev)), 'unknown ids must not be bracketed');
});

test('a gate failure is loud, not a silent substitution', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'summarise-engine.js'), 'utf8');
  // The old code RETURNED the extractive dump, so server.js never entered its
  // catch: mode stayed "local-open-source-model" and the UI claimed "AI model"
  // while showing a dump, with no error anywhere.
  assert.ok(!/if \(gate\.pass\) return answer;\s*\n\s*return buildExtractiveAnswer/.test(src),
    'the gate must not silently substitute the dump');
  assert.ok(/citation gate failed/.test(src), 'the cause must be logged');
  assert.ok(/throw new Error\("The model answered but cited no usable sources/.test(src),
    'and it must fail so the degradation is visible');
});

test('the zh-CN directive forbids a conclusion written as an instruction list', () => {
  const zh = engine.applyLanguageInstruction('BASE', 'zh-CN');
  // The observed output read as a chain of imperatives ("应加强…、完善…、关注…").
  assert.ok(zh.includes('指令清单'), 'must ban the instruction-list style');
  assert.ok(zh.includes('陈述性'), 'and require a declarative conclusion');
  // The earlier rules must survive the edit.
  assert.ok(zh.includes('## Conclusion'), 'English headings still required');
});

test('when the model path fails, the fallback keeps the chosen style and language', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  // The gate now throws, so this runs in the catch. It must still pass style and
  // lang — previously it dropped both, silently giving the full English answer.
  assert.ok(
    /buildExtractiveAnswer\(question, evidence, style, lang\)/.test(src),
    'the fallback must pass style and lang'
  );
});

// === Citation discipline + observability (2026-09-25) ========================
// A real answer stated the Joey Wong / AI-likeness claim with NO citation, and
// one Key Point repeated it uncited, even though the source was retrieved.

test('the prompt requires a citation in every paragraph and bullet', () => {
  const base = require('fs').readFileSync(require('path').join(__dirname, '..', 'summarise-engine.js'), 'utf8');
  assert.ok(base.includes('CITATION DISCIPLINE'), 'the base prompt must state the rule');
  // ...and forbid force-citing, which is the failure mode of over-constraining.
  assert.ok(/do NOT force-cite a source that does not bear on it/.test(base), 'must forbid force-citing');
});

test('the Chinese directive repeats the citation rule in Chinese', () => {
  const zh = engine.applyLanguageInstruction('BASE', 'zh-CN');
  assert.ok(zh.includes('每一段正文与每一条要点都必须带至少一个引用标记'), 'zh rule present');
  assert.ok(zh.includes('不得裸述'), 'must forbid uncited claims');
  assert.ok(zh.includes('不得为凑引用而引用无关的出处'), 'and forbid force-citing');
});

test('uncitedSegments finds claims made with no citation', () => {
  const answer = [
    '## Detailed Answer',
    '腾讯面临监管风险[A1]。',
    '这一段完全没有引用。',
    '- 有引用的要点 [S2]',
    '- 没有引用的要点',
  ].join('\n');
  const found = engine.uncitedSegments(answer);
  assert.deepStrictEqual(found, ['这一段完全没有引用。']);
});

test('uncitedSegments ignores headings and cited lines', () => {
  const answer = '## Key Points\n- 全部都有引用 [A1] [W2]\n## Conclusion\n结论也有引用 [T2]';
  assert.strictEqual(engine.uncitedSegments(answer).length, 0, 'nothing should be flagged');
});

test('uncitedSegments is observability only, never enforcement', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'summarise-engine.js'), 'utf8');
  assert.ok(/console\.warn\(`\[qa\] \$\{uncited\.length\}/.test(src), 'it must log');
  // It must NOT throw or reject an answer — a noisy answer still beats none.
  assert.ok(!/if \(uncited\.length\) throw/.test(src), 'and must never reject the answer');
});

test('unknown citation ids are stripped, and that is logged', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'summarise-engine.js'), 'utf8');
  assert.ok(/strippedIds/.test(src), 'invalid ids must be removed, not shown to the reader');
  assert.ok(/console\.warn\(`\[qa\] stripped/.test(src), 'and the removal must be visible in logs');
});
