'use strict';

/*
 * lib/patentsSource.js — ingestion + store for the "Patents" tab.
 *
 * Pulls gaming/AI patent reports published by futureofgaming.com (a public
 * intelligence site that tracks patents applied for by gaming/AI companies and
 * publishes short analyses). robots.txt permits scraping (Allow: /) and a
 * sitemap enumerates every patent report URL.
 *
 * Ingestion (lazy, admin-triggered + boot prime):
 *   - fetchLatestPatents(): GET the homepage, parse the "Recent Intelligence"
 *     grid-items (each carries company, published date, title, snippet, link).
 *   - fetchPatentCatalog(): GET the sitemap, enumerate all /publications/patents
 *     URLs (id + link). Used to seed the full catalog; entries not present in
 *     the recent grid show a slug-derived title + link until enriched.
 *   - merge + dedupe by id, normalise the date, store in the shared `patents`
 *     Postgres/Supabase table (global, NO RLS — shared intel, not per-user) and
 *     an in-memory cache.
 *
 * Cross-reference: each patent's company is matched (normalised, case/LLC/suffix
 * insensitive) against the KB `company-locations` dataset so the UI can badge a
 * patent as "in your KB".
 *
 * This module owns NO translation — patent reports stay English in v1 (the
 * futureofgaming source is English; zh-CN can be layered on later via the same
 * cache pattern used for KB/news once DEEPL_API_KEY is confirmed working).
 */

const crypto = require('crypto');
const datasets = require('./datasets');

const FOGL_BASE = 'https://futureofgaming.com';
const SITEMAP_URL = `${FOGL_BASE}/sitemap.xml`;
const HOMEPAGE_URL = `${FOGL_BASE}/`;

let _tableReady = false;
let _cache = null; // array of patent records, or null until primed

function getPool() {
  return datasets.getDbPool();
}

function sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex');
}

