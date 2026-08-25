'use strict';

/*
 * lib/kbTranslate.js — hash-gated translation cache for Knowledge-Base content.
 *
 * Part of the Hybrid translation strategy. PR #90 made the *UI chrome* bilingual
 * (static en/zh-CN dict) and the Q&A answers *in-language* (LLM at request
 * time). This module makes the SHARED KB datasets and news summaries themselves
 * available in Chinese WITHOUT re-translating on every request:
 *
 *   - kb_translations(dataset_id, lang, content_hash, translated_json)
 *   - news_translations(article_id, lang, content_hash, translated_summary, saved, updated_at)
 *
 * Both tables live on the SAME global Postgres/Supabase pool as
 * datasets/sources/proposed_changes — they are shared, not per-user, so there
 * is NO Row-Level Security. This is intentionally orthogonal to the deferred
 * colleague-login work.
 *
 * Invalidation is hash-gated: a dataset's translated_json is reused until the
 * English source's SHA-256 changes (an edit / integrate write), at which point
 * the next zh-CN read re-translates and re-caches. A missing DEEPL_API_KEY
 * means Chinese simply serves English with nothing cached; an MT failure falls
 * back to English (lib/mtService already no-ops gracefully).
 *
 * News retention (product decision): we only PERSIST a translated summary when
 * the article is flagged saved by the client; a purge deletes rows that are not
 * saved OR older than 180 days. Pre-login, "saved" is client-asserted — this
 * bounds storage and tightens once real per-user saved state lands with login.
 */

const crypto = require("crypto");
const datasets = require("./datasets");
const mt = require("./mtService");

const TARGET_LANG = "zh-CN";
// Marker key for leaf nodes produced by the deep-walk (Symbol can't collide
// with any real data key).
const LEAF = Symbol("kbtr-leaf");

let _tableReady = false;

function hashJson(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}
function hashString(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}

function getPool() {
  return datasets.getDbPool();
}

// ---- Schema (idempotent) -------------------------------------------------

const DDL = `
  CREATE TABLE IF NOT EXISTS kb_translations (
    dataset_id     TEXT NOT NULL,
    lang           TEXT NOT NULL,
    content_hash   TEXT NOT NULL,
    translated_json JSONB NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset_id, lang)
  );
  CREATE TABLE IF NOT EXISTS news_translations (
    article_id       TEXT NOT NULL,
    lang             TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    translated_summary TEXT NOT NULL,
    saved            BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (article_id, lang)
  );
  CREATE INDEX IF NOT EXISTS idx_news_translations_retention
    ON news_translations (saved, updated_at);
`;

async function ensureKbTranslationsTable() {
  if (_tableReady) return true;
  const pool = getPool();
  if (!pool) return false; // no DB → callers degrade to English
  await pool.query(DDL);
  _tableReady = true;
  return true;
}

// ---- DB row accessors ----------------------------------------------------

