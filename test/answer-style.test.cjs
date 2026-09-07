'use strict';

// Answer style (full | detailed | bullets | conclusion) — the reader's choice now
// reaches the model so it emits ONLY the sections that view needs. Before this,
// the model always produced all three sections and the client discarded two, so
// "Short conclusion" showed only a wrap-up that restated the question.

// Configure the model layer before requiring (constants are read at load).
process.env.OPEN_MODEL_API_KEY = 'test-key';
process.env.OPEN_MODEL_BASE_URL = 'http://localhost:9/v1';
process.env.OPEN_MODEL_NAME = 'openai/gpt-oss-120b';

const { test } = require('node:test');
const assert = require('node:assert');
const engine = require('../summarise-engine');

const BASE = 'You are a senior evidence-focused research analyst. Cite [A1] and [W2].';

// --- applyStyleInstruction ---------------------------------------------------
test('applyStyleInstruction is a no-op for "full" (the default)', () => {
  assert.strictEqual(engine.applyStyleInstruction(BASE, 'full'), BASE);
  assert.strictEqual(engine.applyStyleInstruction(BASE), BASE);
});

test('applyStyleInstruction ignores unknown styles instead of injecting them', () => {
  // Guards the prompt: an unexpected value must never reach the system prompt.
  for (const bad of ['nonsense', '', null, undefined, 'FULL', '<script>']) {
    assert.strictEqual(engine.applyStyleInstruction(BASE, bad), BASE, `${bad} must not inject`);
  }
});

test('applyStyleInstruction appends (never replaces) and keeps the base intact', () => {
  const out = engine.applyStyleInstruction(BASE, 'conclusion');
  assert.ok(out.startsWith(BASE));
  assert.ok(out.length > BASE.length);
  assert.ok(out.includes('[A1]') && out.includes('[W2]'), 'base content preserved');
});

test('each narrow style names exactly the sections it should emit', () => {
  const detailed = engine.applyStyleInstruction(BASE, 'detailed');
  assert.ok(detailed.includes('## Detailed Answer') && detailed.includes('## Conclusion'));
  assert.ok(detailed.includes('Do NOT emit "## Key Points"'));

  const bullets = engine.applyStyleInstruction(BASE, 'bullets');
  assert.ok(bullets.includes('## Key Points'));
  assert.ok(bullets.includes('Do NOT emit "## Detailed Answer"'));

  const conclusion = engine.applyStyleInstruction(BASE, 'conclusion');
  assert.ok(conclusion.includes('## Conclusion'));
  assert.ok(conclusion.includes('ONLY section the reader will see'));
});

test('the style directive overrides the base three-section rule', () => {
  // The base prompt says "EXACTLY these three sections"; a narrow style must win.
  for (const s of ['detailed', 'bullets', 'conclusion']) {
    const out = engine.applyStyleInstruction(BASE, s);
    assert.ok(/THIS instruction takes precedence/.test(out), `${s} must override`);
  }
});

test('style is applied AFTER language so it can override the zh-CN 3-part mandate', () => {
  // The zh-CN directive says "at least include the three parts"
  // (详细回答 / 关键点 / 结论); selecting a narrow style must still win.
  const withLang = engine.applyLanguageInstruction(BASE, 'zh-CN');
  const both = engine.applyStyleInstruction(withLang, 'conclusion');
  assert.ok(both.includes('详细回答'), 'language directive still present');
  assert.ok(both.includes('Emit ONLY'), 'style directive appended after it');
  assert.ok(both.indexOf('Emit ONLY') > both.indexOf('详细回答'), 'style comes later in the prompt');
});

test('normaliseStyle whitelists the four known styles', () => {
  for (const s of ['full', 'detailed', 'bullets', 'conclusion']) {
    assert.strictEqual(engine.normaliseStyle(s), s);
  }
  assert.strictEqual(engine.normaliseStyle('bogus'), 'full');
  assert.strictEqual(engine.normaliseStyle(undefined), 'full');
});

// --- extractive fallback -----------------------------------------------------
const QUESTION = 'are studios using generative AI for game characters?';
const evidence = (n = 4) =>
  Array.from({ length: n }, (_, i) => ({
    id: `A${i + 1}`,
    sourceType: 'application',
    title: `Source ${i + 1}`,
    text: `Studios are adopting generative AI for game characters. Evidence sentence ${i + 1} about adoption and tooling in production pipelines.`,
    excerpt: `Studios are adopting generative AI for game characters. Evidence sentence ${i + 1} about adoption and tooling.`,
  }));

test('buildExtractiveAnswer defaults to all three sections', () => {
  const out = engine.buildExtractiveAnswer(QUESTION, evidence());
  assert.ok(out.includes('## Detailed Answer'));
  assert.ok(out.includes('## Key Points'));
  assert.ok(out.includes('## Conclusion'));
});

test('buildExtractiveAnswer honours the conclusion style and stays substantial', () => {
  const out = engine.buildExtractiveAnswer(QUESTION, evidence(), 'conclusion');
  assert.ok(out.startsWith('## Conclusion'));
  assert.ok(!out.includes('## Detailed Answer'), 'no detailed section emitted');
  // The whole point of the change: a standalone conclusion must carry real
  // content (the extracted takeaways), not just a coverage note.
  assert.ok(out.length > 200, `conclusion must be substantial, got ${out.length} chars`);
  assert.ok(/\[A\d+\]/.test(out), 'takeaways must stay cited');
});

test('buildExtractiveAnswer honours bullets and detailed styles', () => {
  const bullets = engine.buildExtractiveAnswer(QUESTION, evidence(), 'bullets');
  assert.ok(bullets.startsWith('## Key Points'));
  assert.ok(!bullets.includes('## Detailed Answer'));

  const detailed = engine.buildExtractiveAnswer(QUESTION, evidence(), 'detailed');
  assert.ok(detailed.includes('## Detailed Answer'));
  assert.ok(detailed.includes('## Conclusion'));
  assert.ok(!detailed.includes('## Key Points'));
});

test('buildExtractiveAnswer treats an unknown style as full', () => {
  const out = engine.buildExtractiveAnswer(QUESTION, evidence(), 'bogus');
  assert.ok(out.includes('## Detailed Answer'));
  assert.ok(out.includes('## Key Points'));
  assert.ok(out.includes('## Conclusion'));
});