function normalizeCompany(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*(inc\.?|llc|ltd|corporation|corp\.?|plc|limited|co\.?|group|holdings?|technologies|technology)\s*/gi, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// ---- HTML parsing (tolerant; no DOM dependency) --------------------------

// Extract one patent record from a single <a ...>...</a> block of HTML.
function parseAnchorBlock(block) {
  const hrefMatch = block.match(/href="([^"]*\/publications\/patents\/[^"]+)"/i);
  if (!hrefMatch) return null;
  const href = hrefMatch[1];
  const idMatch = href.match(/\/publications\/patents\/([^/?#]+)/i);
  const id = idMatch ? idMatch[1] : sha1(href);

  // Company: <div class="label">...</div> or fallback to text near "Company:"
  let company = null;
  const labelM = block.match(/class="label"[^>]*>([\s\S]*?)<\/div>/i);
  if (labelM) company = labelM[1].replace(/<[^>]+>/g, '').trim();
  if (!company) {
    const cm = block.match(/Company:\s*([^<\n]+)</i);
    if (cm) company = cm[1].trim();
  }

  // Published date: "Published Date: Aug 20, 2026"
  // Parsed manually (not via new Date(string)) to avoid TZ drift when the
  // date has no explicit time — toISOString() would otherwise shift the day.
  let publishedDate = null;
  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const dm = block.match(/Published Date:\s*([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})/i);
  if (dm) {
    const m = MONTHS[dm[1].slice(0, 3).toLowerCase()];
    const d = parseInt(dm[2], 10);
    const y = parseInt(dm[3], 10);
    if (m !== undefined && d >= 1 && d <= 31) {
      publishedDate = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  // Title: <h3>...</h3>
  let title = null;
  const hm = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
  if (hm) title = hm[1].replace(/<[^>]+>/g, '').trim();

  // Snippet: first <p> that is not the "Published Date:" line (the date
  // paragraph sometimes precedes the description in the source markup).
  let snippet = null;
  const allP = [...block.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const descP = allP.find((s) => !/published\s*date:/i.test(s));
  if (descP) snippet = descP;

  return { id, company: company || null, title: title || null, snippet: snippet || null, publishedDate, link: href };
}

// Parse all patent anchors from a page of HTML.
function parsePatentsHtml(html) {
  const out = [];
  const re = /<a\s+[^>]*href="[^"]*\/publications\/patents\/[^"]+"[\s\S]*?<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const rec = parseAnchorBlock(m[0]);
    if (rec && (rec.title || rec.company)) out.push(rec);
  }
  return out;
}

// Parse the sitemap for every patent report URL.
function parseSitemap(xml) {
  const urls = [];
  const re = /https?:\/\/futureofgaming\.com\/publications\/patents\/[^\s"<>]+/gi;
  let m;
  while ((m = re.exec(xml)) !== null) urls.push(m[0]);
  return [...new Set(urls)];
}

function titleFromSlug(id) {
  const slug = String(id).includes('-') ? String(id).split('-').slice(1).join('-') : String(id);
  return slug
    .replace(/\.html?$/i, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---- Network (global fetch; Node 18+) ------------------------------------

async function fetchText(url, { timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; GamingCompetitiveIntelligence/1.0; +https://gaming-competitive-intelligence.onrender.com)' },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(t);
  }
}

async function fetchLatestPatents() {
  const html = await fetchText(HOMEPAGE_URL);
  return parsePatentsHtml(html);
}

async function fetchPatentCatalog() {
  const xml = await fetchText(SITEMAP_URL);
  return parseSitemap(xml).map((link) => {
    const idMatch = link.match(/\/publications\/patents\/([^/?#]+)/i);
    const id = idMatch ? idMatch[1] : sha1(link);
    return { id, company: null, title: titleFromSlug(id), snippet: null, publishedDate: null, link, fromCatalog: true };
  });
}

// Merge recent grid records over the sitemap catalog by id.
function mergeRecords(recent, catalog) {
  const byId = new Map();
  for (const c of catalog) byId.set(c.id, { ...c });
  for (const r of recent) {
    const base = byId.get(r.id) || {};
    byId.set(r.id, { ...base, ...r, fromCatalog: base.fromCatalog || false });
  }
  return [...byId.values()];
}

// ---- KB cross-reference ------------------------------------------------

function loadKbCompanies() {
  const data = datasets.getDataset('company-locations');
  const names = [];
  const push = (v) => { if (v) names.push(String(v)); };
  if (Array.isArray(data)) data.forEach((c) => { push(c.name); push(c.company); });
  else if (data && Array.isArray(data.companies)) data.companies.forEach((c) => { push(c.name); push(c.company); });
  return names.filter(Boolean);
}

function crossRefCompany(company, kbCompanies) {
  if (!company) return null;
  const norm = normalizeCompany(company);
  if (!norm) return null;
  for (const kb of kbCompanies) {
    const nk = normalizeCompany(kb);
    if (!nk) continue;
    if (norm === nk || norm.includes(nk) || nk.includes(norm)) return kb;
  }
  return null;
}

// ---- Store (shared Postgres/Supabase, no RLS) ----------------------------

const DDL = `
  CREATE TABLE IF NOT EXISTS patents (
    id            TEXT PRIMARY KEY,
    company       TEXT,
    title         TEXT,
    snippet       TEXT,
    link          TEXT NOT NULL,
    published_date DATE,
    category      TEXT NOT NULL DEFAULT 'Patents',
    kb_company    TEXT,
    from_catalog  BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
  );
`;

async function ensurePatentsTable() {
  if (_tableReady) return true;
  const pool = getPool();
  if (!pool) return false;
  await pool.query(DDL);
  _tableReady = true;
  return true;
}

async function persistRecords(records, kbCompanies) {
  const pool = getPool();
  if (!pool) return;
  for (const r of records) {
    const kb = crossRefCompany(r.company, kbCompanies);
    await pool.query(
      `INSERT INTO patents (id, company, title, snippet, link, published_date, category, kb_company, from_catalog, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,'Patents',$7,$8,now())
       ON CONFLICT (id) DO UPDATE
         SET company=EXCLUDED.company, title=EXCLUDED.title, snippet=EXCLUDED.snippet,
             published_date=EXCLUDED.published_date, kb_company=EXCLUDED.kb_company,
             from_catalog=EXCLUDED.from_catalog, updated_at=now()`,
      [r.id, r.company, r.title, r.snippet, r.link, r.publishedDate || null, kb || null, !!r.fromCatalog]
    );
  }
}

async function loadFromDb() {
  const pool = getPool();
  if (!pool) return null;
  const { rows } = await pool.query('SELECT id, company, title, snippet, link, published_date, kb_company, from_catalog FROM patents ORDER BY published_date DESC NULLS LAST, id DESC');
  return rows.map((r) => ({ ...r, publishedDate: r.published_date, kbCompany: r.kb_company, fromCatalog: r.from_catalog }));
}

// ---- Public API ----------------------------------------------------------

async function refreshPatents() {
  await ensurePatentsTable();
  const kbCompanies = loadKbCompanies();
  let records = [];
  try {
    const [recent, catalog] = await Promise.all([fetchLatestPatents().catch(() => []), fetchPatentCatalog().catch(() => [])]);
    records = mergeRecords(recent, catalog);
  } catch (e) {
    console.warn('[patents] ingest failed:', e.message);
  }
  if (records.length) {
    await persistRecords(records, kbCompanies);
    _cache = records.map((r) => ({ ...r, kbCompany: crossRefCompany(r.company, kbCompanies) }));
  } else if (_cache === null) {
    _cache = (await loadFromDb()) || [];
  }
  return records.length;
}

async function primePatentsFromDb() {
  await ensurePatentsTable().catch(() => {});
  try {
    const rows = await loadFromDb();
    if (rows && rows.length) _cache = rows;
  } catch (e) {
    console.warn('[patents] DB prime failed; will ingest on first refresh:', e.message);
  }
  return _cache;
}

async function getPatents({ company, kbOnly, since, limit } = {}) {
  if (_cache === null) await primePatentsFromDb();
  let list = _cache || [];
  if (company) list = list.filter((p) => p.company && p.company.toLowerCase().includes(String(company).toLowerCase()));
  if (kbOnly) list = list.filter((p) => p.kbCompany);
  if (since) list = list.filter((p) => p.publishedDate && p.publishedDate >= since);
  list = [...list].sort((a, b) => (b.publishedDate || '').localeCompare(a.publishedDate || ''));
  if (limit && Number.isFinite(limit)) list = list.slice(0, limit);
  return { success: true, count: list.length, patents: list };
}

module.exports = {
  FOGL_BASE,
  SITEMAP_URL,
  HOMEPAGE_URL,
  parsePatentsHtml,
  parseSitemap,
  parseAnchorBlock,
  titleFromSlug,
  normalizeCompany,
  mergeRecords,
  refreshPatents,
  primePatentsFromDb,
  getPatents,
  ensurePatentsTable,
};