async function getKbTranslationRow(name, lang) {
  const pool = getPool();
  if (!pool) return null;
  const { rows } = await pool.query(
    "SELECT content_hash, translated_json FROM kb_translations WHERE dataset_id=$1 AND lang=$2",
    [name, lang]
  );
  return rows[0] || null;
}
async function upsertKbTranslation(name, lang, hash, translated) {
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO kb_translations (dataset_id, lang, content_hash, translated_json, updated_at)
     VALUES ($1,$2,$3,$4,now())
     ON CONFLICT (dataset_id, lang) DO UPDATE
       SET content_hash=EXCLUDED.content_hash, translated_json=EXCLUDED.translated_json, updated_at=now()`,
    [name, lang, hash, JSON.stringify(translated)]
  );
}
async function clearKbTranslations() {
  const pool = getPool();
  if (!pool) return 0;
  const { rowCount } = await pool.query("DELETE FROM kb_translations");
  return rowCount || 0;
}

async function getNewsTranslationRows(ids, lang) {
  const pool = getPool();
  if (!pool || !ids.length) return new Map();
  const { rows } = await pool.query(
    "SELECT article_id, content_hash, translated_summary FROM news_translations WHERE article_id = ANY($1) AND lang=$2",
    [ids, lang]
  );
  const m = new Map();
  for (const r of rows) m.set(r.article_id, r);
  return m;
}
async function upsertNewsTranslation(id, lang, hash, summary, saved) {
  const pool = getPool();
  if (!pool) return;
  await pool.query(
    `INSERT INTO news_translations (article_id, lang, content_hash, translated_summary, saved, updated_at)
     VALUES ($1,$2,$3,$4,$5,now())
     ON CONFLICT (article_id, lang) DO UPDATE
       SET content_hash=EXCLUDED.content_hash, translated_summary=EXCLUDED.translated_summary,
           saved = EXCLUDED.saved OR news_translations.saved, updated_at=now()`,
    [id, lang, hash, summary, saved]
  );
}
async function purgeStaleNewsTranslations() {
  const pool = getPool();
  if (!pool) return 0;
  const { rowCount } = await pool.query(
    "DELETE FROM news_translations WHERE saved = FALSE OR updated_at < now() - interval '180 days'"
  );
  return rowCount || 0;
}

// ---- JSON deep translation (values only; keys/ids preserved) --------------

// Skip strings that are not prose: no letters (numbers/dates/codes), or short
// code-like tokens (no spaces, only alnum + .-:/, <=12) such as "gpt-4", "A12".
function shouldTranslate(s) {
  if (!s || !s.trim()) return false;
  if (!/\p{L}/u.test(s)) return false;
  if (!/\s/.test(s) && /^[\w.\-:/]+$/.test(s) && s.length <= 12) return false;
  return true;
}

async function translateJsonDeep(input, lang) {
  if (!lang || lang === "en" || !process.env.DEEPL_API_KEY) return input;
  const leaves = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v)) o[k] = walk(v[k]);
      return o;
    }
    if (typeof v === "string") {
      if (shouldTranslate(v)) {
        leaves.push(v);
        return { [LEAF]: leaves.length - 1 };
      }
      return v;
    }
    return v;
  };
  const tree = walk(input);
  if (!leaves.length) return input;
  let translated;
  try {
    translated = await mt.translateBatch(leaves);
  } catch {
    return input;
  }
  const rehydrate = (v) => {
    if (Array.isArray(v)) return v.map(rehydrate);
    if (v && typeof v === "object") {
      if (LEAF in v) return translated[v[LEAF]];
      const o = {};
      for (const k of Object.keys(v)) o[k] = rehydrate(v[k]);
      return o;
    }
    return v;
  };
  return rehydrate(tree);
}

// ---- Public API ----------------------------------------------------------

// Returns the dataset in `lang` (translated + cached), or the English source
// when lang is en / untranslatable / DB or DEEPL key unavailable.
async function getDatasetTranslated(name, lang) {
  const src = datasets.getDataset(name);
  if (!src) return null;
  if (!lang || lang === "en" || !process.env.DEEPL_API_KEY) return src;
  await ensureKbTranslationsTable();
  const hash = hashJson(src);
  let row = null;
  try {
    row = await getKbTranslationRow(name, lang);
  } catch {
    /* fall through to a fresh translation */
  }
  if (row && row.content_hash === hash) return row.translated_json;
  const translated = await translateJsonDeep(src, lang);
  // translateJsonDeep returns the SAME reference as `src` when translation did
  // not actually occur (no key / provider failure / nothing translatable). Only
  // cache when content genuinely changed — otherwise a failed warm would poison
  // the cache with English stored as "zh-CN" and serve it forever until the
  // source hash changes.
  if (translated !== src) {
    try {
      await upsertKbTranslation(name, lang, hash, translated);
    } catch (e) {
      console.warn("[kbTranslate] upsert failed:", e.message);
    }
  }
  return translated;
}

// Translate a list of news articles' styledSummary for `lang`, caching only
// those flagged saved. Preserves the array shape (styledSummary replaced).
async function translateNewsSummaries(articles, lang, savedIds = []) {
  if (!lang || lang === "en" || !process.env.DEEPL_API_KEY || !Array.isArray(articles)) return articles;
  const ids = articles.map((a) => a.id || a.guid || a.link || "");
  let cached = new Map();
  try {
    cached = await getNewsTranslationRows(ids, lang);
  } catch {
    /* ignore — treat as cache miss */
  }
  const result = new Array(articles.length);
  const jobs = [];
  articles.forEach((a, i) => {
    const s = a.styledSummary || a.summary || "";
    if (!s) {
      result[i] = a;
      return;
    }
    const id = ids[i];
    const hash = hashString(s);
    const row = cached.get(id);
    if (row && row.content_hash === hash) {
      result[i] = { ...a, styledSummary: row.translated_summary };
      return;
    }
    jobs.push({ i, id, summary: s, hash });
  });
  if (jobs.length) {
    const batch = jobs.map((j) => j.summary);
    let translated;
    try {
      translated = await mt.translateBatch(batch);
    } catch {
      translated = batch;
    }
    const savedSet = new Set(savedIds);
    for (let k = 0; k < jobs.length; k += 1) {
      const j = jobs[k];
      const ts = translated[k];
      if (savedSet.has(j.id) && ts !== j.summary) {
        try {
          await upsertNewsTranslation(j.id, lang, j.hash, ts, true);
        } catch {
          /* ignore — cache is best-effort */
        }
      }
      result[j.i] = { ...articles[j.i], styledSummary: ts };
    }
  }
  return result;
}

// Translate the free-text fields of Q&A evidence into `lang` so a Chinese
// user's answer is grounded in Chinese KB/web passages. Citation ids ([A#] etc.)
// are preserved by lib/mtService's fidelity mask. Returns evidence unchanged on
// en / no key / failure.
async function translateEvidence(evidence, lang) {
  if (!lang || lang === "en" || !Array.isArray(evidence) || !evidence.length) return evidence;
  if (!process.env.DEEPL_API_KEY) return evidence;
  const jobs = [];
  evidence.forEach((item, i) => {
    for (const f of ["text", "excerpt", "title", "section"]) {
      if (typeof item[f] === "string" && item[f].trim()) jobs.push({ i, f, text: item[f] });
    }
  });
  if (!jobs.length) return evidence;
  let translated;
  try {
    translated = await mt.translateBatch(jobs.map((j) => j.text));
  } catch {
    return evidence;
  }
  const out = evidence.map((it) => ({ ...it }));
  jobs.forEach((j, k) => {
    out[j.i][j.f] = translated[k];
  });
  return out;
}

// ---- KB retranslation maintenance (PR #95) -------------------------------
// Admin endpoint helper: after clearing the cache, re-translate every KB
// dataset and report per-dataset success so a broken/expired key is
// self-diagnosing — the response shows exactly which datasets failed to
// produce Chinese. On success this also warms the cache (fixes the KB).

// The canonical list of datasets served through getDatasetTranslated.
const KB_DATASET_NAMES = [
  "knowledge", "network", "tencent-products", "current-use-cases",
  "gaming-trends", "regulatory-timeline", "risks", "company-locations",
];

function countCjkInObject(obj) {
  let count = 0;
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
    else if (typeof v === "string") {
      const m = v.match(/[一-鿿]/g);
      if (m) count += m.length;
    }
  };
  walk(obj);
  return count;
}

async function retranslateAllKb(lang = "zh-CN") {
  if (!process.env.DEEPL_API_KEY) {
    return { keyPresent: false, results: [] };
  }
  const results = [];
  for (const name of KB_DATASET_NAMES) {
    const src = datasets.getDataset(name);
    if (!src) {
      results.push({ name, ok: false, reason: "dataset missing" });
      continue;
    }
    const srcCjk = countCjkInObject(src);
    let translated = null;
    let error = null;
    try {
      // Cleared cache means this re-translates fresh and caches on success.
      translated = await getDatasetTranslated(name, lang);
    } catch (e) {
      error = e.message;
    }
    if (!translated) {
      results.push({ name, ok: false, reason: error || "no result" });
      continue;
    }
    const outCjk = countCjkInObject(translated);
    const changed = translated !== src;
    const producedChinese = outCjk > srcCjk;
    results.push({
      name,
      ok: changed && producedChinese,
      chineseCharsAdded: Math.max(0, outCjk - srcCjk),
      changed,
      note: changed
        ? (producedChinese ? undefined : "translated but produced no Chinese")
        : "no change produced (key invalid or upstream error)",
      error: error || undefined,
    });
  }
  return { keyPresent: true, results };
}

module.exports = {
  TARGET_LANG,
  hashJson,
  hashString,
  shouldTranslate,
  translateJsonDeep,
  getDatasetTranslated,
  translateNewsSummaries,
  translateEvidence,
  ensureKbTranslationsTable,
  purgeStaleNewsTranslations,
  clearKbTranslations,
  KB_DATASET_NAMES,
  retranslateAllKb,
};
