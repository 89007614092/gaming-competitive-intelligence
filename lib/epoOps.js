"use strict";
// EPO OPS (Open Patent Services) client — live, compliant patent data.
//
// Why this exists: the Patents feature was removed (PR #101) after two blocked
// attempts — USPTO/PatentsView ODP needs a US-citizen identity, and Google
// Patents forbids automated access and blocks iframing. EPO OPS is the
// European Patent Office's OFFICIAL REST API, explicitly built for automated
// access, with no citizenship wall. See docs/patents-epo-ops-scope.md.
//
// Shape is deliberately the same as lib/searchProvider.js (token/breaker/
// throttle/injected fetch) with one difference: there is no fallback chain,
// because there is no compliant second patent API. So failures surface to the
// caller as a clear error rather than degrading to a worse source.
//
// Hard rules for this data:
//   * Attribution must credit the EPO ("Data: EPO OPS").
//   * Deep-links go to Espacenet (EPO's own viewer) — NOT Google Patents.
//   * Fair Use quota is real: cache aggressively, self-throttle, breaker.
//
// Everything is env-gated (EPO_OPS_KEY / EPO_OPS_SECRET) and dependency
// injected, so the whole module is unit-testable with no network and no keys.

// Pinned in ONE place: OPS has drifted between /rest-services and
// /3.2/rest-services historically. Change it here and nowhere else.
const OPS_VERSION = "3.2";
const OPS_BASE = `https://ops.epo.org/${OPS_VERSION}/rest-services`;
const OPS_TOKEN_URL = `https://ops.epo.org/${OPS_VERSION}/auth/accesstoken`;

// Espacenet is the EPO's own viewer and is ToS-clean for deep-linking (unlike
// Google Patents, which blocks iframing). Query-by-publication-number is the
// most stable of its URL forms.
const ESPACENET_URL = "https://worldwide.espacenet.com/patent/search?q=pn%3D";

const BREAKER_THRESHOLD = 2;                 // consecutive failures before opening
const BREAKER_COOLDOWN_MS = 5 * 60 * 1000;   // how long the client stays skipped
const REQUEST_TIMEOUT_MS = 20000;
// OPS publishes no Retry-After in every 403 path; when it says "quota exceeded"
// without a wait hint, back off this long rather than hammering it.
const THROTTLE_FLOOR_MS = 60 * 60 * 1000;
// Renew slightly early so a token cannot expire mid-flight.
const TOKEN_SKEW_MS = 60 * 1000;
const MAX_ITEMS = 25;
const DEFAULT_ITEMS = 25;
// Cap on how many per-hit abstract lookups one search may trigger. Each is a
// separate OPS call, so this is the main quota guard.
const MAX_ABSTRACT_LOOKUPS = 10;

// Signals that a 403 is a quota/throttle rejection rather than an auth problem.
const QUOTA_HINT = /traffic|quota|limit|throttl|exceed|reject/i;

// The AI x gaming classification set carried over from the old Launch Hub.
// Exported so the UI can render the same chips the backend will query.
const CPC_PRESETS = {
  A63F: "Games / amusements",
  G06N: "AI / machine learning",
  G06T: "Image / graphics processing",
  G10L: "Speech / audio processing",
  H04N: "Video / image coding",
};
const CPC_PRESET_CODES = Object.keys(CPC_PRESETS);

