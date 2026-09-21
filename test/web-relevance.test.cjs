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

// === CJK bigram matching (2026-09-21) ======================================
// The previous fix matched whole Han RUNS, which only fire when the result
// contains the same contiguous phrase — i.e. near-duplicate text. Real Chinese
// questions produced long runs that matched essentially nothing.
//
// IMPORTANT: these cases must be PURE Chinese. The corpus tokenizer keeps short
// Latin tokens like "ai"/"eu"/"uk"/"vr", so a question containing "AI" gets a
// Latin match and would pass even with CJK matching entirely broken — which is
// exactly how the original bug hid from the spaced-Chinese tests above.
// Verified by mutation: with the old run-based code, the pure-CJK case returns
// []; with bigrams it returns the relevant result.

test('cjkBigrams produces sliding character pairs', () => {
  const bg = engine.cjkBigrams('腾讯游戏');
  assert.ok(bg.has('腾讯'), '腾讯');
  assert.ok(bg.has('讯游'), '讯游');
  assert.ok(bg.has('游戏'), '游戏');
  // Latin text yields nothing — CJK matching must not interfere with English.
  assert.strictEqual(engine.cjkBigrams('Tencent gaming').size, 0);
});

test('a pure-Chinese question keeps a result that phrases it differently', () => {
  const question = '腾讯的游戏战略是什么';   // deliberately no Latin letters
  const results = [
    { title: '腾讯游戏战略分析', description: '腾讯在游戏领域的布局与战略方向', url: 'https://cn-good.example' },
    { title: '今日天气', description: '明天会下雨，记得带伞', url: 'https://cn-bad.example' },
  ];
  const out = engine.webResultRelevance(question, results, 5);
  assert.ok(
    out.some(r => r.url === 'https://cn-good.example'),
    'a relevant Chinese result must survive even when worded differently'
  );
  assert.ok(
    !out.some(r => r.url === 'https://cn-bad.example'),
    'an unrelated Chinese result must still be dropped'
  );
});

test('bigram matching still drops unrelated Chinese results (no over-matching)', () => {
  const question = '欧盟人工智能法案对游戏公司的影响';
  const results = [
    { title: '今日菜谱推荐', description: '红烧肉的做法与技巧分享', url: 'https://food.example' },
    { title: '欧盟人工智能法案要点', description: '该法案对人工智能系统的合规要求', url: 'https://eu.example' },
  ];
  const out = engine.webResultRelevance(question, results, 5);
  assert.ok(out.some(r => r.url === 'https://eu.example'), 'on-topic result kept');
  assert.ok(!out.some(r => r.url === 'https://food.example'), 'off-topic result dropped');
});

test('a mixed Chinese/Latin question works via either branch', () => {
  const question = 'EU AI Act 对游戏工作室的合规要求';
  const results = [
    { title: 'EU AI Act compliance for studios', description: 'What game studios must do under the EU AI Act', url: 'https://lat.example' },
    { title: '游戏工作室合规指南', description: '欧盟AI法案下的游戏工作室义务', url: 'https://mix.example' },
    { title: 'Random blog', description: 'nothing to do with anything', url: 'https://no.example' },
  ];
  const urls = engine.webResultRelevance(question, results, 5).map(r => r.url);
  assert.ok(urls.includes('https://lat.example'), 'Latin match still works');
  assert.ok(urls.includes('https://mix.example'), 'CJK match works');
  assert.ok(!urls.includes('https://no.example'), 'irrelevant dropped');
});

test('relevant Chinese results outrank weakly related ones', () => {
  const question = '腾讯的游戏战略是什么';
  const results = [
    { title: '略有关联', description: '游戏行业动态', url: 'https://weak.example' },
    { title: '腾讯游戏战略分析', description: '腾讯在游戏领域的布局与战略方向', url: 'https://strong.example' },
  ];
  const out = engine.webResultRelevance(question, results, 5);
  assert.ok(out.length >= 1, 'something survives');
  assert.strictEqual(out[0].url, 'https://strong.example', 'the stronger match ranks first');
});
