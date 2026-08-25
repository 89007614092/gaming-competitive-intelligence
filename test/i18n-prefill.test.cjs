'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const mt = require('../lib/mtService');
const prefill = require('../scripts/i18n-prefill.cjs');
const { LOCALES } = require('../public/locales.js');

// ---------------------------------------------------------------------------
// mtService fidelity layer (mask / restore / chip-count)
// ---------------------------------------------------------------------------
test('maskProtected hides chips and placeholders, restoreProtected recovers them', () => {
  const src = 'See [A1] and [W3] for {query} details';
  const { masked, tokens } = mt.maskProtected(src);
  // Masked text contains no visible citation chips or placeholders.
  assert.strictEqual(mt.countChips(masked), 0);
  assert.ok(!/\{query\}/.test(masked));
  // Restored text is byte-identical to the source.
  assert.strictEqual(mt.restoreProtected(masked, tokens), src);
});

test('countChips counts [A#]/[W#]/[S#]/[T#] only', () => {
  assert.strictEqual(mt.countChips('[A1][W2][S3][T4] plain [X9] not-a-chip'), 4);
  assert.strictEqual(mt.countChips('no chips here'), 0);
});

test('translateBatch falls back to source when no provider key is configured (no network)', async () => {
  // Ensure no keys are present for this assertion.
  const savedDeepL = process.env.DEEPL_API_KEY;
  const savedGoogle = process.env.GOOGLE_TRANSLATE_KEY;
  delete process.env.DEEPL_API_KEY;
  delete process.env.GOOGLE_TRANSLATE_KEY;
  try {
    const out = await mt.translateBatch(['See [A1] for {query}'], { target: 'ZH', source: 'EN' });
    assert.deepStrictEqual(out, ['See [A1] for {query}']);
  } finally {
    if (savedDeepL !== undefined) process.env.DEEPL_API_KEY = savedDeepL;
    if (savedGoogle !== undefined) process.env.GOOGLE_TRANSLATE_KEY = savedGoogle;
  }
});

// ---------------------------------------------------------------------------
// prefill key discovery + surgical insertion
// ---------------------------------------------------------------------------
test('findMissingKeys returns en keys absent from zh-CN', () => {
  const locales = {
    LOCALES: {
      en: { 'a.one': 'One', 'a.two': 'Two', 'a.three': 'Three' },
      'zh-CN': { 'a.one': '一', 'a.three': '三' },
    },
  };
  const missing = prefill.findMissingKeys(locales);
  assert.deepStrictEqual(missing, ['a.two']);
});

test('findMissingKeys treats empty zh-CN values as missing', () => {
  const locales = {
    LOCALES: {
      en: { 'k.one': 'One' },
      'zh-CN': { 'k.one': '   ' },
    },
  };
  assert.deepStrictEqual(prefill.findMissingKeys(locales), ['k.one']);
});

test('insertMissingZh adds only missing entries before the zh-CN close, preserving the rest', () => {
  const src = [
    "    'zh-CN': {",
    "      'a.one': '一',",
    "    },",
    "  };",
    "",
  ].join('\n');
  const additions = ["      'a.two': '二',"];
  const out = prefill.insertMissingZh(src, additions);
  const lines = out.split('\n');
  // The new line sits right before the closing '    },'.
  const closeIdx = lines.findIndex((l) => /^\s*\},?\s*$/.test(l));
  assert.strictEqual(lines[closeIdx - 1], "      'a.two': '二',");
  // Everything else is preserved verbatim.
  assert.ok(out.includes("      'a.one': '一',"));
  assert.ok(out.includes("  };"));
  // Exactly one new entry was added.
  assert.strictEqual(out.match(/a\.two/g).length, 1);
});

test('insertMissingZh with no additions returns the input unchanged', () => {
  const src = "    'zh-CN': {\n      'a.one': '一',\n    },\n  };";
  assert.strictEqual(prefill.insertMissingZh(src, []), src);
});

test('prefill is idempotent on the real locales.js (zh-CN already mirrors en)', () => {
  // The shipped dictionary is fully mirrored, so nothing should be missing.
  const missing = prefill.findMissingKeys({ LOCALES });
  assert.deepStrictEqual(missing, [], 'real locales.js must have zero missing zh-CN keys');
});
