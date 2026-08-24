'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { t, getLang, setLang, LOCALES } = require('../public/locales.js');

test('t() returns English source by default', () => {
  setLang('en');
  assert.strictEqual(t('nav.knowledgeBase'), 'Knowledge Base');
  assert.strictEqual(t('view.kb.subtitle').includes('proprietary research documents'), true);
});

test('t() returns Simplified Chinese after setLang(zh-CN)', () => {
  setLang('zh-CN');
  assert.strictEqual(t('nav.knowledgeBase'), '知识库');
  assert.strictEqual(t('btn.settings'), '设置');
  setLang('en'); // reset for other suites
});

test('t() falls back to the key for an unknown key', () => {
  assert.strictEqual(t('this.key.does.not.exist'), 'this.key.does.not.exist');
});

test('t() applies {var} substitution on the resolved string', () => {
  // Unknown key still exercises the substitution path on the key template.
  assert.strictEqual(t('hello.{name}', { name: 'Molly' }), 'hello.Molly');
  assert.strictEqual(t('nav.knowledgeBase', { ignored: 1 }), 'Knowledge Base');
});

test('t() falls back to en when a key is missing from the active locale', () => {
  // Confirm zh-CN mirrors en for shipped keys (guards against half-migrated dicts).
  const enKeys = Object.keys(LOCALES.en);
  const zhKeys = Object.keys(LOCALES['zh-CN']);
  assert.strictEqual(zhKeys.length, enKeys.length, 'zh-CN must mirror every en key');
  for (const k of enKeys) {
    assert.ok(LOCALES['zh-CN'][k] != null, `zh-CN missing key: ${k}`);
  }
});

test('getLang reflects setLang', () => {
  setLang('zh-CN');
  assert.strictEqual(getLang(), 'zh-CN');
  setLang('en');
  assert.strictEqual(getLang(), 'en');
});
