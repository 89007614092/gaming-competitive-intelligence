'use strict';

// PR #90 — verify the in-language Q&A directive is appended (and only appended)
// when the UI language is Simplified Chinese, without disturbing the base
// prompt used for English. This is the LLM half of the Hybrid strategy:
// the existing model answers in-language, reusing the already-approved trust
// boundary (no extra translate step, no new data processor).

// Configure the model layer before requiring (constants are read at load).
process.env.OPEN_MODEL_API_KEY = 'test-key';
process.env.OPEN_MODEL_BASE_URL = 'http://localhost:9/v1';
process.env.OPEN_MODEL_NAME = 'openai/gpt-oss-120b';

const { test } = require('node:test');
const assert = require('node:assert');
const engine = require('../summarise-engine');

const BASE = 'You are a senior evidence-focused research analyst. Cite [A1] and [W2].';

test('applyLanguageInstruction is a no-op for English', () => {
  assert.strictEqual(engine.applyLanguageInstruction(BASE, 'en'), BASE);
  // Default arg also yields the base unchanged.
  assert.strictEqual(engine.applyLanguageInstruction(BASE), BASE);
  // Any non-zh-CN value is treated as English.
  assert.strictEqual(engine.applyLanguageInstruction(BASE, 'fr'), BASE);
});

test('applyLanguageInstruction appends a Simplified-Chinese directive for zh-CN', () => {
  const out = engine.applyLanguageInstruction(BASE, 'zh-CN');
  // Base prompt preserved in full (prepended, not replaced).
  assert.ok(out.startsWith(BASE));
  assert.strictEqual(out.length, BASE.length + (out.length - BASE.length));
  // The directive asks for Simplified Chinese.
  assert.ok(out.includes('Simplified Chinese') || out.includes('简体中文'));
  // And explicitly protects citation chips + placeholders (fidelity).
  assert.ok(out.includes('[A#]') && out.includes('[W#]') && out.includes('[S#]') && out.includes('[T#]'));
  assert.ok(out.includes('{placeholder}'));
  // The base prompt's own chip is still present (not double-counted as directive).
  assert.ok(out.includes('[A1]') && out.includes('[W2]'));
});

test('applyLanguageInstruction does not mutate the input string', () => {
  const before = BASE;
  engine.applyLanguageInstruction(before, 'zh-CN');
  assert.strictEqual(before, BASE);
});

test('zh-CN directive mandates structure and forbids English code-switching', () => {
  const out = engine.applyLanguageInstruction(BASE, 'zh-CN');
  // Structured answer required (detailed answer / key points / conclusion).
  assert.ok(out.includes('详细回答') && out.includes('结论'));
  // Explicitly warns against mixing in English connectives (e.g. "however").
  assert.ok(out.includes('however'));
  // Language marker retained for the existing token-presence assertion.
  assert.ok(out.includes('简体中文') || out.includes('Simplified Chinese'));
});
