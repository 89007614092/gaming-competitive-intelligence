'use strict';

/*
 * lib/mtService.js — build-time machine-translation helper for the i18n pipeline.
 *
 * Part of the Hybrid translation strategy (PR #90):
 *   - UI chrome (static strings in public/locales.js) is translated at BUILD
 *     TIME by a dedicated MT service: DeepL primary, Google Translate fallback.
 *   - This module is ONLY used by scripts/i18n-prefill.cjs. The dynamic,
 *     in-language Q&A answer is produced by the existing LLM, not here.
 *
 * Provider selection (auto, no config needed to stay safe):
 *   - DeepL is used when DEEPL_API_KEY is set. A key ending in ":fx" is the
 *     DeepL Free API (api-free.deepl.com); any other key is the Pro API.
 *   - Google Translate is used as a fallback when GOOGLE_TRANSLATE_KEY is set.
 *   - If NEITHER key is set, translateText/translateBatch return the source
 *     strings unchanged (graceful no-op) so the pre-fill never breaks a build
 *     or makes an unconfigured network call.
 *
 * Fidelity layer (mandatory for this product): citation chips [A#]/[W#]/[S#]/[T#]
 * and {placeholder} tokens are masked into distinctive sentinels before
 * translation and restored afterwards. If a string's chip count changes after
 * translation (meaning a chip was dropped or mangled), that string falls back to
 * its English source so a translation can never silently break a citation.
 *
 * Node-safe: uses the global fetch (Node 18+) and URLSearchParams. No DOM.
 */

// Citation chips, e.g. [A1], [W3], [S2], [T9]
const CHIP_REGEX = /\[([AWST]\d+)\]/g;
// Placeholders, e.g. {query}, {name}
const PLACEHOLDER_REGEX = /\{(\w+)\}/g;

// Sentinels are chosen to survive machine translation untouched in practice:
// they read like opaque tokens (@@C0@@ / @@P0@@) rather than natural words.
function chipToken(i) {
  return `@@C${i}@@`;
}
function placeholderToken(i) {
  return `@@P${i}@@`;
}

// Mask every protected token in `text`. Returns the masked string plus an
// ordered list of [token, original] pairs for restoration.
function maskProtected(text) {
  const tokens = [];
  let i = 0;
  let masked = String(text).replace(CHIP_REGEX, (m) => {
    const tok = chipToken(i);
    tokens.push([tok, m]);
    i += 1;
    return tok;
  });
  masked = masked.replace(PLACEHOLDER_REGEX, (m) => {
    const tok = placeholderToken(i);
    tokens.push([tok, m]);
    i += 1;
    return tok;
  });
  return { masked, tokens };
}

function restoreProtected(masked, tokens) {
  let out = masked;
  for (const [tok, orig] of tokens) {
    // Replace every occurrence of the sentinel with the original token.
    out = out.split(tok).join(orig);
  }
  return out;
}

function countChips(text) {
  const m = String(text).match(CHIP_REGEX);
  return m ? m.length : 0;
}

// ---- DeepL ----------------------------------------------------------------
async function deeplTranslateBatch(items, { target = 'ZH', source = 'EN' } = {}) {
  const key = process.env.DEEPL_API_KEY;
  if (!key) return null; // caller falls through to the next provider
  const isFree = key.trim().endsWith(':fx');
  const base = isFree ? 'https://api-free.deepl.com' : 'https://api.deepl.com';

  const params = new URLSearchParams();
  params.set('auth_key', key);
  params.set('source_lang', source);
  params.set('target_lang', target);
  for (const it of items) params.append('text', it.masked);

  const resp = await fetch(`${base}/v2/translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`DeepL HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const json = await resp.json();
  const tr = json.translations || [];
  return items.map((it, idx) => restoreProtected(tr[idx] && tr[idx].text ? tr[idx].text : it.masked, it.tokens));
}

// ---- Google Translate (fallback) -----------------------------------------
async function googleTranslateBatch(items, { target = 'zh-CN', source = 'en' } = {}) {
  const key = process.env.GOOGLE_TRANSLATE_KEY;
  if (!key) return null;
  const resp = await fetch(
    `https://translation.googleapis.com/language/translate/v2?key=${encodeURIComponent(key)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: items.map((it) => it.masked), source, target, format: 'text' }),
    }
  );
  if (!resp.ok) {
    const txt = await resp.text().catch(() => '');
    throw new Error(`Google HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const json = await resp.json();
  const tr = (json.data && json.data.translations) || [];
  return items.map((it, idx) => {
    const t = tr[idx] && tr[idx].translatedText ? tr[idx].translatedText : it.masked;
    return restoreProtected(t, it.tokens);
  });
}

// Translate one string. Returns the (fidelity-checked) translation, or the
// source string unchanged when no provider is configured or all fail.
async function translateText(text, opts = {}) {
  const out = await translateBatch([text], opts);
  return out[0];
}

// Translate a batch. Splits into chunks to respect provider limits, walks the
// DeepL -> Google chain per chunk, and applies per-string chip fidelity
// verification (a string whose chip count changed falls back to English source).
async function translateBatch(texts, opts = {}) {
  if (!Array.isArray(texts) || texts.length === 0) return [];
  const CHUNK = 30;
  const results = [];
  for (let i = 0; i < texts.length; i += CHUNK) {
    const slice = texts.slice(i, i + CHUNK);
    const items = slice.map((t) => {
      const { masked, tokens } = maskProtected(t);
      return { src: t, masked, tokens };
    });

    let translated = null;
    let lastErr = null;
    try {
      translated = await deeplTranslateBatch(items, opts);
    } catch (e) {
      lastErr = e;
    }
    if (!translated) {
      try {
        translated = await googleTranslateBatch(items, opts);
      } catch (e) {
        lastErr = e;
      }
    }
    if (!translated) {
      if (lastErr) {
        // Log but do not throw: a provider outage should not fail the whole
        // pre-fill run. Un-translated strings remain English (acceptable gap).
        console.warn(`[mtService] translation skipped: ${lastErr.message}`);
      }
      translated = items.map((it) => it.src);
    }

    for (let idx = 0; idx < items.length; idx += 1) {
      const candidate = translated[idx];
      // Fidelity check: chip count must be preserved exactly.
      if (countChips(candidate) !== countChips(items[idx].src)) {
        results.push(items[idx].src);
      } else {
        results.push(candidate);
      }
    }
  }
  return results;
}

module.exports = {
  CHIP_REGEX,
  PLACEHOLDER_REGEX,
  maskProtected,
  restoreProtected,
  countChips,
  translateText,
  translateBatch,
};
