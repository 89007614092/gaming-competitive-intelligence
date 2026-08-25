'use strict';

/*
 * scripts/i18n-prefill.cjs — build-time zh-CN pre-fill for UI chrome strings.
 *
 * Part of the Hybrid translation strategy (PR #90). UI chrome strings live as
 * hand-authored `en` + `zh-CN` dictionaries in public/locales.js. When a
 * developer adds a NEW `en` string (and forgets the zh-CN counterpart), this
 * script auto-fills the missing Simplified-Chinese value via lib/mtService.js
 * (DeepL primary, Google Translate fallback) — so the dictionary never drifts
 * out of sync and the "zh-CN must mirror en" invariant in test/i18n.test.cjs
 * holds.
 *
 * Idempotent: it only ever ADDS keys that are missing from zh-CN. Existing
 * hand-authored zh-CN values are never overwritten. Re-running is a no-op once
 * the dictionary is fully mirrored.
 *
 * It performs a SURGICAL text edit — inserting new entries into the existing
 * `zh-CN` object — so the file's category comments and the separate I18N_MAP
 * selector array are preserved untouched.
 *
 * Usage:
 *   node scripts/i18n-prefill.cjs            # fill missing keys (writes file)
 *   node scripts/i18n-prefill.cjs --dry-run  # show what WOULD be added
 *
 * Requires one of DEEPL_API_KEY / GOOGLE_TRANSLATE_KEY at runtime to actually
 * translate. Without a key the script still runs cleanly: it reports "no keys"
 * (or, if keys are genuinely missing, leaves them for manual translation) and
 * never makes an unconfigured network call.
 */

const fs = require('fs');
const path = require('path');
const mt = require('../lib/mtService');

const LOCALES_PATH = path.join(__dirname, '..', 'public', 'locales.js');

// Node-safe require: locales.js guards window/document/localStorage so it can
// be loaded in a plain Node process. Returns { LOCALES, I18N_MAP, t, ... }.
function loadLocales() {
  return require(LOCALES_PATH);
}

// Keys present in `en` but absent/empty in `zh-CN`.
function findMissingKeys(locales) {
  const en = (locales && locales.LOCALES && locales.LOCALES.en) || {};
  const zh = (locales && locales.LOCALES && locales.LOCALES['zh-CN']) || {};
  const missing = [];
  for (const k of Object.keys(en)) {
    const v = zh[k];
    if (v == null || String(v).trim() === '') missing.push(k);
  }
  return missing;
}

// Escape a value for embedding inside a single-quoted JS string literal.
function escapeValue(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'");
}

// Build the lines to insert for the given missing keys.
function buildInsertions(missing, locales) {
  const en = locales.LOCALES.en;
  return missing.map((k) => `      '${k}': '${escapeValue(en[k])}',`);
}

// Insert `additions` (array of lines) into the `zh-CN` object, immediately
// before its closing `},`. Throws if the block markers can't be found.
function insertMissingZh(text, additions) {
  if (!additions || additions.length === 0) return text;
  const lines = text.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*'zh-CN':\s*\{/.test(lines[i])) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) throw new Error('zh-CN block not found in locales.js');
  let closeIdx = -1;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    if (/^\s*\},?\s*$/.test(lines[i])) {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) throw new Error('zh-CN block close not found in locales.js');
  lines.splice(closeIdx, 0, ...additions);
  return lines.join('\n');
}

async function runPrefill({ dryRun = false } = {}) {
  const locales = loadLocales();
  const missing = findMissingKeys(locales);
  if (missing.length === 0) {
    return {
      missing: [],
      additions: [],
      changed: false,
      note: 'No missing zh-CN keys — dictionary is fully mirrored.',
    };
  }
  const en = locales.LOCALES.en;
  const translations = await mt.translateBatch(
    missing.map((k) => en[k]),
    { target: 'ZH', source: 'EN' }
  );
  const additions = missing.map((k, i) => `      '${k}': '${escapeValue(translations[i])}',`);
  if (dryRun) {
    return { missing, additions, changed: false };
  }
  const text = fs.readFileSync(LOCALES_PATH, 'utf8');
  const updated = insertMissingZh(text, additions);
  fs.writeFileSync(LOCALES_PATH, updated);
  return { missing, additions, changed: true };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const hasKey = !!(process.env.DEEPL_API_KEY || process.env.GOOGLE_TRANSLATE_KEY);
  if (!hasKey && !dryRun) {
    // No provider configured: we cannot translate, so we must NOT pretend to.
    // Report and exit 0 (the build continues; gaps are left for manual fill).
    console.warn(
      '[i18n-prefill] No DEEPL_API_KEY or GOOGLE_TRANSLATE_KEY set — ' +
        'cannot auto-translate. Set one at runtime to fill missing zh-CN keys.'
    );
    return;
  }
  const result = await runPrefill({ dryRun });
  if (dryRun) {
    console.log(`[i18n-prefill] DRY RUN — would add ${result.missing.length} key(s):`);
    for (const a of result.additions) console.log(`  ${a.trim()}`);
  } else if (result.changed) {
    console.log(`[i18n-prefill] Added ${result.missing.length} zh-CN key(s) to public/locales.js`);
  } else {
    console.log(`[i18n-prefill] ${result.note}`);
  }
}

module.exports = {
  LOCALES_PATH,
  loadLocales,
  findMissingKeys,
  escapeValue,
  buildInsertions,
  insertMissingZh,
  runPrefill,
};

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
