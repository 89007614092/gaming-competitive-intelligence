"use strict";

// The extractive fallback is what a reader gets when the AI model throws. It is
// not a rare path — it is the difference between "the app answered" and "the app
// dumped a list of sources at me and called it an answer".
//
// Two things are asserted here:
//   1. its Conclusion is a real conclusion, not one line of coverage metadata
//   2. it is localised, so a Chinese answer does not end in English

process.env.OPEN_MODEL_API_KEY = "test-key";
process.env.OPEN_MODEL_BASE_URL = "http://localhost:9/v1";
process.env.OPEN_MODEL_NAME = "openai/gpt-oss-120b";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const engine = require("../summarise-engine.js");
const APP_JS = fs.readFileSync(path.join(__dirname, "..", "public", "app.js"), "utf8");

function evidence(n = 4) {
  const items = [];
  for (let i = 1; i <= n; i += 1) {
    items.push({
      id: `A${i}`,
      sourceType: "application",
      dataset: "Knowledge Base",
      title: `Risk factor ${i}`,
      text: `This is a substantive sentence about risk factor ${i} and how it affects studios in practice today. `.repeat(4),
    });
  }
  return items;
}

const conclusionOf = (answer) => {
  const m = /## Conclusion\n([\s\S]*)$/.exec(answer);
  return m ? m[1].trim() : "";
};

test("the fallback conclusion is more than one line of metadata", () => {
  const answer = engine.buildExtractiveAnswer("What are the main risks?", evidence(), "full", "en");
  const conclusion = conclusionOf(answer);
  assert.ok(conclusion, "a Conclusion section must exist");
  // THE BUG: this was a single sentence ("Based on N records, the evidence above
  // covers the main aspects of ..."), which made the whole Conclusion view useless.
  assert.ok(
    conclusion.length > 200,
    `conclusion must carry substance, got ${conclusion.length} chars`
  );
  // Substance comes from cited evidence, never from invention.
  assert.ok(/\[A\d+\]/.test(conclusion), "the conclusion must cite its sources");
});

test("the standalone Conclusion view is self-contained, not just a coverage note", () => {
  const answer = engine.buildExtractiveAnswer("What are the main risks?", evidence(), "conclusion", "en");
  assert.ok(answer.includes("## Conclusion"));
  assert.ok(answer.length > 200, "the only thing the reader sees must be substantial");
  assert.ok(/\[A\d+\]/.test(answer), "and cited");
});

test("the fallback says plainly that this is not an AI synthesis", () => {
  const answer = engine.buildExtractiveAnswer("What are the main risks?", evidence(), "full", "en");
  assert.ok(
    /AI model was unavailable/i.test(conclusionOf(answer)),
    "the reader must not mistake an evidence dump for an AI answer"
  );
});

test("a Chinese fallback is written in Chinese", () => {
  const answer = engine.buildExtractiveAnswer("腾讯的风险有哪些？", evidence(), "full", "zh-CN");
  const conclusion = conclusionOf(answer);
  // THE BUG: the coverage note was hardcoded English, so a Chinese answer ended
  // in English.
  assert.ok(/[一-鿿]/.test(conclusion), "the Chinese conclusion must contain Chinese");
  assert.ok(!/Based on \d+ curated application record/.test(conclusion), "no English coverage note");
  assert.ok(/AI 模型/.test(conclusion), "and must disclose the fallback in Chinese");
});

test("English is unaffected by the Chinese wording", () => {
  const answer = engine.buildExtractiveAnswer("What are the main risks?", evidence(), "full", "en");
  assert.ok(!/[一-鿿]/.test(conclusionOf(answer)), "no Chinese leaking into English");
});

test("thin evidence is disclosed rather than padded out", () => {
  const answer = engine.buildExtractiveAnswer("Obscure question?", evidence(1), "full", "en");
  const conclusion = conclusionOf(answer);
  assert.ok(/limited/i.test(conclusion), "must say the evidence is thin");
});

// --- degraded-mode notice (item 3) -------------------------------------------

