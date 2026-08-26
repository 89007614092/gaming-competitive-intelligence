'use strict';

// Regression tests for webResultRelevance (the web-source relevance filter).
// Guards the language fix: a Simplified-Chinese question must retain relevant
// (Chinese-language) web hits instead of being silently emptied by the
// Latin-only tokenizer.

process.env.OPEN_MODEL_API_KEY = 'test-key';
process.env.OPEN_MODEL_BASE_URL = 'http://localhost:9/v1';
process.env.OPEN_MODEL_NAME = 'openai/gpt-oss-120b';

const { test } = require('node:test');
const assert = require('node:assert');
const engine = require('../summarise-engine');

test('Chinese query retains relevant CJK web results (language fix)', () => {
  const question = '游戏 监管';
  const results = [
    { title: '网络游戏监管办法', description: '关于游戏监管的新规定', url: 'https://c1.example' },
    { title: 'The cat sat', description: 'a dog ran', url: 'https://c2.example' },
  ];
  const out = engine.webResultRelevance(question, results, 5);
  assert.strictEqual(out.length, 1, 'off-topic English result must be dropped');
  assert.strictEqual(out[0].url, 'https://c1.example', 'relevant CJK result must be kept');
});

test('Chinese query with no relevant hits returns an empty set (not junk)', () => {
  const question = '量子计算 芯片';
  const results = [
    { title: 'The cat sat', description: 'a dog ran', url: 'https://x.example' },
  ];
  const out = engine.webResultRelevance(question, results, 5);
  assert.strictEqual(out.length, 0, 'no CJK overlap => empty, not retained');
});

test('English query still drops definition/dictionary junk (no regression)', () => {
  const question = 'compare machine learning frameworks';
  const results = [
    { title: 'TensorFlow vs PyTorch', description: 'deep learning framework comparison', url: 'https://good.example' },
    { title: 'Compare | Definition of Compare', description: 'Merriam-Webster dictionary meaning', url: 'https://dict.example' },
  ];
  const out = engine.webResultRelevance(question, results, 5);
  const urls = out.map(r => r.url);
  assert.ok(urls.includes('https://good.example'), 'relevant result retained');
  assert.ok(!urls.includes('https://dict.example'), 'dictionary definition dropped');
});
