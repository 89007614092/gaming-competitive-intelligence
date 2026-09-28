'use strict';
// Cached patent results must say HOW OLD they are.
//
// A bare "cached result" badge is ambiguous: it is meant to signal a deliberate
// 12h cache hit (the EPO quota guard), but it reads exactly like "the live call
// failed and we fell back to something old" — which is never what happened.
// These tests pin the freshness fields that disambiguate it.
//
// patentCacheMeta is pure and exported precisely because the DB-backed cache
// path cannot be exercised without a database.

process.env.EPO_OPS_KEY = process.env.EPO_OPS_KEY || 'test-consumer-key';
process.env.EPO_OPS_SECRET = process.env.EPO_OPS_SECRET || 'test-consumer-secret';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { patentCacheMeta, readPatentCacheWithAge } = require('../server');

const NOW = Date.parse('2026-09-28T12:00:00.000Z');

test('patentCacheMeta reports the age of an ISO timestamp', () => {
  const meta = patentCacheMeta('2026-09-28T11:00:00.000Z', NOW);
  assert.strictEqual(meta.cachedAt, '2026-09-28T11:00:00.000Z');
  assert.strictEqual(meta.cacheAgeMs, 60 * 60 * 1000);
});

test('patentCacheMeta accepts a Date object, which is what pg hands back', () => {
  const meta = patentCacheMeta(new Date('2026-09-28T09:00:00.000Z'), NOW);
  assert.strictEqual(meta.cacheAgeMs, 3 * 60 * 60 * 1000);
  assert.strictEqual(meta.cachedAt, '2026-09-28T09:00:00.000Z');
});

test('patentCacheMeta clamps a future timestamp to 0 instead of a negative age', () => {
  // Clock skew between Postgres and Node must never render "cached result · -3m".
  const meta = patentCacheMeta('2026-09-28T12:05:00.000Z', NOW);
  assert.strictEqual(meta.cacheAgeMs, 0);
});

test('patentCacheMeta returns nulls for a missing or unparseable timestamp', () => {
  for (const bad of [null, undefined, '', 'not-a-date', {}]) {
    const meta = patentCacheMeta(bad, NOW);
    assert.strictEqual(meta.cachedAt, null, `cachedAt for ${String(bad)}`);
    assert.strictEqual(meta.cacheAgeMs, null, `cacheAgeMs for ${String(bad)}`);
  }
});

test('readPatentCacheWithAge is exported alongside the payload-only reader', () => {
  assert.strictEqual(typeof readPatentCacheWithAge, 'function');
});

test('/api/patents serves the age with a cached hit (wiring guard)', () => {
  // The cached branch is not reachable in CI (no database), so pin the wiring in
  // source: a refactor that drops the age silently would otherwise pass.
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const route = src.slice(src.indexOf('app.get("/api/patents"'));
  const branch = route.slice(0, route.indexOf('epoClient.search'));
  assert.ok(branch.includes('readPatentCacheWithAge'), 'cached branch must use the age-aware reader');
  assert.ok(branch.includes('patentCacheMeta'), 'cached branch must attach the freshness fields');
  assert.ok(branch.includes('cached: true'), 'cached branch must still flag the hit');
});

test('the Patents view renders the age rather than a bare "cached"', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(src.includes('cacheAgeMs'), 'results header must read the age from the payload');
  assert.ok(src.includes('cachedAgo'), 'results header must render the aged label');
});

test('both dictionaries translate the cache-age strings', () => {
  const { t, getLang, setLang, LOCALES } = require('../public/locales.js');
  const keys = ['patents.cachedAgo', 'patents.ageNow', 'patents.ageMinutes', 'patents.ageHours', 'patents.ageDays', 'patents.fetchedAt'];
  for (const k of keys) {
    assert.ok(LOCALES.en && LOCALES.en[k] != null, `missing en: ${k}`);
    assert.ok(LOCALES['zh-CN'] && LOCALES['zh-CN'][k] != null, `missing zh-CN: ${k}`);
  }
  setLang('en');
  assert.strictEqual(t('patents.cachedAgo', { age: t('patents.ageHours', { n: 5 }) }), 'cached result · 5h ago');
  assert.strictEqual(t('patents.ageMinutes', { n: 45 }), '45m ago');
  setLang('zh-CN');
  assert.strictEqual(t('patents.cachedAgo', { age: t('patents.ageHours', { n: 5 }) }), '缓存结果 · 5 小时前');
  assert.strictEqual(t('patents.ageNow'), '刚刚');
  setLang('en'); // reset for other suites
});