test("a model failure is shown differently from simply not opting in", () => {
  // A failure must be visually distinct, not the same amber box that shows for
  // the ordinary extractive mode — otherwise it is invisible in practice.
  assert.ok(
    /warning\.className = degraded \? "summary-warning is-degraded" : "summary-warning"/.test(APP_JS),
    "the degraded state must carry its own class"
  );
  assert.ok(
    /\.summary-warning\.is-degraded/.test(fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8")),
    "and that class must actually be styled"
  );
});

test("the degraded notice explains WHY, from the server's own error", () => {
  assert.ok(
    /degraded && data\.model\?\.error/.test(APP_JS),
    "the server's model.error must be surfaced, not swallowed"
  );
});

test("the notices are translated, not English-only", () => {
  const { LOCALES } = require("../public/locales.js");
  for (const key of ["qa.tier.notice", "qa.degraded.notice", "qa.degraded.reason"]) {
    assert.ok(LOCALES.en[key], `${key} missing in en`);
    assert.ok(LOCALES["zh-CN"][key], `${key} missing in zh-CN`);
    assert.notStrictEqual(LOCALES["zh-CN"][key], LOCALES.en[key], `${key} is untranslated`);
  }
  for (const key of ["qa.tier.notice", "qa.degraded.notice"]) {
    assert.ok(APP_JS.includes(`tQa("${key}"`), `app.js must use the ${key} string`);
  }
});

// --- CJK sentence handling ---------------------------------------------------
// Needed to make the above actually work: text was split into sentences on
// Latin-only terminators, so a Chinese passage was ONE "sentence", and the
// sentence-length floor (40 chars) was an English figure that discarded almost
// every ordinary Chinese sentence.

test("Chinese evidence is split into sentences, not treated as one block", () => {
  const items = [1, 2, 3].map(i => ({
    id: `A${i}`,
    sourceType: "application",
    dataset: "Knowledge Base",
    title: `风险因素${i}`,
    text: `腾讯面临合规风险，需要建立水印机制。第${i}项风险涉及内容标注与溯源要求。监管罚款最高可达营业额的百分之三。`,
  }));
  const answer = engine.buildExtractiveAnswer("腾讯的风险有哪些？", items, "full", "zh-CN");
  const conclusion = conclusionOf(answer);
  // Three distinct cited sentences, not one run-on excerpt.
  const citations = conclusion.match(/\[A\d+\]/g) || [];
  assert.ok(citations.length >= 3, `expected several cited sentences, got ${citations.length}`);
  assert.ok(/水印机制/.test(conclusion), "must contain short Chinese sentences");
});

test("the sentence-length floor does not silently discard Chinese sentences", () => {
  // A ~28-character Chinese sentence is perfectly quotable but was dropped by
  // the English-tuned 40-character floor.
  const items = [{
    id: "A1",
    sourceType: "application",
    dataset: "Knowledge Base",
    title: "内容标注",
    // Three short Chinese sentences (12-22 chars each) — long enough to count
    // as evidence, but each sentence is far below the English floor.
    text: "生成式媒体必须被明确标识。违规者将面临高额罚款。合规框架要求可见标注、不可见水印和加密元数据。",
  }];
  const answer = engine.buildExtractiveAnswer("内容标注要求是什么？", items, "full", "zh-CN");
  assert.ok(/\[A1\]/.test(conclusionOf(answer)), "short Chinese sentences must survive");
});

test("English sentence handling is unchanged", () => {
  const items = [{
    id: "A1",
    sourceType: "application",
    dataset: "KB",
    title: "Risk one",
    text: "Studios face compliance risk and must implement watermarking. Regulators can fine up to three percent of turnover. Provenance metadata is required too.",
  }];
  const answer = engine.buildExtractiveAnswer("What are the main risks?", items, "full", "en");
  const citations = conclusionOf(answer).match(/\[A1\]/g) || [];
  assert.ok(citations.length >= 2, "English still yields multiple sentences");
});

// === Fallback quality, round two (2026-09-25) ==============================
// A deployed run fell back to extractive and exposed two things I had missed.

test('the fallback opening line is localised, not hardcoded English', () => {
  // NB: an item only counts as usable evidence at >= 40 chars, so the text must
  // be long enough or the function returns its no-evidence message instead.
  const items = [1, 2, 3].map(i => ({
    id: `A${i}`, sourceType: 'application', dataset: 'KB', title: `风险${i}`,
    text: `腾讯在游戏业务中面临监管合规与内容标注风险，需要建立水印与溯源机制。第${i}项说明补充内容在这里。`,
  }));
  const zh = engine.buildExtractiveAnswer('腾讯最可能面临的风险有哪些？', items, 'full', 'zh-CN');
  const en = engine.buildExtractiveAnswer('What are the risks?', items, 'full', 'en');
  // THE BUG: a Chinese answer opened with "Here is what the curated evidence shows…".
  assert.ok(!/Here is what the curated evidence shows/.test(zh), 'no English opening in Chinese');
  assert.ok(/以下是策展证据中关于/.test(zh), 'a Chinese opening instead');
  assert.ok(/Here is what the curated evidence shows/.test(en), 'English keeps its own wording');
});

test('Key Points rank by relevance in Chinese, not by document order', () => {
  // Every Chinese sentence scored 0 because scoring used Latin tokens only, so
  // the ranking was meaningless and a PDF glossary fragment topped the list.
  const items = [{
    id: 'A1',
    sourceType: 'application',
    dataset: 'KB',
    title: '风险',
    text: '风险承受度是指组织愿意承担的风险程度。腾讯在游戏业务中面临监管合规与内容标注风险，需要建立水印机制。',
  }];
  const out = engine.buildExtractiveAnswer('腾讯最可能面临的风险有哪些？', [items[0]], 'full', 'zh-CN');
  const kp = out.split('## Key Points')[1].split('## Conclusion')[0];
  const first = kp.trim().split('\n')[0];
  assert.ok(/腾讯/.test(first), `the Tencent-specific sentence must rank first, got: ${first}`);
});