// ---------------------------------------------------------------------------
// CQL builder
// ---------------------------------------------------------------------------
// OPS CQL fields used here: pa (applicant/assignee), ta (title+abstract),
// cpc (classification), pd (publication date). Quotes are stripped rather than
// escaped because a stray quote inside a phrase silently breaks the whole
// query string.
function cqlText(raw) {
  return String(raw || "").replace(/["\\]/g, " ").replace(/\s+/g, " ").trim();
}

function clampItems(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ITEMS;
  return Math.min(Math.floor(n), MAX_ITEMS);
}

// Input: { company, keyword, cpc[], from (YYYYMMDD), to (YYYYMMDD) }
// Output: a CQL string, or "" when there is nothing to search for.
function buildCql(query = {}) {
  const clauses = [];
  const company = cqlText(query.company);
  const keyword = cqlText(query.keyword);

  if (company) clauses.push(`pa all "${company}"`);
  if (keyword) clauses.push(`ta all "${keyword}"`);

  // CPC is a set — OR them together, then AND with the rest.
  const cpc = (Array.isArray(query.cpc) ? query.cpc : String(query.cpc || "").split(","))
    .map(c => String(c || "").trim().toUpperCase())
    .filter(c => /^[A-Z][0-9]{2}[A-Z]$/.test(c));
  if (cpc.length === 1) clauses.push(`cpc all "${cpc[0]}"`);
  else if (cpc.length > 1) clauses.push(`(${cpc.map(c => `cpc all "${c}"`).join(" or ")})`);

  const from = String(query.from || "").replace(/\D/g, "").slice(0, 8);
  const to = String(query.to || "").replace(/\D/g, "").slice(0, 8);
  if (from && to) clauses.push(`pd within "${from} ${to}"`);
  else if (from) clauses.push(`pd >= "${from}"`);
  else if (to) clauses.push(`pd <= "${to}"`);

  return clauses.join(" and ");
}

// Stable cache key for a query — same logical query must hit the same row even
// if the CPC chips were supplied in a different order.
function buildCacheKey(query = {}) {
  const cpc = (Array.isArray(query.cpc) ? query.cpc : String(query.cpc || "").split(","))
    .map(c => String(c || "").trim().toUpperCase())
    .filter(Boolean)
    .sort();
  return [
    "v1",
    cqlText(query.company).toLowerCase(),
    cqlText(query.keyword).toLowerCase(),
    cpc.join("|"),
    String(query.from || ""),
    String(query.to || ""),
    clampItems(query.range),
    String(query.sort || "date"),
    query.abstracts ? "abs" : "noabs",
  ].join("~");
}

// ---------------------------------------------------------------------------
// XML->JSON tolerance helpers
// ---------------------------------------------------------------------------
// OPS returns JSON that is a direct map of its XML: keys keep their namespace
// prefixes ("ops:search-result"), text lives under "#text" or "$", attributes
// under "@name", and single children are objects while repeated children are
// arrays. Every extractor here accepts all of those shapes.
function asArray(v) {
  if (v === null || v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = textOf(item);
      if (t) return t;
    }
    return "";
  }
  if (typeof v === "object") {
    if (typeof v["#text"] === "string") return v["#text"];
    if (typeof v.$ === "string") return v.$;
  }
  return "";
}

// For multi-paragraph values (abstracts) we want EVERY paragraph joined,
// not just the first.
function joinText(v) {
  return asArray(v).map(textOf).filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function attrOf(obj, name) {
  if (!obj || typeof obj !== "object") return "";
  const key = name.startsWith("@") ? name : `@${name}`;
  const val = obj[key];
  return val === undefined || val === null ? "" : String(val);
}

// publication-reference carries several document-id variants (docdb, epodoc).
// Prefer docdb (country+number+kind) because that is what Espacenet links and
// the /biblio and /abstract endpoints expect.
function pickDocId(ids) {
  const arr = asArray(ids);
  if (!arr.length) return null;
  return arr.find(d => attrOf(d, "@document-id-type") === "docdb")
    || arr.find(d => attrOf(d, "@document-id-type") === "epodoc")
    || arr[0];
}

function docNumberFrom(id) {
  if (!id) return { country: "", number: "", kind: "", date: "" };
  return {
    country: textOf(id.country),
    number: textOf(id["doc-number"]) || textOf(id.number) || textOf(id["doc-number/"]),
    kind: textOf(id.kind),
    date: textOf(id.date),
  };
}

// "20250312" -> "2025-03-12". Anything unexpected passes through untouched so a
// caller can still see the raw value instead of a blank card.
function isoDate(raw) {
  const d = String(raw || "").trim();
  if (/^\d{8}$/.test(d)) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  return d || "";
}

function espacenetUrl(pn) {
  return pn ? ESPACENET_URL + encodeURIComponent(pn) : "";
}

// Prefer the English title when OPS returns several translations.
function pickEnglish(values) {
  const arr = asArray(values);
  if (!arr.length) return "";
  const en = arr.find(v => /^en/i.test(attrOf(v, "@lang") || ""));
  return textOf(en || arr[0]);
}

function classificationsFrom(biblio) {
  const out = [];
  const ipcr = biblio && (biblio["classifications-ipcr"] || biblio.classificationsIpcr);
  for (const c of asArray(ipcr && ipcr["classification-ipcr"])) {
    const t = textOf(c && c.text);
    if (t) out.push(t.replace(/\s+/g, " ").trim());
  }
  const cpcWrap = biblio && (biblio["patent-classifications"] || biblio.patentClassifications);
  for (const c of asArray(cpcWrap && (cpcWrap["patent-classification"] || cpcWrap.patentClassification))) {
    const sym = textOf(c && c["classification-symbol"]);
    if (sym) out.push(sym.replace(/\s+/g, " ").trim());
  }
  return [...new Set(out.filter(Boolean))];
}

function partiesFrom(biblio, role) {
  const parties = biblio && (biblio.parties || {});
  const group = parties[role] || {};
  const rows = asArray(group[role.slice(0, -1)]); // applicants -> applicant
  const names = rows
    .map(r => textOf(r && (r[`${role.slice(0, -1)}-name`] || {}).name))
    .map(s => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return [...new Set(names)];
}

// Normalises ONE exchange-document into the card shape the API/UI consumes.
function normaliseDocument(doc) {
  if (!doc || typeof doc !== "object") return null;
  const biblio = doc["bibliographic-data"] || doc.bibliographicData || {};
  const pubRef = biblio["publication-reference"] || biblio.publicationReference || {};
  const id = pickDocId(pubRef["document-id"] || pubRef.documentId);
  const parts = docNumberFrom(id);
  if (!parts.number) return null;

  const pn = `${parts.country}${parts.number}${parts.kind}`.trim();
  const title = pickEnglish(biblio["invention-title"] || biblio.inventionTitle);
  const abstract = doc.abstract ? joinText(asArray(doc.abstract).map(a => a && a.p)) : "";

  return {
    id: pn,
    country: parts.country,
    number: parts.number,
    kind: parts.kind,
    title: title || "(untitled)",
    abstract,
    applicants: partiesFrom(biblio, "applicants"),
    inventors: partiesFrom(biblio, "inventors"),
    publicationDate: isoDate(parts.date),
    classifications: classificationsFrom(biblio),
    espacenetUrl: espacenetUrl(pn),
    attribution: "Data: EPO OPS",
  };
}

// Tolerant reader for the /published-data/search envelope.
function normaliseSearchResult(json, limit = DEFAULT_ITEMS) {
  const root = json && (json["ops:world-patent-data"] || json.worldPatentData);
  if (!root) return { patents: [], totalAvailable: 0 };
  const result = root["ops:search-result"] || root.searchResult || {};
  const totalRaw = attrOf(result, "@total-result-count") || result["@total-result-count"];
  const total = Number(String(totalRaw || "").replace(/\D/g, "")) || 0;
  const exchange = result["exchange-documents"] || result.exchangeDocuments || {};
  const docs = asArray(exchange["exchange-document"] || exchange.exchangeDocument);
  const patents = docs.map(normaliseDocument).filter(Boolean).slice(0, limit);
  return { patents, totalAvailable: total };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------
function createEpoClient(deps = {}) {
  const config = deps.config || {};
  const fetchImpl = deps.fetchImpl || ((...args) => globalThis.fetch(...args));
  const now = typeof deps.now === "function" ? deps.now : () => Date.now();
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const cooldownMs = Number(deps.cooldownMs) > 0 ? Number(deps.cooldownMs) : BREAKER_COOLDOWN_MS;
  const threshold = Number(deps.threshold) > 0 ? Number(deps.threshold) : BREAKER_THRESHOLD;
  const timeoutMs = Number(deps.timeoutMs) > 0 ? Number(deps.timeoutMs) : REQUEST_TIMEOUT_MS;
  const throttleFloorMs = Number(deps.throttleFloorMs) > 0 ? Number(deps.throttleFloorMs) : THROTTLE_FLOOR_MS;
  const sleep = typeof deps.sleep === "function" ? deps.sleep : (ms) => new Promise(r => setTimeout(r, ms));

  let token = null;            // { value, expiresAt }
  let tokenRequests = 0;       // diagnostic: how often we had to re-auth
  let failures = 0;
  let openUntil = 0;
  let lastError = "";
  let throttleUntil = 0;
  let throttlingControl = "";

  function isConfigured() {
    return !!(config.EPO_OPS_KEY && config.EPO_OPS_SECRET);
  }
  function isOpen() { return openUntil > now(); }
  function isThrottled() { return throttleUntil > now(); }

  function recordFailure(err) {
    failures += 1;
    lastError = String((err && err.message) || err || "unknown");
    if (failures >= threshold) {
      openUntil = now() + cooldownMs;
      log(`[epo] client tripped after ${failures} failures — skipping for ${Math.round(cooldownMs / 1000)}s`);
    }
    return lastError;
  }
  function recordSuccess() {
    failures = 0;
    openUntil = 0;
    lastError = "";
  }

  function readHeader(resp, name) {
    const headers = resp && resp.headers;
    if (!headers || typeof headers.get !== "function") return "";
    return String(headers.get(name) || "");
  }

  function setThrottle(ms, reason) {
    throttleUntil = now() + ms;
    log(`[epo] backing off ${Math.round(ms / 1000)}s — ${reason}`);
  }

  function retryAfterMs(resp) {
    const raw = Number(readHeader(resp, "retry-after").trim());
    return Number.isFinite(raw) && raw > 0 ? raw * 1000 : 0;
  }

  // Non-rejected responses: record the quota signal and back off only if OPS
  // explicitly says the allowance is gone. A healthy response reads
  // "idle (4/hour)" — that must NOT park the client.
  function noteThrottle(resp) {
    const ctl = readHeader(resp, "x-throttling-control");
    if (ctl) throttlingControl = ctl;
    const wait = retryAfterMs(resp);
    if (wait) {
      setThrottle(wait, `Retry-After ${Math.round(wait / 1000)}s`);
      return;
    }
    if (ctl && /exceed|quota|blocked|reject/i.test(ctl)) {
      setThrottle(throttleFloorMs, `"${ctl}"`);
    }
  }

  // A 403 on an AUTHENTICATED OPS call is virtually always the throttle
  // mechanism, so it backs off — with or without a wait hint. Without this we
  // would retry instantly against an exhausted quota.
  //
  // The exception matters: OPS also 403s an UNAUTHENTICATED request (verified
  // live — an anonymous /published-data/search returns 403). If we parked the
  // client for an hour over a fixable credential problem, a bad key would look
  // exactly like a quota lockout. So an explicit auth/entitlement signal is
  // treated as a FAULT (feeds the breaker) instead of a throttle.
  // Returns true when the client was throttled.
  function noteRejection(resp) {
    const ctl = readHeader(resp, "x-throttling-control");
    if (ctl) throttlingControl = ctl;
    const reason = readHeader(resp, "x-rejection-reason");
    const wait = retryAfterMs(resp);
    const signals = `${reason} ${ctl}`;
    const authProblem = /anonymous|not allowed|unauthori[sz]ed|forbidden|invalid_token|access_token/i.test(signals);
    if (authProblem && !wait && !QUOTA_HINT.test(signals)) return false;
    setThrottle(wait || throttleFloorMs, wait
      ? `Retry-After ${Math.round(wait / 1000)}s`
      : "403 rejection with no wait hint");
    return true;
  }

  async function withTimeout(run) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("EPO OPS request timed out");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchToken() {
    const basic = Buffer.from(`${config.EPO_OPS_KEY}:${config.EPO_OPS_SECRET}`).toString("base64");
    return withTimeout(async (signal) => {
      const resp = await fetchImpl(OPS_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${basic}`,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: "grant_type=client_credentials",
        signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => "");
        throw new Error(`EPO OPS auth HTTP ${resp.status}: ${String(txt).slice(0, 160)}`);
      }
      const json = await resp.json();
      const value = json && json.access_token;
      if (!value) throw new Error("EPO OPS auth returned no access_token");
      const expiresIn = Number(json.expires_in) > 0 ? Number(json.expires_in) : 1200;
      tokenRequests += 1;
      token = { value, expiresAt: now() + expiresIn * 1000 };
      return token.value;
    });
  }

  async function getToken(force = false) {
    if (!force && token && token.expiresAt - TOKEN_SKEW_MS > now()) return token.value;
    return fetchToken();
  }

  // One OPS call with token refresh, throttle and breaker awareness.
  async function request(path, { retryAuth = true } = {}) {
    if (!isConfigured()) {
      const err = new Error("EPO OPS not configured");
      err.code = "epo_not_configured";
      throw err;
    }
    if (isThrottled()) {
      const err = new Error(`EPO OPS quota throttled${throttlingControl ? ` (${throttlingControl})` : ""}`);
      err.code = "epo_throttled";
      throw err;
    }
    if (isOpen()) {
      const err = new Error(`EPO OPS circuit open (${lastError || "recent failures"})`);
      err.code = "epo_circuit_open";
      throw err;
    }

    const bearer = await getToken();
    const resp = await withTimeout(async (signal) => {
      return fetchImpl(`${OPS_BASE}${path}`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${bearer}`,
          Accept: "application/json",
          // OPS accepts Range as a header AND as a query param; the search URL
          // below sets the param, this header is the belt-and-braces form.
        },
        signal,
      });
    });

    if (resp.status === 404) return null;

    if (resp.status === 400 || resp.status === 401) {
      // OPS signals an expired token as a 400 carrying "invalid_access_token".
      // Refresh once and retry — the common case on a long-idle Render process.
      const body = await resp.text().catch(() => "");
      const expired = /invalid_access_token|expired/i.test(body);
      if (expired && retryAuth) {
        await getToken(true);
        return request(path, { retryAuth: false });
      }
      noteThrottle(resp);
      const err = new Error(`EPO OPS HTTP ${resp.status}: ${String(body).slice(0, 160)}`);
      recordFailure(err);
      throw err;
    }

    if (resp.status === 403) {
      const throttled = noteRejection(resp);
      const body = await resp.text().catch(() => "");
      const reason = readHeader(resp, "x-rejection-reason");
      const label = throttled ? "EPO OPS quota rejected" : "EPO OPS rejected";
      const err = new Error(
        `${label}${reason ? ` (${reason})` : ""}${body ? `: ${String(body).slice(0, 120)}` : ""}`
      );
      if (throttled) {
        err.code = "epo_throttled";
      } else {
        // Not a quota signal — treat it as a provider fault so it feeds the
        // breaker and is retried after the (shorter) cooldown.
        recordFailure(err);
      }
      throw err;
    }

    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      const err = new Error(`EPO OPS HTTP ${resp.status}: ${String(body).slice(0, 160)}`);
      recordFailure(err);
      throw err;
    }

    noteThrottle(resp);
    recordSuccess();
    return resp.json();
  }

  // GET /published-data/search?q=<CQL>&Range=1-N
  async function search(query = {}, options = {}) {
    if (!isConfigured()) {
      const err = new Error("EPO OPS not configured");
      err.code = "epo_not_configured";
      throw err;
    }
    const cql = buildCql(query);
    if (!cql) throw new Error("A company, keyword or CPC filter is required");
    const limit = clampItems(options.limit || query.range);
    const url = `/published-data/search?q=${encodeURIComponent(cql)}&Range=1-${limit}`;
    const json = await request(url);
    const { patents, totalAvailable } = normaliseSearchResult(json, limit);
    return { patents, totalAvailable, cql };
  }

  async function biblio(docdb) {
    if (!docdb) throw new Error("Publication number is required");
    const json = await request(`/published-data/publication/${encodeURIComponent(docdb)}/biblio`);
    const root = json && (json["ops:world-patent-data"] || json.worldPatentData);
    const doc = (root && (root["exchange-documents"] || {})["exchange-document"]) || null;
    return normaliseDocument(Array.isArray(doc) ? doc[0] : doc);
  }

  async function fetchAbstract(docdb) {
    if (!docdb) return "";
    const json = await request(`/published-data/publication/${encodeURIComponent(docdb)}/abstract`);
    if (!json) return "";
    const root = json["ops:world-patent-data"] || json.worldPatentData || {};
    const doc = (root["exchange-documents"] || {})["exchange-document"]
      || root["ops:abstract-document"] || root.abstractDocument;
    const doc0 = Array.isArray(doc) ? doc[0] : doc;
    const blocks = asArray(doc0 && doc0.abstract);
    if (!blocks.length) return "";
    const en = blocks.find(b => /^en/i.test(attrOf(b, "@lang") || "")) || blocks[0];
    return joinText(en && en.p);
  }

  // Fills in abstracts missing from the search envelope. Bounded hard: each is
  // a separate OPS call, and bailing the moment we trip throttle/breaker is the
  // whole point — a partial abstract is much better than a quota lockout.
  async function enrichWithAbstracts(patents, cap = MAX_ABSTRACT_LOOKUPS) {
    const max = Math.max(0, Math.min(Number(cap) || 0, MAX_ABSTRACT_LOOKUPS));
    if (!max) return patents;
    const targets = patents.filter(p => p && !p.abstract).slice(0, max);
    for (const p of targets) {
      if (isThrottled() || isOpen()) break;
      try {
        const text = await fetchAbstract(p.id);
        if (text) p.abstract = text;
      } catch (err) {
        log(`[epo] abstract lookup failed for ${p.id}: ${(err && err.message) || err}`);
        break; // a failing lookup will fail for the rest too
      }
    }
    return patents;
  }

  // Diagnostic snapshot for /healthz, so a throttled or broken OPS key is
  // visible to a live probe instead of only showing up as empty result sets.
  function status() {
    const ts = now();
    return {
      configured: isConfigured(),
      circuitOpen: openUntil > ts,
      throttled: throttleUntil > ts,
      throttlingControl: throttlingControl || undefined,
      failures,
      lastError: lastError || undefined,
      tokenCached: !!(token && token.expiresAt > ts),
      tokenRequests,
    };
  }

  // Test seam.
  function reset() {
    token = null;
    tokenRequests = 0;
    failures = 0;
    openUntil = 0;
    lastError = "";
    throttleUntil = 0;
    throttlingControl = "";
  }
  async function forceThrottle(ms) { throttleUntil = now() + ms; }
  // Only used by tests to simulate OPS's "your token is stale" response path.
  function expireToken() { if (token) token.expiresAt = 0; }

  return {
    isConfigured, search, biblio, fetchAbstract, enrichWithAbstracts,
    status, reset, forceThrottle, expireToken, sleep,
    getToken: () => getToken(),
  };
}

module.exports = {
  createEpoClient,
  buildCql,
  buildCacheKey,
  normaliseSearchResult,
  normaliseDocument,
  espacenetUrl,
  isoDate,
  CPC_PRESETS,
  CPC_PRESET_CODES,
  OPS_BASE,
  OPS_TOKEN_URL,
  ESPACENET_URL,
  MAX_ITEMS,
  DEFAULT_ITEMS,
  MAX_ABSTRACT_LOOKUPS,
};
