'use strict';

// Unit tests for lib/patentsSource.js — pure parsing/normalisation/merge logic.
// No network calls: refreshPatents/primePatentsFromDb/getPatents are exercised
// indirectly via mergeRecords + the parser functions only.

const test = require('node:test');
const assert = require('node:assert');
const ps = require('../lib/patentsSource');

test('normalizeCompany strips suffixes and lowercases', () => {
  assert.strictEqual(ps.normalizeCompany('Epic Games Inc.'), 'epic games');
  assert.strictEqual(ps.normalizeCompany('Microsoft Corporation'), 'microsoft');
  assert.strictEqual(ps.normalizeCompany('Tencent Holdings Ltd'), 'tencent');
  assert.strictEqual(ps.normalizeCompany('  UBISOFT  '), 'ubisoft');
  assert.strictEqual(ps.normalizeCompany(null), '');
});

test('titleFromSlug derives a readable title', () => {
  assert.strictEqual(ps.titleFromSlug('12345-foo-bar-patent'), 'Foo Bar Patent');
  assert.strictEqual(ps.titleFromSlug('abc-realtime-character-animation'), 'Realtime Character Animation');
  assert.strictEqual(ps.titleFromSlug('nomarkers'), 'Nomarkers');
  assert.strictEqual(ps.titleFromSlug('x-sony-vr.html'), 'Sony Vr');
});

test('parseSitemap extracts and dedupes patent URLs', () => {
  const xml = `<?xml version="1.0"?>
  <urlset>
    <url><loc>https://futureofgaming.com/publications/patents/111-aaa</loc></url>
    <url><loc>https://futureofgaming.com/publications/patents/222-bbb</loc></url>
    <url><loc>https://futureofgaming.com/publications/patents/111-aaa</loc></url>
    <url><loc>https://futureofgaming.com/about</loc></url>
  </urlset>`;
  const urls = ps.parseSitemap(xml);
  assert.deepStrictEqual(urls, [
    'https://futureofgaming.com/publications/patents/111-aaa',
    'https://futureofgaming.com/publications/patents/222-bbb',
  ]);
});

test('parseAnchorBlock parses a single patent anchor', () => {
  const block = `<a class="grid-item" href="https://futureofgaming.com/publications/patents/999-sony-haptic-feedback">
    <div class="label">Sony Interactive Entertainment</div>
    <p>Published Date: Aug 20, 2026</p>
    <h3>Sony files haptic feedback patent for VR controllers</h3>
    <p>A short report on Sony's newly applied haptic patent.</p>
  </a>`;
  const rec = ps.parseAnchorBlock(block);
  assert.strictEqual(rec.id, '999-sony-haptic-feedback');
  assert.strictEqual(rec.company, 'Sony Interactive Entertainment');
  assert.strictEqual(rec.publishedDate, '2026-08-20');
  assert.strictEqual(rec.title, 'Sony files haptic feedback patent for VR controllers');
  assert.ok(rec.snippet.startsWith('A short report'));
  assert.strictEqual(rec.link, 'https://futureofgaming.com/publications/patents/999-sony-haptic-feedback');
});

test('parseAnchorBlock returns null without a patent href', () => {
  assert.strictEqual(ps.parseAnchorBlock('<a href="https://futureofgaming.com/about">About</a>'), null);
});

test('parsePatentsHtml parses multiple anchors but requires a title or company', () => {
  const html = `
    <a href="https://futureofgaming.com/publications/patents/1-aaa"><h3>Title A</h3><div class="label">Acme</div></a>
    <a href="https://futureofgaming.com/publications/patents/2-bbb"><p>No title here</p></a>
    <a href="https://futureofgaming.com/about">Skip me</a>`;
  const recs = ps.parsePatentsHtml(html);
  assert.strictEqual(recs.length, 1);
  assert.strictEqual(recs[0].company, 'Acme');
  assert.strictEqual(recs[0].title, 'Title A');
});

test('mergeRecords merges recent over catalog by id and preserves fromCatalog', () => {
  const catalog = [
    { id: '1-aaa', company: null, title: 'Aaa Slug', snippet: null, publishedDate: null, link: 'https://futureofgaming.com/publications/patents/1-aaa', fromCatalog: true },
    { id: '2-bbb', company: null, title: 'Bbb Slug', snippet: null, publishedDate: null, link: 'https://futureofgaming.com/publications/patents/2-bbb', fromCatalog: true },
  ];
  const recent = [
    { id: '1-aaa', company: 'Acme Corp', title: 'Real Title', snippet: 'Snip', publishedDate: '2026-08-01', link: 'https://futureofgaming.com/publications/patents/1-aaa' },
  ];
  const merged = ps.mergeRecords(recent, catalog);
  assert.strictEqual(merged.length, 2);
  const one = merged.find((r) => r.id === '1-aaa');
  assert.strictEqual(one.title, 'Real Title');
  assert.strictEqual(one.company, 'Acme Corp');
  assert.strictEqual(one.fromCatalog, true); // preserved from catalog
  const two = merged.find((r) => r.id === '2-bbb');
  assert.strictEqual(two.title, 'Bbb Slug');
});
