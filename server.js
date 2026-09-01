const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { execFile } = require("child_process");
const summariseEngine = require("./summarise-engine");
const {
  DEFAULT_MODEL,
  OPEN_MODEL_NAME_SCAN,
  buildCorpus,
  retrieveApplicationEvidence,
  webResultRelevance,
  generateOpenSourceAnswer,
  runModelChat,
  buildExtractiveAnswer,
  isModelReady,
  isScanModelReady,
  isScanRateLimited,
} = summariseEngine;
const config = require("./config");
const auth = require("./lib/auth");

const app = express();
// Security headers (helmet). Applied before any routes. CSP starts permissive
// (allows the single inline TMap config script at the top of index.html plus
// inline styles) and can be tightened later. Set DISABLE_HELMET=1 to skip
// (used by local/test boots that don't want the headers).
if (process.env.DISABLE_HELMET !== "1") {
  const helmet = require("helmet");
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://*.supabase.co"],
        frameSrc: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    frameguard: { action: "deny" },
  }));
}
// CORS is wide-open by default (the app is a public API). Once accounts v1 is
// enabled, sessions ride HttpOnly cookies, so we disable CORS entirely to stop
// any cross-origin site from riding the user's session cookie.
app.use(cors(auth.isAuthEnabled() ? { origin: false } : undefined));
app.use(express.json({ limit: "1mb" }));

// Accounts v1 gate — when AUTH_ENABLED=1 every request (except the auth
// endpoints, /login, /healthz, and static assets) needs a valid session cookie.
// Inert when auth is disabled, so the app stays fully public until the
// Supabase + ALLOWED_EMAILS env vars are configured.
app.use(auth.authGate);

app.use(express.static(path.join(__dirname, "public")));

// ===== Accounts v1: Supabase Auth login (env-gated; see lib/auth.js) =========
app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});
app.post("/api/auth/login", async (req, res) => {
  try {
    await auth.sendMagicLink(req, res);
  } catch (e) {
    console.warn("[auth] login handler error:", e.message);
    res.status(500).json({ error: "internal error" });
  }
});
app.get("/api/auth/callback", async (req, res) => {
  try {
    await auth.handleCallback(req, res);
  } catch (e) {
    console.warn("[auth] callback handler error:", e.message);
    res.status(400).send("authentication failed");
  }
});
app.get("/api/auth/session", async (req, res) => {
  try {
    await auth.getSession(req, res);
  } catch (e) {
    res.status(401).json({ error: "unauthorized" });
  }
});
app.post("/api/auth/logout", async (req, res) => {
  try {
    await auth.logout(req, res);
  } catch (e) {
    console.warn("[auth] logout handler error:", e.message);
    res.status(500).json({ error: "internal error" });
  }
});

const { execSync } = require("child_process");
const dns = require("dns/promises");
function resolvePython() {
  const candidates = [
    "/Users/mollybarlow/.workbuddy/binaries/python/envs/default/bin/python3",
    "python3",
    "python",
  ];
  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "ignore" });
      return candidate;
    } catch (_) { /* try next */ }
  }
  return null;
}
const PYTHON = resolvePython();
const TRANSCRIPT_SCRIPT = path.join(__dirname, "transcript.py");

// ===== Web search — provider CHAIN, not a single vendor =====
// Was: a bare Tavily call (which itself replaced a self-scraped DuckDuckGo
// search that got rate-limited / bot-challenged from Render's shared IP and
// always timed out). The problem with the bare Tavily call was that it made
// Tavily the ONLY external dependency with no fallback: a quota or key issue
// silently broke the search box and Q&A web evidence.
//
// Now every search goes through lib/searchProvider.js, which walks
// tavily -> brave -> jina (keyless backstop) and trips a short circuit breaker
// on a provider that keeps failing. `jinaSearch` is injected so the chain reuses
// the already-working s.jina.ai parser defined below rather than duplicating it.
const { createSearchProvider } = require("./lib/searchProvider");
const searchProvider = createSearchProvider({
  config,
  // Arrow-wrapped: jinaSearch is declared further down in this file.
  jinaSearch: (query, limit) => jinaSearch(query, limit),
  log: (msg) => console.warn(msg),
});

// Back-compat shim for the existing call sites: returns just the result array
// (the chain's provider/attempt metadata is available via searchWebDetailed).
async function searchWeb(query, limit = 10) {
  const { results } = await searchProvider.searchWeb(query, { limit });
  return results;
}
const searchWebDetailed = (query, limit = 10) => searchProvider.searchWeb(query, { limit });

// ===== Patents — EPO OPS (live, compliant patent data) =====
// See docs/patents-epo-ops-scope.md for the full rationale. In short: this is
// the only patent source we can use compliantly — USPTO/PatentsView needs a
// US-citizen identity, and Google Patents forbids automated access and blocks
// iframing. EPO OPS is the European Patent Office's own REST API.
//
// The client is ENV-GATED: without EPO_OPS_KEY + EPO_OPS_SECRET it stays inert
// and /api/patents returns a clean "not configured" error, so local dev, CI and
// any environment lacking the credentials are unaffected.
//
// Unlike the search chain there is NO fallback provider here, because there is
// no compliant second patent API — a failure surfaces honestly instead of
// silently degrading.
const {
  createEpoClient,
  buildCql,
  buildCacheKey,
  companyTokens,          // shared with the CQL builder so query + cross-ref agree
  applicantAliases,
  CPC_GROUPS,             // verified, grouped classification filters
  CPC_CHIPS,
  CPC_ALL_CODES,
  CPC_DEFAULT_CODES,
  isCpcCode,              // normalises to the spaced form OPS expects
  normaliseCpc,
  CPC_CODE_RE,
  MAX_ITEMS: EPO_MAX_ITEMS,
} = require("./lib/epoOps");
const epoClient = createEpoClient({
  config,
  log: (msg) => console.warn(msg),
});

// Fetch the full article body for a source URL. Reuses scrapeUrl (which
// resolves news.google.com redirect URLs to the real publisher and returns
// { text }). We clean + cap to 4000 chars so enriched evidence stays bounded.
// On ANY failure (timeout, bot-wall, unsupported content type, missing URL) we
// return the provided fallbackText, so enrichment can never break an answer.
async function fetchArticleBody(url, fallbackText, title = "") {
  if (!url) return fallbackText;
  try {
    const result = await scrapeUrl(String(url).slice(0, 2000), { title });
    const body = result && typeof result.text === "string" ? result.text : "";
    const cleaned = body.replace(/\s+/g, " ").trim();
    if (cleaned.length < 120) return fallbackText; // too thin to be useful
    return cleaned.slice(0, 4000);
  } catch (_) {
    return fallbackText;
  }
}

// ===== Web evidence cost controls (PR #2) =====
// Extracted article bodies are cached by URL so repeat questions about the same
// page don't re-extract (re-saving Jina/reader calls). In-memory per process;
// entries expire after an hour and the map is capped to avoid unbounded growth
// on a long-lived server.
const ARTICLE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const articleBodyCache = new Map(); // url -> { text, ts }
function articleCacheKey(url) {
  try { return new URL(String(url)).href.replace(/#.*$/, ""); } catch { return String(url); }
}
async function fetchCachedArticleBody(url, fallbackText, title = "") {
  const key = articleCacheKey(url);
  const hit = articleBodyCache.get(key);
  if (hit && Date.now() - hit.ts < ARTICLE_CACHE_TTL_MS) return hit.text;
  const text = await fetchArticleBody(url, fallbackText, title);
  if (text && text !== fallbackText) {
    articleBodyCache.set(key, { text, ts: Date.now() });
    if (articleBodyCache.size > 500) articleBodyCache.delete(articleBodyCache.keys().next().value);
  }
  return text;
}

// B1 — skip the web search entirely when local (KB + attached) evidence already
// covers the question. Conservative: only skip when most significant question
// keywords appear in the local evidence AND the question carries no recency
// signal (so genuinely-new / fresh info still triggers a search).
const RECENCY_TERMS = /\b(latest|recent|new(?:er|est)?|news|today|this week|this month|20(?:2[4-9]|3\d)|update[sd]?|current(?:ly)?|now|breaking)\b/i;
const WEAK_STOP_TERMS = new Set([
  "about", "what", "when", "where", "which", "their", "they", "that", "this",
  "with", "from", "have", "has", "are", "were", "been", "will", "does", "into",
  "than", "then", "over", "also", "how", "why", "who", "can", "could", "should",
  "would", "doesn", "the", "and", "for", "but", "not", "there", "these", "those",
]);
function tokenizeWords(text) {
  return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !WEAK_STOP_TERMS.has(w));
}
function localEvidenceCovers(question, localEvidence) {
  const qWords = tokenizeWords(question);
  if (qWords.length < 2) return false;            // too short to judge
  if (RECENCY_TERMS.test(question)) return false; // fresh info wanted -> search
  const localBlob = localEvidence.map(e => `${e.title || ""} ${e.text || e.excerpt || ""}`).join(" ").toLowerCase();
  const localTokens = new Set(tokenizeWords(localBlob));
  if (localTokens.size === 0) return false;
  const covered = qWords.filter(w => localTokens.has(w)).length;
  return covered / qWords.length >= 0.7; // conservative threshold
}

// B2 — after the model answers, find which web [W#] ids it actually cited, so
// we only deep-fetch full text for those (uncited hits cost nothing).
function citedWebIds(answer, webEvidence) {
  const cited = new Set((answer || "").match(/\[W\d+\]/g) || []);
  return webEvidence.filter(w => cited.has(`[${w.id}]`)).map(w => w.id);
}

// ===== Jina Reader (keyless option for the proposed-changes resolver) =====
// r.jina.ai/<url> returns the article body as clean text; s.jina.ai/<query>
// returns search results already extracted as markdown. Used when
// SEARCH_PROVIDER=jina so the resolver needs NO API key (an optional
// JINA_API_KEY simply lifts anonymous rate limits). Works from any IP,
// bypassing the DDG/GDELT sandbox block.

function activeSearchProvider() {
  return config.SEARCH_PROVIDER;
}

function jinaHeaders() {
  const headers = { Accept: "text/markdown,text/plain" };
  if (config.JINA_API_KEY) headers["Authorization"] = `Bearer ${config.JINA_API_KEY}`;
  return headers;
}

// Resolve a title to the real publisher URL via Jina's search endpoint.
async function jinaSearch(query, limit = 5) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: jinaHeaders(),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Jina search HTTP ${resp.status}`);
    const md = await resp.text();
    return parseJinaSearch(md, limit);
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Jina search timed out");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Tolerant parser for Jina's markdown search results. We only strictly need the
// first real publisher URL; the title/content are best-effort.
function parseJinaSearch(md, limit) {
  const blocks = md.split(/^#{1,4}\s+Result\s+\d+/gim).slice(1);
  const out = [];
  for (const block of blocks) {
    if (out.length >= limit) break;
    const urls = [...block.matchAll(/https?:\/\/[^\s)"'\]]+/g)]
      .map((m) => m[0])
      .filter((u) => !/^(https?:\/\/)?(s\.jina\.ai|r\.jina\.ai)/i.test(u));
    const url = urls[0];
    if (!url) continue;
    const titleLine = (block.match(/^\s*#+\s*(?:Result\s+\d+:\s*)?(.+)$/m) || [])[1] || "";
    out.push({
      title: titleLine.trim(),
      url,
      content: block.replace(/https?:\/\/\S+/g, "").replace(/\n+/g, " ").trim().slice(0, 600),
    });
  }
  return out;
}

// Extract the main article body as clean text via Jina's reader endpoint.
async function jinaExtract(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`https://r.jina.ai/${url}`, {
      headers: jinaHeaders(),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Jina extract HTTP ${resp.status}`);
    return (await resp.text()).replace(/\s+/g, " ").trim();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Jina extract timed out");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ===== Website and Video Transcript Extraction — free, no API key needed =====

const { createExtractor } = require("./lib/extractor");
const { applyLicenseGate } = require("./lib/licenseGate");
const retention = require("./lib/retention");
const { getDataset, clearDatasetCache, setDatasetCache, attachDb, primeDatasetCacheFromDb, getDbPool: datasetsGetDbPool, DATASET_FILE } = require("./lib/datasets");
const kbTranslate = require("./lib/kbTranslate");
const mtService = require("./lib/mtService");
const sources = require("./lib/sources");
// Thread D reuses the governed reader pipeline (Jina + Thread F attribution) for
// ingestion, so inject it once at boot. Function declarations are hoisted, so
// fetchReaderContent is already bound here even though it is defined lower.
sources.setSourceReader(fetchReaderContent);

// --- Option B: shared, editable datasets backed by Supabase (Postgres) ---
// `pg` is optional at module load: if it isn't installed or DATABASE_URL is
// unset, getDbPool() returns null and the app falls back to on-disk JSON.
let _pg = null;
try { _pg = require("pg"); } catch { /* pg not installed (e.g. local dev) */ }
let _dbPool = null;
function getDbPool() {
  if (_dbPool) return _dbPool;
  if (!process.env.DATABASE_URL || !_pg) return null;
  // Pool options (incl. IPv4 pin + PG_FAMILY override) live in lib/dbPool.
  _dbPool = makePool(_pg, process.env.DATABASE_URL, { max: 5 });
  return _dbPool;
}
const { makePool } = require("./lib/dbPool");
const { computeRetentionState, rollToExcerpt } = retention;
const SCRAPE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function decodeHtmlEntities(str = "") {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripHtml(str = "") {
  // Decode HTML entities FIRST, then strip tags. Google News RSS delivers
  // <description> with entity-encoded angle brackets (e.g. &lt;a href=…&gt;);
  // if we strip before decoding there are no literal < > to match, so the
  // markup survives into article text and renders as literal "<a…" in the UI.
  const decoded = decodeHtmlEntities(str);
  return decoded.replace(/<[^>]*>/g, "").trim();
}

// Returns true for IP addresses that must never be fetched: loopback, private
// RFC1918 ranges, link-local (incl. 169.254.169.254 cloud metadata), CGNAT,
// and multicast/reserved. Used to block SSRF whether the host is given as a
// literal IP or resolved via DNS.
function isPrivateOrReservedIp(ip) {
  if (!ip) return true;
  const v = String(ip).trim().toLowerCase();
  // IPv6
  if (v.includes(":")) {
    if (v === "::1" || v === "::" || v.startsWith("fe80") || v.startsWith("fc") || v.startsWith("fd")) return true;
    if (v.startsWith("::ffff:")) return isPrivateOrReservedIp(v.slice(7)); // IPv4-mapped
    return false;
  }
  // IPv4
  const parts = v.split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => Number.isNaN(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;                                  // 10.0.0.0/8
  if (a === 127) return true;                                 // loopback
  if (a === 0) return true;                                   // 0.0.0.0/8
  if (a === 169 && b === 254) return true;                    // 169.254.0.0/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true;           // 172.16.0.0/12
  if (a === 192 && b === 168) return true;                    // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true;          // 100.64.0.0/10 CGNAT
  if (a >= 224) return true;                                  // multicast + reserved
  return false;
}

// Resolve a hostname and ensure the resolved address is public. Stops
// DNS-rebinding and private-hostname SSRF. Rejects outright on resolve failure
// (we do not silently proceed to a fetch of an unverifiable host).
async function assertPublicHost(hostname) {
  const literal = String(hostname).replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (literal.match(/^\d+\.\d+\.\d+\.\d+$/) || literal.includes(":")) {
    if (isPrivateOrReservedIp(literal)) throw new Error("Blocked address range: " + hostname);
  }
  let address;
  try {
    ({ address } = await dns.lookup(literal, { all: false }));
  } catch (e) {
    if (/Blocked address range/.test(e.message)) throw e;
    throw new Error("Could not resolve source host: " + hostname);
  }
  if (isPrivateOrReservedIp(address)) throw new Error("Blocked address range: " + hostname);
}

function validateSourceUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("A valid source URL is required");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS source URLs are supported");
  }
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Local network URLs cannot be scraped");
  }
  // Only IP-literal hosts can be evaluated statically here. Hostname-based
  // private addresses (e.g. intranet names) are caught by assertPublicHost via
  // DNS at fetch time. Evaluating isPrivateOrReservedIp on a domain name like
  // "news.google.com" is a false positive (it isn't 4 numeric octets) and would
  // wrongly block every normal URL.
  const isIpLiteral = /^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) || parsed.hostname.includes(":");
  if (isIpLiteral && isPrivateOrReservedIp(parsed.hostname)) {
    throw new Error("Local/private network URLs cannot be scraped");
  }
  return parsed.toString();
}

async function fetchTextResource(url, accept = "text/html,application/xhtml+xml,text/plain", timeoutMs = 20000, userAgent = SCRAPE_USER_AGENT) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const validated = validateSourceUrl(url);
    const parsedHost = new URL(validated).hostname;
    await assertPublicHost(parsedHost); // resolve + reject private/loopback before fetching
    const response = await fetch(validated, {
      headers: { "User-Agent": userAgent, Accept: accept },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    // The redirect chain may have landed on a private IP (redirect: "follow").
    // Re-validate the FINAL url so a 302 to 169.254.169.254 etc. is blocked.
    await assertPublicHost(new URL(response.url).hostname);
    return {
      text: await response.text(),
      url: response.url,
      contentType: response.headers.get("content-type") || "",
    };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Source extraction timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractTitle(html) {
  const openGraph = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i.exec(html);
  if (openGraph) return decodeHtmlEntities(openGraph[1]).trim();
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? stripHtml(match[1]).trim() : "";
}

function extractMetaDescription(html) {
  const match = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i.exec(html);
  return match ? decodeHtmlEntities(match[1]).trim() : "";
}

function collectStructuredArticleBodies(html) {
  const bodies = [];
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const visit = value => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object") return;
    if (typeof value.articleBody === "string") bodies.push(value.articleBody);
    if (typeof value.transcript === "string") bodies.push(value.transcript);
    Object.values(value).forEach(visit);
  };
  scripts.forEach(script => {
    const jsonText = script.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try { visit(JSON.parse(jsonText)); } catch { /* Ignore malformed embedded metadata. */ }
  });
  return bodies;
}

// Pre-compiled (these run inside loops over scraped docs / RSS articles, so
// compiling per call would be a real cost on the hot path).
const RE_ARTICLE = new RegExp(`<article\\b[^>]*>([\\s\\S]*?)<\\/article>`, "gi");
const RE_MAIN = new RegExp(`<main\\b[^>]*>([\\s\\S]*?)<\\/main>`, "gi");
const RE_ROLE_MAIN = /<([a-z0-9]+)\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/\1>/gi;
function extractMainHtml(html) {
  const candidates = [];
  for (const match of html.matchAll(RE_ARTICLE)) candidates.push(match[1]);
  for (const match of html.matchAll(RE_MAIN)) candidates.push(match[1]);
  for (const match of html.matchAll(RE_ROLE_MAIN)) candidates.push(match[2]);
  return candidates.sort((a, b) => stripHtml(b).length - stripHtml(a).length)[0] || html;
}

function cleanExtractedLines(text) {
  const boilerplate = /^(accept (all )?cookies|cookie settings|privacy policy|terms of use|sign in|log in|subscribe|newsletter|advertisement|skip to content|share this|related articles?)$/i;
  const seen = new Set();
  return text
    .split(/\n+/)
    .map(line => line.replace(/[ \t]+/g, " ").trim())
    .filter(line => line && !boilerplate.test(line))
    .filter(line => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractText(html) {
  const structuredBodies = collectStructuredArticleBodies(html);
  if (structuredBodies.length) {
    const structured = cleanExtractedLines(decodeHtmlEntities(structuredBodies.sort((a, b) => b.length - a.length)[0]));
    if (structured.length >= 300) return structured.slice(0, 60000);
  }

  let clean = extractMainHtml(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|nav|header|footer|aside|noscript|svg|form|button)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|article|section|blockquote|figure)[^>]*>/gi, "\n");
  clean = cleanExtractedLines(stripHtml(clean));
  if (clean.length < 200) clean = extractMetaDescription(html) || clean;
  return clean.slice(0, 60000);
}

// ============================================================================
// Reader proxy (Suggested Updates split-screen reader)
// ----------------------------------------------------------------------------
// On-demand, hardened fetch of a single PUBLIC article, returned as extracted
// TEXT ONLY (no raw HTML) so the client can render it with textContent and
// there is no XSS surface. It reuses the existing SSRF guard chain
// (validateSourceUrl + assertPublicHost) and additionally:
//   - follows redirects MANUALLY, re-validating the host of EVERY hop
//     (defends against a 302 landing on a private/loopback address);
//   - streams the body with a hard byte cap (default 5 MB, READER_MAX_BYTES);
//   - enforces a per-request timeout (default 20s, READER_TIMEOUT_MS);
//   - restricts accepted content types to html/xhtml/plain/xml.
// The route is rate-limited per IP and rejects cross-origin callers.
// ============================================================================

// Per-IP rate-limiter factory (sliding window). check(key) returns true while
// under budget, false once the window is saturated.
function createRateLimiter({ max = 30, windowMs = 60000 } = {}) {
  const hits = new Map();
  return function check(key) {
    const now = Date.now();
    const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}

// Stream a response body, throwing if it exceeds maxBytes. Returns a Buffer.
async function readStreamWithCap(response, maxBytes) {
  if (!response.body || !response.body.getReader) {
    const buf = Buffer.from(await response.text());
    if (buf.length > maxBytes) throw new Error("Response too large");
    return buf;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    if (total + value.length > maxBytes) throw new Error("Response too large");
    total += value.length;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

const READER_MAX_BYTES = Number(process.env.READER_MAX_BYTES) || 5 * 1024 * 1024;
const READER_MAX_REDIRECTS = Number(process.env.READER_MAX_REDIRECTS) || 5;
const READER_TIMEOUT_MS = Number(process.env.READER_TIMEOUT_MS) || 20000;
const readerRateLimiter = createRateLimiter({
  max: Number(process.env.READER_RATE_MAX) || 30,
  windowMs: Number(process.env.READER_RATE_WINDOW_MS) || 60000,
});

// Governed central extractor (Phase 1 of the BI-grade pipeline). Routes article
// extraction through the server-side Jina reader so text is retrievable where a
// direct Render fetch cannot (Google consent wall, publisher egress blocks).
const extractor = createExtractor({
  validateSourceUrl,
  assertPublicHost,
  readStreamWithCap,
  SCRAPE_USER_AGENT,
  READER_MAX_BYTES,
  READER_TIMEOUT_MS,
  readerRateLimiter,
  JINA_API_KEY: config.JINA_API_KEY,
  // Phase 4 extractor seam: default to Jina (free, already integrated). Set
  // EXTRACTOR_PROVIDER=firecrawl + FIRECRAWL_API_KEY to swap providers without
  // touching call sites — see lib/extractor.js for the adapter contract.
  provider: process.env.EXTRACTOR_PROVIDER || "jina",
  FIRECRAWL_API_KEY: process.env.FIRECRAWL_API_KEY || "",
});

// Option A fallback for Google News links. A server-side fetch can never follow
// news.google.com to the real publisher (it hits the consent wall or a JS shell
// served as a 200). But the *viewer* page — the same article id with /rss/ stripped
// from the path — still carries the headline and a short description in its HTML
// and meta tags. We attempt one best-effort read of that page and return whatever
// readable text we can as a PARTIAL preview, so the reader shows something useful
// instead of a dead-end error. Returns a result object, or null if nothing usable
// was extracted (e.g. consent wall, boilerplate, empty response).
async function tryGoogleViewerFallback(googleUrl) {
  if (googleViewerCache.has(googleUrl)) return googleViewerCache.get(googleUrl);
  if (googleViewerNegativeCache.has(googleUrl)) return null;
  let viewerUrl;
  try {
    const u = new URL(googleUrl);
    u.pathname = u.pathname.replace(/^\/rss\//i, "/"); // /rss/articles/<id> -> /articles/<id>
    viewerUrl = u.toString();
  } catch {
    googleViewerNegativeCache.add(googleUrl);
    return null;
  }
  const seen = new Set();
  let current = viewerUrl;
  let result = null;
  for (let hop = 0; hop <= READER_MAX_REDIRECTS; hop++) {
    if (seen.has(current)) break;
    seen.add(current);
    const host = new URL(current).hostname;
    // Can't pass Google's consent/auth wall server-side — genuine dead end.
    if (/(^|\.)(consent|accounts)\.google\.com$/i.test(host)) break;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READER_TIMEOUT_MS);
    try {
      const res = await fetch(current, {
        headers: {
          "User-Agent": SCRAPE_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain,application/xml",
          // Best-effort consent bypass; ignored when Google serves it by IP region.
          Cookie: "CONSENT=YES+cb.0",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        const next = new URL(res.headers.get("location"), current).toString();
        const nextHost = new URL(next).hostname;
        if (/(^|\.)(consent|accounts)\.google\.com$/i.test(nextHost)) break;
        current = next;
        continue;
      }
      if (!res.ok) break;
      const ct = res.headers.get("content-type") || "";
      if (!/(text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml)/i.test(ct)) break;
      const buf = await readStreamWithCap(res, READER_MAX_BYTES);
      const html = buf.toString("utf8");
      const text = extractText(html);
      if (isGoogleNewsBoilerplate(text)) break; // only the aggregator shell
      const clean = text.trim();
      if (clean.length < 120) break;            // not enough to be useful
      const finalUrl = res.url || current;
      const title = extractTitle(html) || new URL(finalUrl).hostname;
      result = { title, text: clean, url: googleUrl, excerpt: clean.slice(0, 400), partial: true, resolvedVia: "google-viewer" };
      break;
    } catch (err) {
      if (err && err.name === "AbortError") break;
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  if (result) googleViewerCache.set(googleUrl, result);
  else googleViewerNegativeCache.add(googleUrl);
  return result;
}

function normalizeExtracted(extracted, fallbackUrl) {
  return {
    title: extracted.title || (extracted.attribution && extracted.attribution.source) || "",
    text: extracted.text,
    url: extracted.url || fallbackUrl,
    excerpt: extracted.excerpt || (extracted.text ? extracted.text.slice(0, 400) : ""),
    attribution: extracted.attribution,
    via: "extractor",
  };
}

function safeHostOf(u) {
  if (typeof u !== "string") return "";
  try { return new URL(u).hostname; } catch { return ""; }
}

// When the ONLY signal we have about an article's source is Google's aggregator
// host (news.google.com — the RSS redirect URL, or a Jina read of that URL),
// prefer the REAL publisher name we already captured from the feed's <source>
// tag (e.g. "Reuters"). This stops the reader credit from mislabelling an
// article as "Source: news.google.com" when we actually know the publisher.
// It is a label-only override: the (often unresolvable) URL is preserved so the
// credit link still opens the article; only the displayed source name changes.
function applyRealSource(obj, publisher) {
  if (!obj || typeof obj !== "object") return obj;
  const pub = (typeof publisher === "string" ? publisher : "").trim();
  if (!pub) return obj;
  const attr = obj.attribution && typeof obj.attribution === "object" ? obj.attribution : null;
  const host = safeHostOf(attr ? attr.url : "") || safeHostOf(obj.url);
  const src = attr ? (attr.source || "") : "";
  const isAggregator = /(^|\.)news\.google\.com$/i.test(host) || /news\.google\.com/i.test(src);
  // Override when the source is the aggregator, OR when we have no attribution
  // at all (e.g. a stored proposal whose credit was never populated) — in both
  // cases the known publisher name is strictly better than nothing/Google.
  if (isAggregator || !attr) {
    obj.attribution = {
      source: pub,
      title: (attr && attr.title) || obj.title || "",
      url: (attr && attr.url) || obj.url || "",
      retrievedAt: (attr && attr.retrievedAt) || new Date().toISOString(),
      licenseClass: (attr && attr.licenseClass) || obj.licenseClass || "news-fair-use",
    };
  }
  return obj;
}

async function fetchReaderContent(url, opts = {}) {
  const maxBytes = Number(opts.maxBytes) || READER_MAX_BYTES;
  const timeoutMs = Number(opts.timeoutMs) || READER_TIMEOUT_MS;
  const maxRedirects = Number(opts.maxRedirects) || READER_MAX_REDIRECTS;
  if (!url || typeof url !== "string") throw new Error("A valid source URL is required");

  let target = validateSourceUrl(url.slice(0, 2000));
  const licenseClass = opts.licenseClass || "news-fair-use";
  const sourceId = opts.sourceId || null;

  // Google News links can't be scraped directly — they 302 to a consent/GDPR
  // wall from Render's egress, and the local resolver that once resolved them
  // now fails 100% of the time here. Skip it and let the governed Jina
  // extraction below follow the redirect server-side instead.

  // Still a Google News link: attempt governed Jina
  // extraction — Jina follows the Google redirect and renders JS server-side,
  // so it often retrieves what a direct fetch cannot. Fall back to the viewer
  // partial preview (Option A), then to the manual-entry marker.
  if (/news\.google\.com/i.test(target)) {
    try {
      const viaJina = await extractor.extractArticle(target, { licenseClass, sourceId });
      if (viaJina && viaJina.text && viaJina.text.trim().length >= 120) {
        return normalizeExtracted(viaJina, target);
      }
    } catch (_) { /* fall through to viewer fallback */ }
    const viewer = await tryGoogleViewerFallback(target);
    if (viewer) return viewer;
    return {
      unresolved: true,
      reason: "google-news",
      url: target,
      message: "Could not resolve this Google News link to its original source",
    };
  }

  // Real (non-Google) publisher URL: governed central extraction via Jina. This
  // is what fixes the pasted-URL "Could not retrieve the source" failure — the
  // extraction happens on Jina's infrastructure, not Render's restricted egress.
  try {
    const extracted = await extractor.extractArticle(target, { licenseClass, sourceId });
    if (extracted && extracted.restricted) {
      // Let the single licence-gate boundary (applyLicenseGate, in /api/reader)
      // shape the response — it stamps gated/gateReason and the standardised
      // license class so the client's restricted notice + badge fire reliably.
      return extracted;
    }
    if (extracted && extracted.text && extracted.text.trim().length >= 120) {
      return normalizeExtracted(extracted, target);
    }
  } catch (_) { /* fall through to legacy direct fetch */ }

  // Legacy direct server fetch — retained as a resilient fallback (and the
  // sandbox/test path). Mirrors the original SSRF-hardened behaviour.
  let legacyResult;
  try {
    await assertPublicHost(new URL(target).hostname);

  const seen = new Set();
  let current = target;
  let response = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (seen.has(current)) throw new Error("Redirect loop detected");
    seen.add(current);
    await assertPublicHost(new URL(current).hostname);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        headers: {
          "User-Agent": SCRAPE_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain,application/xml",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      // Not a redirect -> this is the final response.
      if (!(res.status >= 300 && res.status < 400) || !res.headers.get("location")) {
        response = res;
        break;
      }
      const nextHop = new URL(res.headers.get("location"), current).toString();
      await assertPublicHost(new URL(nextHop).hostname); // re-validate BEFORE following
      current = nextHop;
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Source extraction timed out");
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  if (!response) throw new Error("Too many redirects");
  if (!response.ok) throw new Error("Source returned HTTP " + response.status);

  const contentType = response.headers.get("content-type") || "";
  if (!/(text\/html|application\/xhtml\+xml|text\/plain|application\/xml|text\/xml)/i.test(contentType)) {
    throw new Error("Unsupported source content type: " + (contentType || "unknown"));
  }
  const buf = await readStreamWithCap(response, maxBytes);
  const html = buf.toString("utf8");
  const text = extractText(html);
  // Defense-in-depth: even if the URL wasn't recognised as a Google News
  // redirect, reject the aggregator boilerplate so the user never sees it.
  if (isGoogleNewsBoilerplate(text)) {
    throw new Error("Could not resolve this Google News link to its original source");
  }
  const finalUrl = response.url || current;
  const title = extractTitle(html) || new URL(finalUrl).hostname;
    legacyResult = { title, text, url: finalUrl, excerpt: text.slice(0, 400) };
  } catch (err) {
    // Jina extraction AND the direct fetch both failed. Treat clearly invalid
    // input (bad scheme, blocked host, unsupported type, too many redirects,
    // HTTP error) as a hard error so the route can still 400/413 it; for a
    // genuine extraction failure, return a structured {unresolved} marker so
    // the reader shows the manual-entry panel instead of a dead-end 502.
    if (/valid source URL|Only HTTP|Local|Blocked address|Unsupported source content type|Too many redirects|Redirect loop|Source returned HTTP/i.test(err.message)) {
      throw err;
    }
    return {
      unresolved: true,
      reason: "extraction-failed",
      url: target,
      message: "We couldn't automatically retrieve the article text from this source. You can review it manually by pasting the URL or the full text below.",
    };
  }
  return legacyResult;
}

// Defense-in-depth against CSRF-style abuse: reject cross-origin callers.
// Same-origin browser requests typically omit the Origin header, so its absence
// is allowed; if present it must match the request Host exactly.
function assertSameOrigin(req) {
  const origin = req.get("origin");
  if (!origin) return;
  let originHost;
  try { originHost = new URL(origin).host; } catch { throw new Error("Invalid Origin header"); }
  if (originHost !== req.get("host")) throw new Error("Cross-origin requests are not allowed");
}

app.get("/api/reader", async (req, res) => {
  try {
    try { assertSameOrigin(req); }
    catch { return res.status(403).json({ error: "Cross-origin requests are not allowed" }); }

    const url = req.query.url;
    const id = typeof req.query.id === "string" ? req.query.id : "";
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";

    if (!url || typeof url !== "string") {
      if (!id) return res.status(400).json({ error: "A url query parameter is required" });
    }
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    if (!readerRateLimiter(ip)) {
      return res.status(429).json({ error: "Too many requests, please slow down" });
    }

    // Phase 3 — store viewer: serve stored content without a live fetch when we
    // already have it and the caller hasn't explicitly asked to refresh.
    if (id && !refresh) {
      const prop = (proposedChanges.items || []).find(i => i.id === id);
      if (prop && (prop.body || prop.preview)) {
        // Lazy summarisation: items fetched before summaries were wired (or whose
        // summary was skipped by a rate-limit) get an AI summary on open so the
        // reader pane is never left as raw text. Best-effort; never blocks render.
        if (prop.body && !prop.styledSummary) {
          try {
            await summariseStoredItem(prop, { force: true });
            saveProposed();
          } catch (_) { /* non-fatal */ }
        }
        const storeObj = {
          fromStore: true,
          title: prop.title || "",
          text: prop.body || prop.preview || "",
          styledSummary: prop.styledSummary || null,
          url: prop.url || url || "",
          publisher: prop.publisher || "",
          snippet: prop.snippet || "",
          retentionState: prop.retentionState || "full",
          partial: false,
          licenseClass: prop.licenseClass || "open",
          sourceDomain: prop.sourceDomain || "",
          ingestedAt: prop.ingestedAt || null,
          attribution: prop.attribution || undefined,
        };
        // Prefer the publisher captured at scan time; fall back to the name the
        // client read off the proposal card (covers items ingested before the
        // publisher field existed).
        const storePublisher = storeObj.publisher
          || (typeof req.query.publisher === "string" ? req.query.publisher : "");
        return res.json(applyLicenseGate(applyRealSource(storeObj, storePublisher), { internal: true }));
      }
    }

    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "A url query parameter is required to fetch from source" });
    }
    // Resolve the governance license class for this fetch. Prefer an explicit
    // request override; otherwise derive it from the linked proposal so the
    // attribution badge reflects the source's TRUE class (open / news-fair-use
    // / …) instead of the extractor's news-fair-use default. This keeps the
    // licence gate honest end-to-end (the store path already does this).
    let resolvedLicenseClass = typeof req.query.licenseClass === "string" ? req.query.licenseClass : undefined;
    if (!resolvedLicenseClass && id) {
      const sp = (proposedChanges.items || []).find(i => i.id === id);
      if (sp && sp.licenseClass) resolvedLicenseClass = sp.licenseClass;
    }
    const result = await fetchReaderContent(url, {
      title: typeof req.query.title === "string" ? req.query.title : "",
      domain: typeof req.query.domain === "string" ? req.query.domain : "",
      publisher: typeof req.query.publisher === "string" ? req.query.publisher : "",
      licenseClass: resolvedLicenseClass,
      sourceId: typeof req.query.sourceId === "string" ? req.query.sourceId : undefined,
    });
    // Persist the resolved body back into the shared store so the next open is
    // instant and no longer depends on the (often-failing) Google resolution.
    if (id && result && result.text && result.text.trim().length >= 120) {
      try { await writeStoreBody(id, result.text); } catch (_) { /* non-fatal */ }
    }
    // Surface any AI summary we just generated so the reader pane can show it
    // immediately (the manual paste-URL path stores the body via writeStoreBody).
    const publisher = typeof req.query.publisher === "string" ? req.query.publisher : "";
    const out = applyLicenseGate(applyRealSource({
      ...result,
      licenseClass: result.licenseClass
        || resolvedLicenseClass
        || (result.attribution && result.attribution.licenseClass)
        || "open",
    }, publisher), { internal: true });
    if (id) {
      const sp = (proposedChanges.items || []).find(i => i.id === id);
      if (sp && sp.styledSummary) out.styledSummary = sp.styledSummary;
    }
    res.json(out);
  } catch (err) {
    // Generic error mapping — never leak internals (hosts, stack traces).
    const msg = err && err.message ? err.message : "";
    const code = /required|valid source/i.test(msg) ? 400
      : /too large/i.test(msg) ? 413
      : 502; // timeout, redirect loop, unsupported type, blocked/private host, DNS failure
    const message = code === 400 ? "A valid source URL is required"
      : code === 413 ? "The source response exceeded the size limit"
      : /original source/i.test(msg) ? "Could not resolve this Google News link to its original source"
      : "Could not retrieve the source";
    res.status(code).json({ error: message });
  }
});

// Write manually-supplied content (pasted article text, or a corrected URL)
// back into the shared store so it persists across reloads. Reuses the admin
// gate used by the other mutating proposal endpoints (a no-op when
// ADMIN_API_KEY is unset, preserving current behaviour). No outbound fetch —
// we only store what the user provided.
app.post("/api/reader/store", requireAdmin, async (req, res) => {
  try {
    const id = req.body && req.body.id;
    if (!id) return res.status(400).json({ error: "id is required" });
    const text = req.body && typeof req.body.text === "string" ? req.body.text : "";
    const url = req.body && typeof req.body.url === "string" ? req.body.url : null;
    const result = await storeManualContent(id, text, url);
    if (result.error === "not found") return res.status(404).json({ error: "Proposal not found" });
    res.json({ success: true, styledSummary: result.styledSummary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getYouTubeVideoId(input) {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (["youtube.com", "m.youtube.com"].includes(host)) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      if (["shorts", "embed", "live"].includes(parts[0])) return parts[1] || null;
    }
  } catch { return null; }
  return null;
}

function findJsonArrayAfterMarker(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("[", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseCaptionText(raw, contentType = "") {
  try {
    if (contentType.includes("json") || raw.trim().startsWith("{")) {
      const json = JSON.parse(raw);
      const chunks = [];
      for (const event of json.events || []) {
        const text = (event.segs || []).map(segment => segment.utf8 || "").join("");
        if (text.trim()) chunks.push(text.trim());
      }
      return cleanExtractedLines(chunks.join(" ").replace(/\s+/g, " "));
    }
  } catch { /* Fall through to XML/VTT parsing. */ }

  if (/^WEBVTT/m.test(raw) || /-->/.test(raw)) {
    const lines = raw.split(/\r?\n/).filter(line => {
      const trimmed = line.trim();
      return trimmed && !/^WEBVTT|^NOTE|^\d+$/.test(trimmed) && !/-->/.test(trimmed);
    });
    return cleanExtractedLines(stripHtml(lines.join(" ")).replace(/\s+/g, " "));
  }

  const textParts = [...raw.matchAll(/<(?:text|p)[^>]*>([\s\S]*?)<\/(?:text|p)>/gi)]
    .map(match => stripHtml(match[1]));
  return cleanExtractedLines(textParts.join(" ").replace(/\s+/g, " "));
}

function extractYouTubeTranscriptWithPython(videoId) {
  return new Promise((resolve, reject) => {
    if (!PYTHON) return reject(new Error("Python not available — transcript extraction disabled on this host"));
    execFile(PYTHON, [TRANSCRIPT_SCRIPT, videoId], { timeout: 30000 }, (error, stdout, stderr) => {
      let parsed;
      try { parsed = JSON.parse(stdout || "{}"); } catch { parsed = null; }
      if (error || parsed?.error || !parsed?.data?.text) {
        return reject(new Error(parsed?.error || stderr || error?.message || "Transcript extraction failed"));
      }
      resolve(parsed.data);
    });
  });
}

async function extractYouTubeTranscript(url, videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const page = await fetchTextResource(watchUrl);
  const title = extractTitle(page.text).replace(/\s*-\s*YouTube\s*$/i, "") || `YouTube video ${videoId}`;
  const tracksJson = findJsonArrayAfterMarker(page.text, '"captionTracks":');
  if (tracksJson) {
    try {
      const tracks = JSON.parse(tracksJson);
      const selected = tracks.find(track => /^en(?:-|$)/i.test(track.languageCode || "")) || tracks[0];
      if (selected?.baseUrl) {
        const transcriptUrl = new URL(selected.baseUrl);
        transcriptUrl.searchParams.set("fmt", "json3");
        const transcriptResponse = await fetchTextResource(transcriptUrl.toString(), "application/json,text/xml,text/plain");
        const text = parseCaptionText(transcriptResponse.text, transcriptResponse.contentType);
        if (text.length >= 80) {
          return {
            title,
            text,
            url: page.url,
            originalUrl: url,
            sourceType: "video-transcript",
            extractionMethod: `YouTube ${selected.kind === "asr" ? "automatic captions" : "captions"}`,
            language: selected.languageCode || "unknown",
          };
        }
      }
    } catch { /* Fall back to the dedicated transcript client below. */ }
  }

  try {
    const transcript = await extractYouTubeTranscriptWithPython(videoId);
    return {
      title,
      text: transcript.text,
      url: page.url,
      originalUrl: url,
      sourceType: "video-transcript",
      extractionMethod: `YouTube ${transcript.generated ? "automatic transcript" : "transcript"}`,
      language: transcript.language || "unknown",
    };
  } catch (error) {
    throw new Error(`This YouTube video does not expose an accessible transcript: ${error.message}`);
  }
}

function findHtmlCaptionTrack(html, pageUrl) {
  const tags = html.match(/<track\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/kind=["'](?:captions|subtitles)["']/i.test(tag)) continue;
    const src = /src=["']([^"']+)["']/i.exec(tag)?.[1];
    if (src) return new URL(decodeHtmlEntities(src), pageUrl).toString();
  }
  return null;
}

async function scrapeUrl(url, opts = {}) {
  const sourceUrl = validateSourceUrl(url);
  const youtubeId = getYouTubeVideoId(sourceUrl);
  if (youtubeId) return extractYouTubeTranscript(sourceUrl, youtubeId);

  // Saved articles and scanner proposals arrive as news.google.com/rss/articles/...
  // redirect URLs that cannot be scraped directly (they return a bot-wall / dead
  // interstitial). Resolve them to the real publisher URL first — the same
  // resolver the background scanner uses — so the live article body is fetched
  // and summarised instead of a useless redirect page. If resolution fails we
  // fall through to the original URL and let fetchTextResource report the error.
  let effectiveUrl = sourceUrl;
  // Google News links can't be scraped directly (consent/GDPR wall from Render's
  // egress) and the local resolver that once resolved them now fails 100% of
  // the time here. Resolve via Jina's server-side extraction instead, which
  // follows the redirect and renders JS, so we get the real article body.
  if (/news\.google\.com/i.test(sourceUrl)) {
    try {
      const jt = await jinaExtract(sourceUrl, 20000);
      if (jt && jt.length >= 140 && !looksLikeBotWall(jt)) {
        return {
          title: opts.title || new URL(sourceUrl).hostname,
          text: jt,
          url: sourceUrl,
          originalUrl: sourceUrl,
          sourceType: "webpage",
          extractionMethod: "Jina (Google News redirect resolved server-side)",
          language: "unknown",
        };
      }
    } catch (_) { /* fall through to direct fetch */ }
  }

  const page = await fetchTextResource(effectiveUrl);
  if (!page.contentType.includes("html") && !page.contentType.includes("text")) {
    throw new Error(`Unsupported source content type: ${page.contentType || "unknown"}`);
  }

  const title = extractTitle(page.text) || new URL(page.url).hostname;
  const captionTrack = findHtmlCaptionTrack(page.text, page.url);
  if (captionTrack) {
    const captionResponse = await fetchTextResource(captionTrack, "text/vtt,text/plain,text/xml,application/json");
    const transcript = parseCaptionText(captionResponse.text, captionResponse.contentType);
    if (transcript.length >= 80) {
      return {
        title,
        text: transcript,
        url: page.url,
        originalUrl: sourceUrl,
        sourceType: "video-transcript",
        extractionMethod: "Embedded caption track",
        language: "unknown",
      };
    }
  }

  const text = extractText(page.text);
  if (text.length < 80) throw new Error("The page did not contain enough readable text to summarise");
  return {
    title,
    text,
    url: page.url,
    originalUrl: sourceUrl,
    sourceType: "webpage",
    extractionMethod: "Main article/page text",
    language: "unknown",
  };
}

const SUMMARY_STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "among", "and", "are", "because", "been", "before",
  "being", "between", "both", "but", "can", "could", "did", "does", "each", "for", "from", "had",
  "has", "have", "into", "its", "more", "most", "not", "only", "other", "our", "out", "over", "said",
  "such", "than", "that", "the", "their", "there", "these", "they", "this", "through", "under", "very",
  "was", "were", "what", "when", "where", "which", "while", "who", "will", "with", "would", "you", "your"
]);

// Sentence splitting must not break on the decimal point inside numbers
// (e.g. "22.3 trillion" must survive as "22.3", not collapse to "3") nor on the
// period in common abbreviations ("U.S.", "Mr.", "e.g.", ...). We mask those
// tokens before splitting and restore them afterwards. Control chars are used
// as delimiters because they never appear in normal prose and survive the
// [^.!?]+ split untouched.
const SPLIT_MASK_OPEN = "\x01";
const SPLIT_MASK_CLOSE = "\x02";
const SPLIT_RESTORE_RE = new RegExp(`${SPLIT_MASK_OPEN}(\\d+)${SPLIT_MASK_CLOSE}`, "g");
const DECIMAL_RE = /\d+\.\d+/g;
const ABBREV_RE = /\b(?:U\.S\.A?|U\.K\.|Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|vs\.|e\.g\.|i\.e\.|Co\.|Inc\.|Ltd\.|St\.|Ave\.|Sr\.|Jr\.|No\.|vol\.|Fig\.|et al\.|approx\.|dept\.|Corp\.|Bros\.|Capt\.|Gen\.|Sgt\.|Col\.|Ph\.D\.|M\.D\.)(?![A-Za-z0-9])/g;

function splitSentences(text) {
  const masks = [];
  const mask = (token) => {
    masks.push(token);
    return `${SPLIT_MASK_OPEN}${masks.length - 1}${SPLIT_MASK_CLOSE}`;
  };
  let working = (text || "")
    .replace(/\s+/g, " ")
    .replace(DECIMAL_RE, mask)   // protect "22.3", "1.5 billion", IPs, etc.
    .replace(ABBREV_RE, mask);    // protect "U.S.", "e.g.", "vs.", ...
  const segments = working.match(/[^.!?]+(?:[.!?]+|$)/g);
  if (!segments) return [];
  return segments
    .map(segment => segment.replace(SPLIT_RESTORE_RE, (_, i) => masks[Number(i)] ?? "").trim())
    .filter(sentence => sentence.length >= 45 && sentence.length <= 500);
}

function meaningfulWords(text) {
  return (String(text || "").toLowerCase().match(/[a-z][a-z0-9'-]{1,}/g) || [])
    .filter(word => (word.length >= 3 || ["ai", "ar", "vr", "xr"].includes(word)) && !SUMMARY_STOP_WORDS.has(word));
}

function isNearDuplicate(a, b, threshold = 0.72) {
  const aWords = new Set(meaningfulWords(a));
  const bWords = new Set(meaningfulWords(b));
  const overlap = [...bWords].filter(word => aWords.has(word)).length;
  return overlap / Math.max(Math.min(aWords.size, bWords.size), 1) > threshold;
}

function refineSentence(sentence) {
  const cleaned = String(sentence || "")
    .replace(/\s+/g, " ")
    .replace(/^(?:read more|advertisement|sponsored content)[:\s-]*/i, "")
    .trim();
  if (cleaned.length <= 360) return cleaned;
  const shortened = cleaned.slice(0, 357);
  const boundary = Math.max(shortened.lastIndexOf(";"), shortened.lastIndexOf(","), shortened.lastIndexOf(" "));
  return `${shortened.slice(0, boundary > 250 ? boundary : 357).trim()}...`;
}

// Domains to exclude from news results (encyclopedias, company homepages, etc.)
const NEWS_EXCLUDED_DOMAINS = [
  "wikipedia.org",
  "wikidata.org",
  "britannica.com",
  "crunchbase.com",
  "linkedin.com",
  "bloomberg.com/profile",
];

// ===== API ROUTES =====

// POST /api/search — web search via the provider chain (tavily -> brave -> jina)
// Cache results by normalized query+limit so repeated identical searches hit the
// upstream provider at most once per TTL window. Saves the 1k/mo Tavily budget on
// repeat queries and drops latency to ~instant. (Step 2c Fix #2)
const searchResultsCache = new Map(); // key -> { ts, payload }
const SEARCH_CACHE_TTL_MS = 2 * 60 * 1000;
app.post("/api/search", whenAuth(requireAuth), async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    const cacheKey = `${String(query).trim().toLowerCase()}::${limit}`;
    const hit = searchResultsCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < SEARCH_CACHE_TTL_MS) {
      return res.json({ ...hit.payload, cached: true });
    }

    const { results, provider } = await searchProvider.searchWeb(query, { limit });
    // `provider` tells the caller WHICH leg answered, so a degraded search is
    // visible instead of silent.
    const payload = { success: true, data: results, total: results.length, provider };
    if (searchResultsCache.size > 500) searchResultsCache.clear();
    searchResultsCache.set(cacheKey, { ts: Date.now(), payload });
    res.json({ ...payload, cached: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summarise/status — describe the evidence and model setup.
// The AI model runs on every answer, with an extractive-citation fallback when unavailable.
app.get("/api/summarise/status", (req, res) => {
  try {
    res.json({
      success: true,
      corpusItems: buildCorpus().length,
      model: DEFAULT_MODEL,
      scanModel: OPEN_MODEL_NAME_SCAN,
      license: "open-weight (hosted)",
      localModel: false,
      modelOptIn: true,
      defaultMode: "extractive-citation",
      modelLoaded: isModelReady(),
      scanModelLoaded: isScanModelReady(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/summarise — answer questions from app data, synthesised by the
// hosted open-source model on EVERY answer (graceful extractive fallback if the
// model is unavailable). Optional web evidence is included only when the caller
// sends useInternet=true (the single "Includes Internet Sources" tickbox); raw
// web hits are dropped server-side if the model can't synthesise them.
app.post("/api/summarise", whenAuth(requireAuth), async (req, res) => {
  try {
    const question = String(req.body?.question || "").replace(/\s+/g, " ").trim();
    // PR #90 — Hybrid translation: the client sends the active UI language so
    // the model can answer in-language. Only 'zh-CN' triggers Chinese output;
    // anything else (including an unset body) defaults to English.
    const lang = req.body?.lang === "zh-CN" ? "zh-CN" : "en";
    const useInternet = req.body?.useInternet === true;
    // AI now runs on every answer by default. An explicit useModel:false is the
    // only opt-out (reserved); the UI always sends true.
    const useModel = req.body?.useModel !== false;
    if (!question) return res.status(400).json({ error: "Enter a question" });
    if (question.length > 700) return res.status(400).json({ error: "Question must be 700 characters or fewer" });

    const appEvidence = [];
    try {
      appEvidence.push(...retrieveApplicationEvidence(question, 9));
    } catch (err) {
      console.warn("[summarise] evidence retrieval failed:", err.message);
    }
    // Phase 3a: user-supplied "My Sources" (saved News articles) attached from
    // the Q&A tab. Each becomes an [S#] evidence item the model can cite. We
    // enrich with the FULL article text (fetched from the saved URL) so the
    // model integrates the real content, not just the RSS description, and we
    // cap the count + sanitise so a malformed/massive payload can't blow up the
    // context window. Missing text is fine (title-only sources still cite).
    let userEvidence = [];
    try {
      const incoming = Array.isArray(req.body?.userSources) ? req.body.userSources : [];
      const baseSources = incoming
        .filter(s => s && (s.title || s.text))
        .slice(0, 20)
        .map((s, index) => ({
          id: `S${index + 1}`,
          sourceType: "user",
          dataset: "My Sources",
          title: String(s.title || "Untitled source").slice(0, 200),
          section: "User-supplied context",
          text: String(s.text || "").slice(0, 4000),
          excerpt: String(s.text || s.title || "").slice(0, 360),
          url: s.url ? String(s.url).slice(0, 2000) : undefined,
        }));
      // Fetch full article text where a URL exists (bounded concurrency).
      // Failures fall back to the snippet, so enrichment never breaks the answer.
      userEvidence = await mapWithConcurrency(baseSources, 4, async (src) => {
        if (!src.url) return src;
        const full = await fetchArticleBody(src.url, src.text, src.title);
        if (full === src.text) return src;
        return { ...src, text: full, excerpt: full.slice(0, 360) };
      });
    } catch (_) { /* ignore malformed userSources */ }

    // Thread D: shared, team-side sources an editor added to the library. Each
    // becomes a [T#] evidence item (citable like [W#]). They are OPT-IN: the
    // client only sends teamSourceIds when the user opens the "Team Sources"
    // composer toggle. When none are requested we inject nothing, so team
    // evidence is never auto-loaded into every answer (saves tokens and makes
    // the "retrieved, not cited" disclosure meaningful). Degrades to [] on DB
    // error so it never blocks the answer.
    let teamEvidence = [];
    try {
      const requestedTeamIds = Array.isArray(req.body?.teamSourceIds) ? req.body.teamSourceIds : [];
      if (requestedTeamIds.length) {
        const allTeam = await sources.loadTeamEvidence();
        teamEvidence = allTeam.filter(e => requestedTeamIds.includes(e.id));
      }
    } catch (_) { /* ignore — team evidence is additive */ }

    let webEvidence = [];
    let webSearchError = "";
    let internetSkipped = false;
    // When the user attached their own sources, cap the web results so the
    // user's hand-picked context isn't drowned out by internet noise.
    const webCap = userEvidence.length > 0 ? Math.max(2, 6 - userEvidence.length) : 5;

    // B1: if the KB + attached evidence already covers the question, skip the
    // web search entirely — saves a search call (and, below, any deep-fetches).
    const localEvidence = [...appEvidence, ...userEvidence, ...teamEvidence];
    if (useInternet && localEvidenceCovers(question, localEvidence)) {
      internetSkipped = true;
    } else if (useInternet) {
      try {
        // Fetch more candidates than we keep, then relevance-filter so off-topic
        // hits (e.g. dictionary definitions of a word in the question) are dropped
        // before they can pollute the answer. The "analysis" suffix nudges the
        // search engine away from generic/definition pages toward substantive
        // coverage. Runs through the provider chain, so a Tavily outage degrades
        // to Brave/Jina instead of dropping web evidence entirely.
        const webResults = await searchWeb(`${question} analysis`, 8);
        const filtered = webResultRelevance(question, webResults, 5);
        // Snippet-only for now (B2): full text is deep-fetched LATER, ONLY for
        // sources the model actually cites — so uncited hits never cost an
        // extraction. This is the core fix for the "collected 5, cited 0" waste.
        webEvidence = filtered
          .filter(item => item.url && (item.title || item.description))
          .slice(0, webCap)
          .map((item, index) => ({
            id: `W${index + 1}`,
            sourceType: "internet",
            dataset: "Internet search",
            title: item.title || item.url,
            section: "Additional evidence",
            text: String(item.description || item.title || "").slice(0, 900),
            excerpt: String(item.description || item.title || "").slice(0, 360),
            url: item.url,
            snippetOnly: true,
          }));
      } catch (error) {
        webSearchError = error.message;
      }
    }

    // OPTION A (updated): raw web evidence is only useful when the AI model
    // synthesises it. Since the AI now runs on every answer, the only way web
    // hits can't be synthesised is when the model is unavailable (no key) or the
    // caller explicitly opted out. In that case drop the raw web evidence so it
    // can never reach the extractive path (the bug we fixed). The single
    // "Includes Internet Sources" tickbox is the UI control; this is the
    // server-side backstop against malformed requests. (A skipped search needs
    // no dropping.)
    let internetDropped = false;
    if (useInternet && !internetSkipped && (!useModel || !isModelReady())) {
      webEvidence = [];
      internetDropped = true;
    }

    const evidence = [...appEvidence, ...userEvidence, ...teamEvidence, ...webEvidence];
    // Ground the answer in Chinese KB/web passages when the UI is Chinese.
    // The regulatory-focus instruction lives in the (language-independent)
    // base system prompt, so coupling here never dilutes the EU/UK AI-gaming
    // scope — it only localises the evidence text. (PR #91)
    const groundedEvidence = lang === "zh-CN" ? await kbTranslate.translateEvidence(evidence, lang) : evidence;
    let answer;
    let mode;
    let modelError = "";
    let modelTimer;

    if (useModel) {
      mode = "local-open-source-model";
      // Race a model call against the 70s warm-up timer; reuse one timer var so
      // the enrichment re-run below doesn't leak a dangling timeout.
      const raceModel = (p) => {
        if (modelTimer) clearTimeout(modelTimer);
        return Promise.race([
          p,
          new Promise((_, reject) => {
            modelTimer = setTimeout(
              () => reject(new Error("Local model is still warming up; an extractive summary was returned. Try again in a moment for an AI synthesis.")),
              70000
            );
          }),
        ]);
      };
      try {
        answer = await raceModel(generateOpenSourceAnswer(question, groundedEvidence, lang));
        // B2: deep-fetch full text ONLY for web sources the model actually
        // cited, then re-run once with the enriched evidence. If nothing was
        // cited, no extraction happens at all (the core token-saving fix). On
        // enrichment failure we keep the first (snippet-based) answer rather
        // than dropping to extractive.
        if (useInternet && !internetDropped && !internetSkipped && webEvidence.length) {
          const cited = citedWebIds(answer, webEvidence);
          const toFetch = webEvidence.filter(w => cited.includes(w.id) && w.snippetOnly);
          if (toFetch.length) {
            const enriched = await mapWithConcurrency(toFetch, 3, async (src) => {
              const full = await fetchCachedArticleBody(src.url, src.text, src.title);
              if (full === src.text) return src;
              return { ...src, text: full, excerpt: full.slice(0, 360), snippetOnly: false };
            });
            const byId = new Map(enriched.map(e => [e.id, e]));
            const enrichedEvidence = evidence.map(e => byId.get(e.id) || e);
            const groundedEnriched = lang === "zh-CN" ? await kbTranslate.translateEvidence(enrichedEvidence, lang) : enrichedEvidence;
            try {
              answer = await raceModel(generateOpenSourceAnswer(question, groundedEnriched, lang));
            } catch (_) { /* keep the first answer on enrichment failure */ }
          }
        }
      } catch (error) {
        modelError = error.message;
        mode = "extractive-fallback";
        answer = buildExtractiveAnswer(question, evidence);
      } finally {
        clearTimeout(modelTimer);
      }
    } else {
      mode = "extractive-citation";
      answer = buildExtractiveAnswer(question, evidence);
    }

    res.json({
      success: true,
      answer,
      question,
      internetUsed: webEvidence.length > 0,
      internetSkipped,
      internetDropped,
      webSearchError,
      model: {
        name: DEFAULT_MODEL,
        license: "open-weight (hosted)",
        mode,
        error: modelError,
        optIn: true,
      },
      sources: evidence.map(({ id, sourceType, dataset, title, section, url, text, excerpt }) => ({
        id,
        sourceType,
        dataset,
        title,
        section,
        url,
        excerpt: String(excerpt || text || "").slice(0, 360),
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news — multi-topic live news search using public RSS feeds.
// Google News RSS works without an API key or Python, making it reliable on Render.
// The bundled JSON cache remains the final fallback if every live feed fails.
const NEWS_TOPICS = [
  {
    label: "AI Technology Trends",
    queries: ["generative AI gaming world models agents video 3D technology"],
  },
  {
    label: "AI Regulation",
    queries: ["EU UK AI regulation big tech compliance enforcement copyright transparency"],
  },
  {
    label: "Current Use Cases",
    queries: ["AI gaming use cases NPC procedural content game development entertainment"],
  },
  {
    label: "Competitor News",
    queries: ["Tencent gaming AI technology news"],
  },
];

const DEFAULT_NEWS_COMPETITOR_IDS = ["netease", "mihoyo", "sony", "microsoft"];
let newsCompetitorCatalog = [];
try {
  const networkData = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "network.json"), "utf8"));
  newsCompetitorCatalog = networkData.competitors || [];
} catch (_) { /* News still works with broad topic searches. */ }

// --- User-added custom competitors (server-persisted, shared across users) ---
// On Render's free tier the disk is ephemeral (wiped on cold start), so this is
// durable only while the instance stays warm. The keep-alive cron keeps it up,
// which makes this behave the same as the existing daily-budget persistence.
// The file is gitignored so per-deployment user data is never committed.
const CUSTOM_COMPETITORS_FILE = path.join(__dirname, "data", "custom-competitors.json");
let customCompetitors = [];
try {
  const parsed = JSON.parse(fs.readFileSync(CUSTOM_COMPETITORS_FILE, "utf8"));
  if (Array.isArray(parsed)) customCompetitors = parsed;
} catch (_) { /* starts empty until a user adds one */ }

function saveCustomCompetitors() {
  try {
    fs.writeFileSync(CUSTOM_COMPETITORS_FILE, JSON.stringify(customCompetitors, null, 2));
  } catch (_) { /* non-fatal: the in-memory list still serves this process */ }
}

function resolveNewsCompetitors(value = "") {
  const requested = String(value).split(",").map(id => id.trim()).filter(Boolean);
  const ids = requested.length ? requested : DEFAULT_NEWS_COMPETITOR_IDS;
  const allowed = new Map(newsCompetitorCatalog.map(company => [company.id, company]));
  const customs = new Map(customCompetitors.map(company => [company.id, company]));
  return [...new Set(ids)].map(id => {
    const known = allowed.get(id) || customs.get(id);
    if (known) return known;
    // Unknown id => a user-added custom competitor (the id is the name the user
    // typed on the client). Synthesize a catalog entry so it still drives a
    // focused, phrase-based news query instead of being silently ignored.
    return { id, name: id, custom: true };
  });
}

let bundledNewsCache = null;
const newsCacheBySelection = new Map();
// Bound the per-selection news cache so it can't grow without limit, and expire
// entries after a short TTL so a stale selection stops being served forever.
const NEWS_CACHE_TTL_MS = 10 * 60 * 1000; // 10 min
const NEWS_CACHE_MAX = 50;
// Step 2c: serve a fresh-enough cached result instead of re-running the ~9s RSS
// fan-out on every load. NEWS_SERVE_TTL_MS caps how stale a served result may be;
// NEWS_REFRESH_MS is the window under which a served result is still flagged
// `live` (and past which a background refresh is triggered).
const NEWS_SERVE_TTL_MS = 2 * 60 * 1000; // 2 min
const NEWS_REFRESH_MS = 60 * 1000;       // 1 min
function cacheNews(selectionKey, value) {
  newsCacheBySelection.set(selectionKey, value);
  if (newsCacheBySelection.size > NEWS_CACHE_MAX) {
    let oldestKey = null, oldest = Infinity;
    for (const [k, v] of newsCacheBySelection) {
      const t = Date.parse(v.generatedAt || 0);
      if (t < oldest) { oldest = t; oldestKey = k; }
    }
    if (oldestKey) newsCacheBySelection.delete(oldestKey);
  }
}
try {
  bundledNewsCache = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "news-cache.json"), "utf8"));
} catch (_) { /* no cache file yet */ }

// Deployment diagnostic: capture the git SHA this process was built from so
// /healthz can report exactly what is running (Render can otherwise serve a
// cached/stale build without it being obvious). Best-effort; falls back to
// "unknown" if .git is absent in the deployed slug.
const DEPLOYED_COMMIT = (() => {
  try {
    return require("child_process").execSync("git rev-parse HEAD", { cwd: __dirname }).toString().trim() || "unknown";
  } catch (_) { return "unknown"; }
})();

function newsCompetitorAliases(company) {
  return company.name
    .split(/\s*\/\s*|\s+x\s+/i)
    .map(alias => alias.replace(/\s*\([^)]*\)\s*/g, " ").trim())
    .filter(alias => alias.length > 2);
}

function newsSelectionKey(competitors) {
  return competitors.map(company => company.id).sort().join(",");
}

// Step 2c cold-start fix (Track 1.1): pre-warm the serve cache from the bundled
// seed so the FIRST /api/news request after any process start (deploy, spin-down
// wake) serves instantly instead of paying the ~9s live fan-out. The seed is
// backdated just past the `live` window so it is served as `cached:true` (honest
// about not being a live fetch) and immediately triggers a background refresh.
if (bundledNewsCache?.articles?.length) {
  // newsSelectionKey reads `.id`, so pass objects (matching how the handler
  // looks the default selection up) — not the raw id strings.
  cacheNews(
    newsSelectionKey(DEFAULT_NEWS_COMPETITOR_IDS.map(id => ({ id }))),
    {
      generatedAt: new Date(Date.now() - (NEWS_REFRESH_MS + 2000)).toISOString(),
      source: bundledNewsCache.source || "Cached",
      count: bundledNewsCache.articles.length,
      articles: bundledNewsCache.articles,
      // Marked so the handler keeps serving it on the first hit no matter how
      // long the process has been up — an absolute-age check against
      // NEWS_SERVE_TTL_MS would let a deploy that sits idle before the first hit
      // expire the seed and fall through to a live fan-out (defeating the fix).
      // Once a live refresh replaces the entry this flag is gone and normal TTL
      // logic resumes.
      seed: true,
    }
  );
}

function getNewsFallback(competitors) {
  const exact = newsCacheBySelection.get(newsSelectionKey(competitors));
  if (exact?.articles?.length && Date.now() - Date.parse(exact.generatedAt || 0) < NEWS_CACHE_TTL_MS) return exact;
  if (!bundledNewsCache?.articles?.length) return null;

  const aliases = competitors.flatMap(newsCompetitorAliases).map(alias => alias.toLowerCase());
  const articles = bundledNewsCache.articles.filter(article => {
    const text = `${article.title || ""} ${article.description || ""} ${article.competitorKeyword || ""}`.toLowerCase();
    return aliases.some(alias => text.includes(alias));
  });

  if (!articles.length) return null;
  return {
    generatedAt: bundledNewsCache.generatedAt,
    source: bundledNewsCache.source,
    count: articles.length,
    articles,
  };
}

// Cache compiled per-tag regexes (extractXmlTag runs 5x per RSS item and the
// news endpoint fans out across many feeds, so per-call compilation adds up).
const xmlTagRegexCache = new Map();
function extractXmlTag(xml, tag) {
  let re = xmlTagRegexCache.get(tag);
  if (!re) {
    re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i");
    xmlTagRegexCache.set(tag, re);
  }
  const match = re.exec(xml);
  return match ? stripHtml(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "";
}

function parseNewsRss(xml, topicLabel, query, limit = 6, candidateCompetitors = []) {
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && articles.length < limit) {
    const item = match[1];
    const title = extractXmlTag(item, "title");
    const url = extractXmlTag(item, "link");
    const description = extractXmlTag(item, "description");
    const publishedAt = extractXmlTag(item, "pubDate");
    const sourceName = extractXmlTag(item, "source");

    if (!title || !url) continue;
    if (NEWS_EXCLUDED_DOMAINS.some(domain => url.toLowerCase().includes(domain))) continue;

    const articleText = `${title} ${description}`.toLowerCase();
    const matchedCompetitor = candidateCompetitors.find(company =>
      newsCompetitorAliases(company).some(alias => articleText.includes(alias.toLowerCase()))
    );

    articles.push({
      title,
      url,
      description,
      competitorKeyword: matchedCompetitor?.name || topicLabel,
      topicCategory: topicLabel,
      competitorName: matchedCompetitor?.name || null,
      searchQuery: query,
      sourceName,
      publishedAt: publishedAt && !Number.isNaN(Date.parse(publishedAt))
        ? new Date(publishedAt).toISOString()
        : null,
    });
  }

  return articles;
}

async function searchGoogleNewsRss(query, topicLabel, limit = 6, candidateCompetitors = []) {
  const freshnessQuery = `${query} when:60d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(freshnessQuery)}&hl=en-GB&gl=GB&ceid=GB:en`;
  const resource = await fetchTextResource(url, "application/rss+xml,application/xml,text/xml", 8000);
  return parseNewsRss(resource.text, topicLabel, query, limit, candidateCompetitors);
}

// --- Bing News RSS support ---------------------------------------------------
// Bing News RSS is the live fallback when Google News RSS is blocked from the
// deployment's datacenter IP (Google returns 503 with zero items while Bing
// returns 200 with 10-12). Bing's feed differs from Google's in two ways:
//   1. The publisher name is in a namespaced <News:Source> tag (not <source>).
//   2. <link> is a bing.com/news/apiclick.aspx redirector carrying the real
//      publisher URL in its percent-encoded "url" query param, so links must be
//      unwrapped to direct publisher URLs before they are surfaced.

function isBingRedirector(url) {
  try {
    const parsed = new URL(String(url || ""));
    return /(^|\.)bing\.com$/i.test(parsed.hostname) && parsed.pathname.toLowerCase().includes("apiclick");
  } catch (_) {
    return false;
  }
}

function unwrapBingNewsLink(url) {
  const raw = String(url || "").trim();
  if (!raw || !isBingRedirector(raw)) return raw;
  try {
    const parsed = new URL(raw);
    const target = parsed.searchParams.get("url");
    if (!target) return raw;
    let decoded = target;
    // URLSearchParams already percent-decodes once; unwind a possible second layer.
    if (/%[0-9a-f]{2}/i.test(decoded)) {
      try { decoded = decodeURIComponent(decoded); } catch (_) { /* keep decoded as-is */ }
    }
    if (!/^https?:\/\//i.test(decoded)) return raw;
    return decoded;
  } catch (_) {
    return raw;
  }
}

function parseBingNewsRss(xml, topicLabel, query, limit = 6, candidateCompetitors = []) {
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && articles.length < limit) {
    const item = match[1];
    const title = extractXmlTag(item, "title");
    const rawUrl = extractXmlTag(item, "link");
    const description = extractXmlTag(item, "description");
    const publishedAt = extractXmlTag(item, "pubDate");
    const sourceName = extractXmlTag(item, "News:Source") || extractXmlTag(item, "source");

    const url = unwrapBingNewsLink(rawUrl);
    if (!title || !url || isBingRedirector(url)) continue;
    if (NEWS_EXCLUDED_DOMAINS.some(domain => url.toLowerCase().includes(domain))) continue;

    const articleText = `${title} ${description}`.toLowerCase();
    const matchedCompetitor = candidateCompetitors.find(company =>
      newsCompetitorAliases(company).some(alias => articleText.includes(alias.toLowerCase()))
    );

    articles.push({
      title,
      url,
      description,
      competitorKeyword: matchedCompetitor?.name || topicLabel,
      topicCategory: topicLabel,
      competitorName: matchedCompetitor?.name || null,
      searchQuery: query,
      sourceName,
      publishedAt: publishedAt && !Number.isNaN(Date.parse(publishedAt))
        ? new Date(publishedAt).toISOString()
        : null,
    });
  }

  return articles;
}

async function searchBingNewsRss(query, topicLabel, limit = 6, candidateCompetitors = []) {
  const url = `https://www.bing.com/news/search?q=${encodeURIComponent(query)}&format=RSS`;
  const resource = await fetchTextResource(url, "application/rss+xml,application/xml,text/xml", 8000);
  return parseBingNewsRss(resource.text, topicLabel, query, limit, candidateCompetitors);
}

function buildCompetitorNewsQueries(competitors) {
  const batches = [];
  for (let index = 0; index < competitors.length; index += 5) {
    const batch = competitors.slice(index, index + 5);
    const names = batch.flatMap(newsCompetitorAliases).map(alias => `"${alias}"`).join(" OR ");
    batches.push({
      query: `(${names}) AI gaming technology news`,
      competitors: batch,
    });
  }
  return batches;
}

// Build the full fan-out of topic + competitor searches for a given feed fn.
function buildNewsSearches(searchFn, selectedCompetitors = []) {
  const topicSearches = NEWS_TOPICS.flatMap(topic =>
    topic.queries.map(query => searchFn(query, topic.label, 6))
  );
  const competitorSearches = buildCompetitorNewsQueries(selectedCompetitors).map(batch =>
    searchFn(batch.query, "Competitor News", 8, batch.competitors)
  );
  return [...topicSearches, ...competitorSearches];
}

// Run a fan-out, dedupe by URL (or title), sort newest-first, cap the result.
async function runNewsFanOut(searchFn, selectedCompetitors = [], limit = 40) {
  const settled = await Promise.allSettled(buildNewsSearches(searchFn, selectedCompetitors));
  const seen = new Set();
  const articles = [];

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const article of result.value) {
      // The same story may surface in several queries.
      const key = article.url || article.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      articles.push(article);
    }
  }

  articles.sort((a, b) => {
    const dateA = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const dateB = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return dateB - dateA;
  });

  return articles.slice(0, limit);
}

// Google News RSS is primary; Bing News RSS is the live fallback that fires only
// when Google returns zero articles (Google 503s from the deployment's IP). The
// returned `source` label tells the caller which feed actually produced the list.
async function getLiveNewsArticles(selectedCompetitors = []) {
  // Track 1.2: race the Google and Bing fan-outs concurrently instead of a
  // serial fallback. Wall-time becomes max(google, bing) rather than
  // google + bing, and a blocked/slow Google no longer adds a second wave of
  // latency. We still prefer Google when it returns anything non-empty.
  const [googleRes, bingRes] = await Promise.allSettled([
    runNewsFanOut(searchGoogleNewsRss, selectedCompetitors),
    runNewsFanOut(searchBingNewsRss, selectedCompetitors),
  ]);
  const googleArticles = googleRes.status === "fulfilled" ? googleRes.value : [];
  const bingArticles = bingRes.status === "fulfilled" ? bingRes.value : [];
  if (googleArticles.length > 0) {
    return { articles: googleArticles, source: "Google News RSS" };
  }
  return { articles: bingArticles, source: "Bing News RSS" };
}

// Rebuild: the Suggested-Updates scan now reuses the SAME articles shown in the
// News + Search tab (no separate RSS feed lane). Read the cached News+Search set
// when fresh; otherwise trigger a live fetch — exactly what the tab would show.
async function getScanArticleCandidates() {
  const competitors = resolveNewsCompetitors();
  const key = newsSelectionKey(competitors);
  const cached = newsCacheBySelection.get(key);
  if (cached && Array.isArray(cached.articles) && cached.articles.length) return cached.articles;
  try {
    const { articles } = await getLiveNewsArticles(competitors);
    return articles || [];
  } catch {
    return [];
  }
}

// News + Search items lack the `source` shape classifyItem expects (id/domain/
// category/licenseClass). Wrap each in a synthetic source shim so the existing
// matcher runs unchanged. AI-regulation stays the PRIMARY lens (bestMatch's
// STRONG_TERMS), with AI×gaming as the extension — consistent with the app's
// guardrail.
function syntheticSourceForArticle(item) {
  let domain = "";
  try {
    domain = new URL(item.url || "").host.replace(/^www\./, "");
  } catch {
    domain = String(item.sourceName || "news").toLowerCase().replace(/\s+/g, "-");
  }
  return {
    id: domain,
    name: item.sourceName || domain,
    domain,
    category: "regulation",
    licenseClass: "news-fair-use",
    language: "en",
  };
}

// --- News subhead enrichment -------------------------------------------------
// Google News RSS <description> only carries the headline + source name (no
// summary), so News cards otherwise repeat the title plus the site. This pulls
// a real subhead/strapline (or the article's lead line).

// When the Google-News resolver fails and we fall back to fetching the
// news.google.com dispatcher URL, the page contains ONLY this generic line —
// never the article. We must never surface it as a "lead", or every
// un-resolvable card reads identically. The Tavily-first path below is what
// makes this boilerplate rare in the first place.
const GOOGLE_NEWS_BOILERPLATE = [
  "Comprehensive up-to-date news coverage, aggregated from sources all over the world by Google News.",
];
function isGoogleNewsBoilerplate(text) {
  const t = String(text || "").trim();
  return GOOGLE_NEWS_BOILERPLATE.some((b) => t === b || t.startsWith(b));
}

// Pick the first candidate that is a genuine lead: long enough and NOT the
// Google News boilerplate. Falls back to null so the card keeps its RSS
// description instead of a useless generic line.
function pickSubheadCandidate(...candidates) {
  for (const c of candidates) {
    if (c && typeof c === "string" && c.trim().length >= 30 && !isGoogleNewsBoilerplate(c)) {
      return c.trim();
    }
  }
  return null;
}

// Cache search-derived subheads by normalized title so repeated cards for the
// same headline hit the search chain at most once per server process.
const subheadTitleCache = new Map();
async function searchSubhead(title) {
  const norm = String(title || "").trim().toLowerCase();
  if (!norm) return null;
  if (subheadTitleCache.has(norm)) return subheadTitleCache.get(norm);
  const p = (async () => {
    try {
      const results = await searchWeb(norm, 1);
      const first = results && results[0];
      if (!first) return null;
      // Prefer the clean extracted text the provider returns for the headline query.
      if (first.description && !isGoogleNewsBoilerplate(first.description)) {
        return first.description.trim();
      }
      // Some results only carry the article URL — fetch the page directly so
      // we still get a real lead even from a bare link.
      if (first.url) {
        const page = await fetchTextResource(first.url);
        const strap = extractMetaDescription(page.text);
        if (strap && !isGoogleNewsBoilerplate(strap) && strap.trim().length >= 30) {
          return strap.trim();
        }
        const body = extractText(page.text);
        const lead = splitSentences(body).slice(0, 2).join(" ").trim();
        return isGoogleNewsBoilerplate(lead) ? null : lead || null;
      }
      return null;
    } catch (_) {
      return null;
    }
  })();
  if (subheadTitleCache.size > 2000) subheadTitleCache.clear();
  subheadTitleCache.set(norm, p);
  return p;
}

// KEYLESS leg: resolve the Google News redirect to the real publisher and read
// the page directly. Costs no search quota, so this is the only leg the
// background warmer is allowed to use.
async function extractSubhead(article) {
  const title = article.title || "";
  try {
    // News enrichment runs on its OWN resolver chain (newsChains) so it can
    // never starve the background scanner's URL resolution. And it is
    // cache-first: if this article (or the scanner) already resolved the real
    // URL, reuse it instead of hitting a search engine again.
    let target = article.url;
    let pageText = null;
    if (/news\.google\.com/i.test(target)) {
      // Resolve Google News links via Jina's server-side extraction rather than
      // the broken local resolver (which fails 100% from Render's egress). Jina
      // follows the redirect and renders JS, so it retrieves what a direct fetch
      // cannot. The resolver/cache is only a fallback when Jina is unavailable.
      try {
        const jt = await jinaExtract(target, 15000);
        if (jt && jt.length >= 140 && !looksLikeBotWall(jt)) pageText = jt;
      } catch (_) { /* fall through */ }
    }
    if (!pageText) {
      const cached = resolvedUrlMap.get(target) || (sourceState.resolvedUrls && sourceState.resolvedUrls[target]);
      const resolved = cached || target;
      try {
        const resource = await fetchTextResource(resolved);
        pageText = resource.text;
      } catch (_) { /* fall through */ }
    }
    if (!pageText) return null;
    // Prefer the editor's strapline (meta description / og:description).
    const strapline = extractMetaDescription(pageText);
    // Fall back to the first 1-2 sentences of the article body.
    const body = extractText(pageText);
    const lead = splitSentences(body).slice(0, 2).join(" ").trim();
    // Reject the Google News boilerplate either way so we never show the
    // generic "Comprehensive up-to-date news coverage…" line.
    return pickSubheadCandidate(strapline, lead);
  } catch (_) {
    return null;
  }
}

// Resolves a real subhead for one article.
//
// QUOTA NOTE (why `allowSearch` exists): the search leg is fast and high quality,
// but the background warmer runs on EVERY news refresh — including the Thread B
// clock cron (NEWS_CRON_MS, 5 min default). Left ungated that is up to 6 searches
// x ~288 refreshes/day, which would incinerate a 1k/month search budget on cards
// nobody has looked at. So:
//   * background warming (enrichTopArticles) passes allowSearch:false -> KEYLESS
//     extraction only, zero search spend;
//   * the user-visible lazy path (GET /api/news/subhead, fired when a card
//     actually scrolls into view) keeps search-first, so quality is unchanged
//     exactly where the user is looking — once per headline, then cached.
async function fetchArticleSubhead(article, options = {}) {
  const allowSearch = options.allowSearch !== false;

  if (allowSearch) {
    // Search-first: the provider chain returns clean extracted article text, so
    // we skip the flaky Google-News resolver entirely. When no provider is
    // configured/reachable it returns null fast and we fall through.
    try {
      const picked = pickSubheadCandidate(await searchSubhead(article.title || ""));
      if (picked) return picked;
    } catch (_) { /* fall through to the keyless extraction leg */ }
  }

  return extractSubhead(article);
}

// Bounded-concurrency enrichment of the first `limit` articles (default 6) so
// the News tab can show real subheads for the top cards. Each fetch is capped
// by `perArticleTimeoutMs` so a single slow resolution can never pile up, and
// the caller may run this fire-and-forget (after responding) — see /api/news.
// The rest of the cards are filled in lazily by the client as the user scrolls
// (see /api/news/subhead below).
//
// Warming is KEYLESS-ONLY (allowSearch:false): it runs on every refresh including
// the 5-minute cron, so it must never spend search quota. Cards it can't fill get
// the search-backed subhead on demand when the user actually scrolls to them.
async function enrichTopArticles(articles, limit = 6, concurrency = 5, perArticleTimeoutMs = 15000) {
  const top = articles.slice(0, limit);
  // Clear the timeout as soon as the race settles so the fire-and-forget
  // enrichment can never leak a 15s timer (and hold the event loop open) after
  // a news request — behaviour is unchanged, the race still caps at `ms`.
  const withTimeout = (p, ms) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("enrich-timeout")), ms);
    });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  };
  for (let i = 0; i < top.length; i += concurrency) {
    const batch = top.slice(i, i + concurrency);
    await Promise.all(batch.map(async (a) => {
      try {
        const sub = await withTimeout(
          fetchArticleSubhead(a, { allowSearch: false }), perArticleTimeoutMs);
        if (sub) a.subhead = sub;
      } catch (_) { /* keep the RSS description on timeout/error */ }
    }));
  }
  return articles;
}

// Scroll-driven single-article subhead lookup. Accepts any http(s) article URL
// (live RSS links are news.google.com redirects; cached fallback entries are
// already-resolved publisher URLs). SSRF safety is enforced by fetchTextResource
// (validateSourceUrl + assertPublicHost on the final redirect target).
app.get("/api/news/subhead", async (req, res) => {
  const url = String(req.query.url || "");
  const title = String(req.query.title || "");
  if (!/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: "A valid http(s) article URL is required" });
  }
  try {
    const sub = await fetchArticleSubhead({ url, title });
    if (!sub) return res.status(404).json({ error: "No subhead available" });
    return res.json({ subhead: sub });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
});

// Step 2c — coalesced background news refresh. When a served cache entry is
// older than NEWS_REFRESH_MS we refresh it in the background; the in-flight Set
// ensures concurrent stale requests share a single fan-out, not one each.
const newsRefreshing = new Set();

// Live push (Thread B): SSE subscribers. Each open GET /api/news/stream response
// registers itself here and is notified when a news refresh lands. Kept as a Set
// of raw response objects; cleaned up on disconnect so it can never grow.
const newsSseClients = new Set();
function broadcastNewsUpdate(payload) {
  if (newsSseClients.size === 0) return;
  const frame = `event: news-updated\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of newsSseClients) {
    try { client.write(frame); }
    catch (_) { newsSseClients.delete(client); }
  }
}

function triggerNewsBackgroundRefresh(key, competitors) {
  if (newsRefreshing.has(key)) return;
  newsRefreshing.add(key);
  getLiveNewsArticles(competitors)
    .then(({ articles, source }) => {
      if (articles.length) {
        const generatedAt = new Date().toISOString();
        cacheNews(key, {
          generatedAt,
          source,
          count: articles.length,
          articles,
        });
        // Tell any live SSE subscribers a fresh feed is available (Thread B).
        broadcastNewsUpdate({ type: "news-updated", key, source, count: articles.length, generatedAt });
        // Warm subheads for the next load, mirroring the live path.
        enrichTopArticles(articles, 6, 5, 15000).catch(() => {});
      }
    })
    .catch(() => {})
    .finally(() => newsRefreshing.delete(key));
}

app.get("/api/news", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");

  try {
    const newsLang = req.query.lang === "zh-CN" ? "zh-CN" : "en";
    const savedIds = String(req.query.savedIds || "").split(",").map((s) => s.trim()).filter(Boolean);
    const monitoredCompetitors = resolveNewsCompetitors(req.query.competitors);
    const key = newsSelectionKey(monitoredCompetitors);
    // An explicit user Refresh always bypasses the serve-cache and pulls live.
    const forceRefresh = Boolean(req.query.refresh);

    // Serve from cache when fresh enough — skips the ~9s RSS fan-out. (Step 2c)
    const cached = newsCacheBySelection.get(key);
    const cachedAgeMs = cached ? Date.now() - Date.parse(cached.generatedAt || 0) : Infinity;
    // A bundled seed stays serveable on the first hit regardless of process
    // uptime (see pre-warm block); everything else must be within the serve TTL.
    const serveable = cached?.articles?.length && (cached.seed || cachedAgeMs < NEWS_SERVE_TTL_MS);
    if (!forceRefresh && serveable) {
      const isLive = !cached.seed && cachedAgeMs < NEWS_REFRESH_MS;
      const translatedArticles = await kbTranslate.translateNewsSummaries(cached.articles, newsLang, savedIds);
      res.json({
        success: true,
        count: translatedArticles.length,
        articles: translatedArticles,
        topics: NEWS_TOPICS.map(topic => topic.label),
        monitoredCompetitors: monitoredCompetitors.map(company => ({ id: company.id, name: company.name, custom: Boolean(company.custom) })),
        searchedAt: cached.generatedAt,
        live: isLive,
        cached: !isLive,
        source: cached.source,
      });
      // Stale-while-revalidate: refresh in the background once past the window.
      // A seed always triggers a refresh so it is replaced by a live result.
      if (cached.seed || cachedAgeMs >= NEWS_REFRESH_MS) triggerNewsBackgroundRefresh(key, monitoredCompetitors);
      return;
    }

    const { articles: liveArticles, source: liveSource } = await getLiveNewsArticles(monitoredCompetitors);

    // Single response path for both live and cached fallback. The News tab
    // responds immediately with RSS descriptions; subheads are filled in by the
    // client on scroll (and warmed in the background for the next load).
    let articles = liveArticles;
    let source = liveSource;
    let live = true;
    let searchedAt = new Date().toISOString();

    if (articles.length > 0) {
      cacheNews(newsSelectionKey(monitoredCompetitors), {
        generatedAt: searchedAt,
        source: liveSource,
        count: liveArticles.length,
        articles: liveArticles,
      });
      // Live explicit refresh also notifies SSE subscribers (Thread B).
      broadcastNewsUpdate({ type: "news-updated", key, source: liveSource, count: liveArticles.length, generatedAt: searchedAt });
    } else {
      const fallback = getNewsFallback(monitoredCompetitors);
      if (fallback?.articles?.length) {
        articles = fallback.articles;
        source = fallback.source || "Cached";
        live = false;
        searchedAt = fallback.generatedAt;
      }
    }

    if (!articles.length) {
      return res.status(503).json({ error: "No live or cached news articles are available" });
    }

    // Respond immediately with RSS descriptions. Subheads are warmed in the
    // background (below) so the next load within the cache window already has
    // them, and the client fills cards in live as they scroll via the
    // IntersectionObserver -> /api/news/subhead path. This keeps the News tab
    // from ever waiting on article fetches.
    const translatedArticles = await kbTranslate.translateNewsSummaries(articles, newsLang, savedIds);
    const payload = {
      success: true,
      count: translatedArticles.length,
      articles: translatedArticles,
      topics: NEWS_TOPICS.map(topic => topic.label),
      monitoredCompetitors: monitoredCompetitors.map(company => ({ id: company.id, name: company.name, custom: Boolean(company.custom) })),
      searchedAt,
      live,
      cached: !live,
      source,
    };
    res.json(payload);

    // Fire-and-forget: enrich the top 6 in the background. Mutates the same
    // article objects held by the cache, so the enrichment persists for
    // subsequent loads. Bounded + timeout-capped so it can never stall.
    enrichTopArticles(articles, 6, 5, 15000).catch(() => {});
    return;
  } catch (err) {
    // Last-resort fallback if getLiveNewsArticles itself threw.
    try {
      const monitoredCompetitors = resolveNewsCompetitors(req.query.competitors);
      const fallback = getNewsFallback(monitoredCompetitors);
      if (fallback?.articles?.length) {
        const translatedArticles = await kbTranslate.translateNewsSummaries(fallback.articles, newsLang, savedIds);
        const payload = {
          success: true,
          count: translatedArticles.length,
          articles: translatedArticles,
          topics: NEWS_TOPICS.map(topic => topic.label),
          monitoredCompetitors: monitoredCompetitors.map(company => ({ id: company.id, name: company.name, custom: Boolean(company.custom) })),
          searchedAt: fallback.generatedAt,
          live: false,
          cached: true,
        };
        res.json(payload);
        enrichTopArticles(fallback.articles, 6, 5, 15000).catch(() => {});
        return;
      }
    } catch (_) { /* fall through */ }
    return res.status(500).json({ error: err.message });
  }
});

// Thread B — Server-Sent Events stream for live news updates. A client opens
// this once and keeps it open; whenever a news refresh lands (cron tick or a
// user's ?refresh) it receives a `news-updated` event. Keyless, no AI tokens —
// this is the cheap "live" mechanism the app is built around.
app.get("/api/news/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering (Render / nginx)
  });
  res.flushHeaders?.();
  newsSseClients.add(res);
  // Opening frame proves connectivity and primes the client.
  res.write(": connected\n\n");

  // Keep-alive heartbeat so idle proxies don't drop the socket.
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch (_) { /* socket already gone */ }
  }, 20000);

  const cleanup = () => {
    clearInterval(heartbeat);
    newsSseClients.delete(res);
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
});

// --- Custom competitor definitions (server-persisted) ---
app.get("/api/news/custom-competitors", (req, res) => {
  res.json({ customCompetitors: customCompetitors.slice() });
});

app.post("/api/news/custom-competitors", whenAuth(requireEditor), (req, res) => {
  const raw = (req.body && req.body.name) || "";
  const name = String(raw).trim().replace(/\s+/g, " ").replace(/,/g, " ").trim();
  if (!name) return res.status(400).json({ error: "name is required" });
  if (name.length > 40) return res.status(400).json({ error: "name must be 40 characters or fewer" });

  // If it already matches a built-in catalog company (by name or alias),
  // don't create a duplicate custom entry -- hand back the real catalog entry.
  const lower = name.toLowerCase();
  const catalogMatch = newsCompetitorCatalog.find(company =>
    company.name.toLowerCase() === lower ||
    newsCompetitorAliases(company).some(a => a.toLowerCase() === lower)
  );
  if (catalogMatch) {
    return res.json({ custom: false, competitor: { id: catalogMatch.id, name: catalogMatch.name } });
  }

  const existing = customCompetitors.find(c => c.name.toLowerCase() === lower);
  if (existing) {
    return res.json({ custom: true, competitor: existing, customCompetitors: customCompetitors.slice() });
  }

  const entry = { id: name, name, custom: true };
  customCompetitors.push(entry);
  saveCustomCompetitors();
  res.json({ custom: true, competitor: entry, customCompetitors: customCompetitors.slice() });
});

app.delete("/api/news/custom-competitors/:id", whenAuth(requireEditor), (req, res) => {
  const id = req.params.id;
  const before = customCompetitors.length;
  customCompetitors = customCompetitors.filter(c => c.id !== id);
  if (customCompetitors.length !== before) saveCustomCompetitors();
  res.json({ ok: true, customCompetitors: customCompetitors.slice() });
});

// ============================================================================
// Curated Source Monitor (Scope C, P1–P3) — verify & propose, never auto-apply
// Each source is monitored via domain-scoped Google News RSS (site:<domain>) so
// results stay official/accurate. Fetched items are (1) filtered to English only,
// (2) compared against the EXISTING curated datasets, and (3) surfaced ONLY as
// PROPOSED CHANGES when they would genuinely update / expand / correct existing
// content (or are a clearly new, covered topic). The user reviews and approves
// each one — nothing is written back to the app automatically.
// ============================================================================
const SOURCES_FILE = path.join(__dirname, "data", "sources.json");
const SOURCE_STATE_FILE = path.join(__dirname, "data", "source-state.json");
const PROPOSED_FILE = path.join(__dirname, "data", "proposed-changes.json");

let sourcesCache = null;
let sourceState = loadSourceState();
let proposedChanges = loadProposed();
let sourceScanInFlight = false;
// Model calls made in the CURRENT scan run (reset at scan start, surfaced in
// /healthz as callsThisRun). Module-scoped because /healthz runs outside the
// scan closure.
let scanModelCallsThisRun = 0;
// Resolver health: how many article-URL resolutions we've attempted vs. how
// many succeeded (real publisher URL found). Surfaced as resolverSuccessRate.
const resolverStats = { attempts: 0, ok: 0 };
let sourceScanStartedAt = 0;
// If a scan is somehow still "in flight" after this long, treat the lock as
// stale and allow a new scan to supersede it (otherwise a single slow/hung
// scan would block every subsequent trigger forever on the free tier).
// NOTE: enrichment runs at concurrency 1 with a paced inter-call delay, so a
// full scan legitimately takes longer than it used to. This MUST stay
// comfortably above a real scan duration or the lock is declared stale mid-scan
// and a second scan starts alongside the first — which would double the model
// call rate, the exact opposite of the intent.
const SOURCE_SCAN_STALE_MS = 20 * 60 * 1000;

// ---------------------------------------------------------------------------
// Scan-lane request budget (free-tier survival)
// ---------------------------------------------------------------------------
// The scan lane runs on a free model tier with BOTH a per-minute and a per-day
// request ceiling, and failed attempts still count against the daily quota. Two
// independent guards keep us underneath it:
//
//   1. SCAN_MODEL_MIN_GAP_MS — a paced minimum gap between consecutive scan-lane
//      model calls, so we can never trip the requests-per-minute ceiling.
//   2. SCAN_CALLS_PER_RUN_CAP / SCAN_DAILY_CALL_BUDGET — hard ceilings on how
//      many model calls a single scan, and a single UTC day, may spend.
//
// The per-RUN cap is the load-bearing one. Render's free tier has an ephemeral
// filesystem, so the persisted daily counter resets whenever the container is
// rebuilt; the per-run cap still holds because it is enforced in-process.
const SCAN_MODEL_MIN_GAP_MS = config.SCAN_MODEL_MIN_GAP_MS;
const SCAN_CALLS_PER_RUN_CAP = config.SCAN_CALLS_PER_RUN_CAP;
const SCAN_DAILY_CALL_BUDGET = config.SCAN_DAILY_CALL_BUDGET;

// Reserve paced slots ATOMICALLY. The reservation is synchronous (no await
// before scanModelSlot is advanced), so concurrent callers each get their own
// slot instead of all waking at the same instant.
// Process-global pacing clock for the scan lane. Shared across every scan in this
// process (including a scan that supersedes a stale one), so the spacing caps the
// aggregate rate even when multiple scans think they are running.
let scanModelSlot = 0;
async function paceScanModelCall() {
  const now = Date.now();
  const slot = Math.max(now, scanModelSlot);
  scanModelSlot = slot + SCAN_MODEL_MIN_GAP_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

function utcDayKey(d = new Date()) { return d.toISOString().slice(0, 10); }

// Returns the live budget record, rolling it over at UTC midnight.
function scanBudget() {
  const today = utcDayKey();
  if (!sourceState.scanBudget || sourceState.scanBudget.day !== today) {
    sourceState.scanBudget = { day: today, used: 0 };
  }
  return sourceState.scanBudget;
}

function scanBudgetRemaining() {
  return Math.max(0, SCAN_DAILY_CALL_BUDGET - scanBudget().used);
}

// Count the call BEFORE it is made: a 429 still consumes provider quota, so an
// attempt must cost us budget even when it fails.
function consumeScanBudget() {
  const b = scanBudget();
  b.used += 1;
  scanModelCallsThisRun += 1; // per-run counter for /healthz
  saveSourceState(); // persist immediately so a crash/restart can't rewind it
  return b.used;
}

// Cache of resolved real article URLs (Google News redirect -> publisher URL),
// persisted via sourceState.resolvedUrls so we rarely re-query a search engine.
const resolvedUrlMap = new Map();
// Session-only negative cache: a Google News URL that just failed resolution
// (every resolver exhausted) is recorded here so repeated reader opens / scan
// lookups within the same process skip the (expensive, often failing) re-resolution
// and return null immediately. Deliberately NOT persisted to disk — a later scan
// or network change may succeed, and we don't want to freeze a permanent miss.
// Cleared whenever a successful resolution lands for the same URL.
const resolverNegativeCache = new Set();
// Session-only caches for the Google News *viewer* fallback (Option A). When a
// news.google.com link can't be resolved to a publisher, we make one best-effort
// attempt to read the viewer page itself. Positive results are cached so repeated
// reader opens are instant; misses are recorded so we don't re-hammer Google on
// every open. Both are session-only (reset on restart) — same reasoning as
// resolverNegativeCache.
const googleViewerCache = new Map();        // url -> {title,text,url,partial,resolvedVia}
const googleViewerNegativeCache = new Set(); // urls whose viewer page yielded nothing
// Serialize DuckDuckGo/GDELT URL resolutions so we never hit the engines in
// parallel (which triggers rate limiting) and enforce a minimum gap between
// calls. We keep TWO independent chain sets so a busy News tab can never starve
// the background competitor-news scanner:
//   - scannerChains: used by the scanner (and scrapeUrl) to resolve article URLs.
//   - newsChains:    used only by the News-tab subhead enrichment.
// They share the URL cache (resolvedUrlMap) but never contend for a resolution
// slot, so News pre-fetching / scroll lookups cannot block proposal generation.
function makeResolverChains() {
  return { ddg: Promise.resolve(), gdelt: Promise.resolve(), lastDdg: 0, lastGdelt: 0 };
}
const scannerChains = makeResolverChains();
const newsChains = makeResolverChains();
// Rotate User-Agents across resolver requests. A single fixed UA is exactly what
// search engines fingerprint and challenge, so cycling a small pool of realistic
// desktop UAs measurably reduces the DuckDuckGo 202 bot-challenge in production.
const RESOLVER_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];
let resolverUaIdx = 0;
function nextResolverUa() {
  const ua = RESOLVER_UAS[resolverUaIdx % RESOLVER_UAS.length];
  resolverUaIdx++;
  return ua;
}

function loadSourceRegistry() {
  if (!sourcesCache) {
    try {
      sourcesCache = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8")).sources || [];
    } catch (_) {
      sourcesCache = [];
    }
  }
  return sourcesCache;
}

function loadSourceState() {
  try {
    const data = JSON.parse(fs.readFileSync(SOURCE_STATE_FILE, "utf8"));
    if (data && typeof data === "object" && data.resolvedUrls) {
      for (const [k, v] of Object.entries(data.resolvedUrls)) resolvedUrlMap.set(k, v);
    }
    if (data && typeof data === "object") {
      return data;
    }
    return { sources: {}, lastFullScan: null };
  } catch (_) {
    return { sources: {}, lastFullScan: null };
  }
}

function saveSourceState() {
  try {
    fs.writeFileSync(SOURCE_STATE_FILE, JSON.stringify(sourceState, null, 2));
  } catch (_) { /* non-fatal */ }
}

function loadProposed() {
  try {
    const data = JSON.parse(fs.readFileSync(PROPOSED_FILE, "utf8"));
    return {
      items: Array.isArray(data.items) ? data.items : [],
      dismissedIds: Array.isArray(data.dismissedIds) ? data.dismissedIds : [],
      integratedIds: Array.isArray(data.integratedIds) ? data.integratedIds : [],
    };
  } catch (_) {
    return { items: [], dismissedIds: [], integratedIds: [] };
  }
}

// Durable store for Suggested Updates. The whole object is kept as a single
// JSONB row keyed by "__store" — simpler and exactly correct for a small
// (<300 item) document, and it preserves the {items, dismissedIds,
// integratedIds} shape the rest of the code expects.

// Self-healing: ensure the backing table exists before we touch it. This makes
// the manual `scripts/migrate-proposed.js` step optional — on first DB contact
// the app creates the table itself (idempotent). Memoized so the DDL runs once
// per process, not on every save. Mirrors the schema in scripts/migrate-proposed.js.
let _proposedTableEnsured = false;
async function ensureProposedTable(pool) {
  if (_proposedTableEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS proposed_changes (
      id           TEXT PRIMARY KEY,
      data         JSONB NOT NULL,
      status       TEXT,
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  _proposedTableEnsured = true;
}

// Accounts v1 allow-list: an optional `allowed_emails` table lets the workspace
// owner add/remove approved addresses in Supabase (SQL editor or a small UI)
// without redeploying Render. The env ALLOWED_EMAILS list remains a break-glass
// bootstrap. Seeded from ALLOWED_EMAILS ONLY when the table is empty, so a row
// deleted in Supabase stays deleted across reboots (we never re-seed over an
// existing list).
let _allowedEmailsEnsured = false;
async function ensureAllowedEmailsTable(pool) {
  if (_allowedEmailsEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS allowed_emails (
      email      TEXT PRIMARY KEY,
      added_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // v1.2: admin flag. ADD COLUMN IF NOT EXISTS is idempotent, so it never
  // clobbers an is_admin value Molly set manually in Supabase.
  await pool.query(
    `ALTER TABLE allowed_emails ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false`
  );
  const seed = String(process.env.ALLOWED_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (seed.length) {
    await pool.query(
      `INSERT INTO allowed_emails (email)
       SELECT * FROM UNNEST($1::text[])
       WHERE NOT EXISTS (SELECT 1 FROM allowed_emails)`,
      [seed]
    );
  }
  // Promote env-listed admins to is_admin = TRUE. The `AND is_admin = FALSE`
  // guard means it only ever promotes, never demotes a manually-set TRUE. Once
  // ADMIN_EMAILS is retired from env this becomes a no-op.
  const admins = String(process.env.ADMIN_EMAILS || process.env.ALLOWED_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (admins.length) {
    await pool.query(
      `UPDATE allowed_emails SET is_admin = TRUE WHERE email = ANY($1) AND is_admin = FALSE`,
      [admins]
    );
  }
  _allowedEmailsEnsured = true;
}

async function persistProposedStore(pool) {
  const data = JSON.stringify(proposedChanges);
  await ensureProposedTable(pool);
  await pool.query(
    `INSERT INTO proposed_changes (id, data, status, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, status = EXCLUDED.status, updated_at = now()`,
    ["__store", data, "store"]
  );
}

function saveProposed() {
  // Disk write is the always-available fallback (and the local-dev path when
  // DATABASE_URL is unset). On the deployed host the Supabase copy is the
  // durable store that survives Render's ephemeral-disk cold starts, so
  // enrichment progress is never wiped on a wake-up.
  try {
    fs.writeFileSync(PROPOSED_FILE, JSON.stringify(proposedChanges, null, 2));
  } catch (_) { /* non-fatal */ }
  const pool = datasetsGetDbPool();
  if (pool) {
    persistProposedStore(pool).catch((e) =>
      console.warn("[proposed] DB save failed; disk fallback only:", e.message));
  }
}

// Load the durable store from Supabase at boot, overriding the disk-seeded
// in-memory copy. With this, enrichment progress persists across cold starts
// and the scan's self-healing retry loop can drain the queue over time
// instead of restarting from zero on every wake-up.
async function primeProposedFromDb() {
  const pool = datasetsGetDbPool();
  if (!pool) return;
  try {
    await ensureProposedTable(pool);
    const res = await pool.query("SELECT data FROM proposed_changes WHERE id = $1", ["__store"]);
    const row = res.rows && res.rows[0];
    if (!row || !row.data) return;
    const loaded = typeof row.data === "string" ? JSON.parse(row.data) : row.data;
    if (loaded && Array.isArray(loaded.items)) {
      proposedChanges = {
        items: loaded.items,
        dismissedIds: Array.isArray(loaded.dismissedIds) ? loaded.dismissedIds : [],
        integratedIds: Array.isArray(loaded.integratedIds) ? loaded.integratedIds : [],
      };
      console.log(`  Proposed-changes store loaded from database (${proposedChanges.items.length} items).`);
    }
  } catch (e) {
    console.warn("[proposed] DB load failed; using disk/in-memory:", e.message);
  }
}

// Test seams (harmless in production).
function getProposedChanges() { return proposedChanges; }
function setProposedChanges(obj) { proposedChanges = obj; }
function getSourceState() { return sourceState; }

// ---------------------------------------------------------------------------
// Phase 3: retention sweep + shared-store write-back
// ---------------------------------------------------------------------------
// Legal-hold ids (comma-separated env) are never purged or rolled, regardless
// of age. Empty by default.
function loadLegalHoldIds() {
  const raw = process.env.RETENTION_LEGAL_HOLD_IDS || "";
  return raw.split(",").map(s => s.trim()).filter(Boolean);
}

// Persist extracted article text back into a store item (after a live fetch or
// a manual paste), refreshing its retention state. No-op if the item is gone.
async function writeStoreBody(id, text) {
  if (!id || !text) return;
  const prop = (proposedChanges.items || []).find(i => i.id === id);
  if (!prop) return;
  // Governance: never persist full text for restricted or api-restricted
  // sources. `restricted` = metadata + link + snippet only (no paywall
  // circumvention); `api-restricted` = honour the source API TTL (don't hold
  // full text beyond it). Open / news-fair-use may be stored.
  const cls = prop.licenseClass || "open";
  if (cls === "restricted" || cls === "api-restricted") return;
  prop.body = text;
  // Keep `preview` (the short review-panel snippet) as-is; only the canonical
  // reader body is updated here.
  prop.retentionState = computeRetentionState(prop, Date.now(), loadLegalHoldIds());
  prop.retentionReviewedAt = new Date().toISOString();
  // Best-effort: generate an AI summary so a freshly-fetched article isn't left
  // as raw text (covers the manual paste-URL / Refresh reader paths).
  await summariseStoredItem(prop, { force: true });
  saveProposed();
}

// Persist manually-supplied content (pasted article text, or a corrected URL)
// back into the shared store AND generate an AI summary so the item isn't left
// as raw text. Reuses the admin gate via the route. Returns { prop, styledSummary }
// or { error } when the proposal id is unknown.
async function storeManualContent(id, text, url) {
  const prop = (proposedChanges.items || []).find(i => i.id === id);
  if (!prop) return { error: "not found" };
  if (text) {
    prop.body = text;
    if (!prop.preview) prop.preview = text.slice(0, 4000);
  }
  if (url) prop.url = url;
  prop.manuallyStored = true;
  prop.retentionState = computeRetentionState(prop, Date.now(), loadLegalHoldIds());
  prop.retentionReviewedAt = new Date().toISOString();
  await summariseStoredItem(prop, { force: true });
  saveProposed();
  return { prop, styledSummary: prop.styledSummary || null };
}

// Scheduled pass: tag every store item with its retention state from
// retentionClass + ingestedAt (+ legal-hold override), rolling/purging as the
// policy dictates. Returns how many items changed. Synchronous + in-memory;
// persists only when something actually changed.
function runRetentionSweep(now = Date.now()) {
  const legalHold = loadLegalHoldIds();
  let changed = 0;
  for (const item of (proposedChanges.items || [])) {
    const prev = item.retentionState;
    const state = computeRetentionState(item, now, legalHold);
    item.retentionState = state;
    item.retentionReviewedAt = new Date(now).toISOString();
    if (state === "excerpt" && prev !== "excerpt") {
      // Roll full body to a 300-word excerpt; keep the short preview intact.
      if (item.body) item.body = rollToExcerpt(item.body, retention.EXCERPT_MAX_WORDS);
      if (item.preview && item.preview.length > retention.EXCERPT_MAX_WORDS * 8) {
        item.preview = rollToExcerpt(item.preview, retention.EXCERPT_MAX_WORDS);
      }
      changed++;
    } else if (state === "purged" && item.status === "pending") {
      // Expire (don't hard-delete) so it leaves the review queue but stays
      // recoverable from the JSON file.
      item.status = "expired";
      changed++;
    }
  }
  if (changed) saveProposed();
  return { changed, reviewedAt: new Date(now).toISOString() };
}

// ---- Text helpers: English filter + keyword/anchor overlap matching ----
const STOPWORDS = new Set(
  "the a an and or of to in for on with by from as at is are was were be been being this that these those it its their his her our your we you they he she new latest update via per into about within across after before between during over under".split(" ")
);
// Specific AI-regulation "anchor" terms. A fetched item only counts as relevant
// (and only matches / qualifies as a proposable "new" item) when it shares one of
// these with an existing record or is itself clearly about AI regulation/policy.
const STRONG_TERMS = [
  "ai act", "eu ai act", "eu ai", "uk ai", "ai regulation", "ai policy",
  "gdpr", "data protection", "ico", "edpb", "ai safety", "ai governance",
  "frontier model", "frontier models", "model evaluation", "foundation model",
  "copyright", "ai risk", "high-risk", "high risk", "ai office", "aisi", "oecd",
  "council of europe", "ai convention", "algorithm", "machine learning",
  "ai compliance", "ai enforcement", "responsible ai", "ai transparency",
];
function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [])
    .filter(w => !STOPWORDS.has(w));
}
function strongTermsIn(text) {
  const t = String(text || "").toLowerCase();
  const toks = new Set(tokenize(t));
  const found = new Set();
  for (const term of STRONG_TERMS) {
    if (term.includes(" ")) { if (t.includes(term)) found.add(term); }
    else if (toks.has(term)) found.add(term);
  }
  return found;
}
// Rebuild: the News + Search tab is already AI×gaming-curated, so for NEW-topic
// gap discovery we accept a broader in-domain anchor than the reg-only
// STRONG_TERMS. This lets competitor AI×gaming news (which often lacks a
// regulatory phrase) still surface as a candidate knowledge-base gap, while
// pure non-AI noise that slips into the tab is still dropped.
const DOMAIN_TERMS = [
  "ai", "a.i.", "artificial intelligence", "generative ai", "genai",
  "machine learning", "deep learning", "neural", "llm", "llms", "chatbot",
  "gaming", "video game", "video games", "game ai", "npc", "game development",
  "synthetic media", "deepfake", "player data", "virtual world",
];
function domainTermsIn(text) {
  const t = String(text || "").toLowerCase();
  const toks = new Set(tokenize(t));
  const found = new Set();
  for (const term of DOMAIN_TERMS) {
    if (term.includes(" ")) { if (t.includes(term)) found.add(term); }
    else if (toks.has(term)) found.add(term);
  }
  return found;
}

function sharedCount(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}
// Ranges covering non-Latin scripts (CJK, Cyrillic, Greek, Arabic, Hebrew,
// Devanagari, Thai, Kana) used to reject clearly non-English items.
// NOTE: the /g flag is REQUIRED — String.prototype.match without it returns a
// single match object (length 1), which silently made the ">6 glyphs" test below
// dead code and let space-free CJK text pass as English.
const NON_LATIN = /[㐀-鿿぀-ヿ\u0400-\u04FF\u0370-\u03FF\u0600-\u06FF\u0590-\u05FF\u0900-\u097F\u0E00-\u0E7F]/g;
function isLikelyEnglish(text) {
  // Permissive heuristic (not a real language detector): only bail on a solid
  // block of non-Latin glyphs (>6) and otherwise require a 60% Latin-token ratio,
  // so accented/technical English still passes.
  const t = String(text || "").replace(/<[^>]+>/g, " ");
  const nonLatin = (t.match(NON_LATIN) || []).length;
  if (nonLatin > 6) return false; // a solid block of non-Latin -> not English
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return true;
  let latin = 0;
  for (const tk of tokens) {
    if (/^[A-Za-z0-9'’.,:;”’“()\-\/!?]+$/.test(tk)) latin++;
  }
  return latin / tokens.length >= 0.6;
}

// (A2) Genuine-language gate. isLikelyEnglish only rejects NON-LATIN scripts,
// so Latin-script European languages (Italian, French, German, Spanish, ...) slip
// through and pollute Suggested Updates with non-English items. looksNonEnglish
// detects them via per-language function-word fingerprints (and the non-Latin
// guard), so an item is admitted only when it clearly reads as English.
const EU_LANG_STOPWORDS = {
  es: new Set(["la","de","el","y","en","que","los","las","una","por","con","para","del","se","su","al","lo","le","este","esta","son"]),
  fr: new Set(["le","la","de","et","un","une","les","des","du","en","est","pour","avec","sur","au","ce","cette","dans","qui"]),
  de: new Set(["der","die","das","und","in","den","von","zu","mit","fur","ist","ein","eine","auf","im","am","dem","des","nicht"]),
  it: new Set(["il","di","la","e","che","una","per","con","del","al","alla","della","sono","nel","nella","dei","questo","questa","come","piu","sul","linee","guida","tuoi","diritti"]),
  pt: new Set(["a","o","de","e","que","do","da","em","um","uma","para","com","se","nao","no"]),
  nl: new Set(["de","het","en","van","in","is","op","te","dat","die","een","voor","met","zijn"]),
};
function looksNonEnglish(text, minHits = 2) {
  if (!text) return false;
  if ((String(text).match(NON_LATIN) || []).length > 6) return true; // non-Latin -> non-English
  const words = String(text).toLowerCase().match(/[a-zà-ÿ]+/g) || [];
  if (words.length < 3) return false; // too short to judge reliably; admit
  for (const set of Object.values(EU_LANG_STOPWORDS)) {
    let hits = 0;
    for (const w of words) if (set.has(w)) hits++;
    if (hits >= minHits) return true;
  }
  return false;
}

// (B) Source-language whitelist. Each monitored source may declare a `language`
// in data/sources.json (ISO-ish code). Only English-declared sources may feed
// the proposal queue; any other language is dropped at the classify step so a
// future non-English source can never silently leak into Suggested Updates.
// A missing declaration is tolerated (treated as allowed) for backwards
// compatibility with older source entries.
const ALLOWED_SOURCE_LANGUAGES = new Set(["en", "eng", "english"]);
function sourceLanguageAllowed(source) {
  if (!source || !source.language) return true;
  return ALLOWED_SOURCE_LANGUAGES.has(String(source.language).toLowerCase());
}

// (C) Persisted-proposal language guard. A proposal already sitting in the
// queue is re-validated here so that non-English items — which could have
// slipped past the original headline-only gate, or been carried forward across
// many scans — are purged. Thin text (<40 chars) is kept and left for the
// per-scan enrichment re-check (which sees the full article body), so we never
// purge on an empty/short snippet alone.
function proposalLanguageOk(p) {
  const t = `${p.title || ""} ${p.snippet || ""} ${p.preview || ""}`.trim();
  // A solid block of non-Latin glyphs is unambiguously non-English even when
  // the text has no spaces or is short (so the token-ratio heuristic can't fire).
  if ((t.match(NON_LATIN) || []).length > 6) return false;
  // Genuinely thin text (<40 chars) can't be judged by the ratio test; keep it
  // and let the per-scan enrichment re-check (full article body) decide.
  if (t.length < 40) return true;
  return isLikelyEnglish(t);
}
function overlap(aSet, bSet) {
  if (!aSet.size || !bSet.size) return { shared: 0, score: 0 };
  let shared = 0;
  for (const t of aSet) if (bSet.has(t)) shared++;
  const score = shared / (aSet.size + bSet.size - shared); // Jaccard
  return { shared, score };
}
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return "pc_" + (h >>> 0).toString(36);
}

// Build an index of the EXISTING curated content so we can tell whether a fetched
// item is already covered, expands an entry, or is genuinely new.
function buildExistingIndex() {
  const records = [];
  const push = (dataset, recordId, title, text) => {
    const full = `${title || ""} ${text || ""}`;
    const t = tokenize(full);
    if (!t.length) return;
    records.push({ dataset, recordId, title: title || "", tokens: new Set(t), strong: strongTermsIn(full) });
  };
  // getDataset returns null (instead of throwing) if a data file is missing or
  // corrupt, so a single broken file degrades that dataset's index instead of
  // taking down the whole scan. mtime caching means repeat scans in one process
  // reuse the parse instead of re-reading 3 files every time.
  const tl = getDataset("regulatory-timeline");
  if (tl) {
    (tl.events || []).forEach((e, i) =>
      push("timeline", `timeline:${i}`, e.title, `${e.title} ${e.description || ""} ${e.jurisdiction || ""} ${e.category || ""}`));
  }
  const kb = getDataset("knowledge");
  if (kb) {
    for (const [k, cat] of Object.entries(kb.categories || {})) {
      (cat.subsections || []).forEach((s, i) => push("knowledge", `knowledge:${k}:${i}`, s.title, `${s.title} ${s.content || ""}`));
    }
  }
  const uc = getDataset("current-use-cases");
  if (uc) {
    (uc.patterns || []).forEach((p, i) => push("use-cases", `uc:${i}`, p.title, `${p.title} ${p.content || ""} ${(p.games || []).join(" ")}`));
  }
  return records;
}

function bestMatch(itemTokens, itemStrong, index) {
  // Best-matching existing record, or null. A record matches only if it shares a
  // STRONG AI-regulation anchor term AND at least one other term (precise — stops
  // trivial "ai"/"model" collisions), or has solid general overlap (Jaccard >= 0.12
  // with >= 2 shared tokens). rank = 1 (strong-anchor bonus) + Jaccard score, and
  // is what the UI surfaces as "match confidence" — it CAN exceed 1.0, so the UI
  // must not render it as a percentage.
  let best = null;
  for (const rec of index) {
    const { shared, score } = overlap(itemTokens, rec.tokens);
    const sharedStrong = rec.strong ? sharedCount(rec.strong, itemStrong) : 0;
    // Match only when there is a strong AI-regulation anchor in common AND at
    // least one other shared term (precise, avoids trivial "ai"-only matches),
    // or a solid general-text overlap.
    const isMatch = (sharedStrong >= 1 && shared >= 1) || (score >= 0.12 && shared >= 2);
    if (!isMatch) continue;
    const rank = (sharedStrong >= 1 ? 1 : 0) + score;
    if (!best || rank > best.rank) best = { ...rec, shared, score, sharedStrong, rank };
  }
  return best;
}

// Decide which Knowledge Base category a proposed item belongs to, based on the
// ARTICLE CONTENT (not just the source's category). This fixes the case where a
// regulator (e.g. AISI) publishes a model-capability assessment that should land
// under "Case Studies", not "Regulations".
const CATEGORY_LABELS = {
  "regulations": "Regulatory Development",
  "case-studies": "Case Study",
  "technology": "Technology",
  "use-cases": "AI Use Case",
  "strategic-insights": "Strategic Insight",
  "competitors": "Competitor Note",
  "tencent-products": "Tencent Product",
  "current-game-ai": "Current Game AI",
};

// Only allow category keys that exist in CATEGORY_LABELS. This blocks both
// arbitrary keys (which would create stray top-level categories) and the
// prototype-pollution keys "__proto__"/"constructor"/"prototype" — assigning
// data.categories["__proto__"] would mutate Object.prototype. Returns the safe
// key, or null if the supplied key is not a known category.
function sanitizeCategoryKey(key) {
  if (typeof key !== "string") return null;
  if (Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, key)) return key;
  return null;
}
const NAMED_MODEL = /\b(gpt-?[345]\b|claude|gemini|llama|kimi|qwen|mistral|grok|deepseek|ernie|yi-|phi-|mixtral|o[13]\b|gpt4|gpt5)\b/;

// ---- Proposed-change "why suggested" taxonomy. This is intentionally SEPARATE
// from detectedAction (which describes the integration action: update/deadline/
// correction/new). These buckets answer WHY an update is proposed so the user
// can group/skim them and compare each one against the existing app entry.
const UPDATE_REASON_KEYS = ["information-outdated", "additional-information", "new-case-study", "new-deadline", "new-development"];
const UPDATE_REASON_LABELS = {
  "information-outdated": "Information Outdated",
  "additional-information": "Additional Information",
  "new-case-study": "New Case Study",
  "new-deadline": "New Deadline",
  "new-development": "New Development",
};
// Few-shot anchors so the model's rewrite matches the app's house style (formal,
// neutral, evidential, concrete figures/dates). These facts are illustrative
// only — the model must use the supplied excerpt, never these examples.
const STYLE_EXAMPLES = `Example entries (match the register only, do NOT reuse these facts):
"On 23 July 2026, the European Commission fined Google (Alphabet) €890 million under the Digital Markets Act: €460M for self-preferencing in Search, €430M for anti-steering on Google Play. This signals the enforcement posture organisations should anticipate as AI obligations become operational."
"Unlike the EU's single horizontal AI law, the UK relies on five principles implemented through existing regulators (ICO, Ofcom, CMA, FCA), creating a dual compliance burden for multinationals."`;
function detectKnowledgeCategory(text, sourceCategory) {
  const t = String(text || "").toLowerCase();
  const caseStudy = /\b(assessment|evaluation|preliminary assessment|benchmark|capabilit|cyber capab|red[ -]?team|model card|safety (case|test)|case study|proliferation|frontier model)\b/;
  const regulation = /\b(ai act|eu ai|uk ai|gdpr|data protection|\bico\b|\bedpb\b|legislation|directive|compliance|deadline|enforce|ruling|fine\b|ban\b|prohibit|regulat|policy|guidance|bill\b|\blaw\b)\b/;
  const technology = /\b(architecture|algorithm|training|inference|dataset|technique|framework|tooling|method)\b/;
  if (caseStudy.test(t) || NAMED_MODEL.test(t)) return "case-studies";
  if (regulation.test(t)) return "regulations";
  if (sourceCategory === "use-case") return "use-cases";
  if (technology.test(t)) return "technology";
  // Default for regulator/academic "new" items that read like an assessment or
  // research note rather than a law.
  return "case-studies";
}

// Primary Google News resolver. A news.google.com/rss/articles/<id> URL
// 302-redirects server-side straight to the publisher — but only when requested
// with a browser User-Agent (search bots and headless UAs are served a
// challenge/interstitial instead). So we follow that redirect chain directly,
// which is far more reliable than the DDG/GDELT/Jina search fallbacks (those are
// frequently bot-challenged or blocked in some environments). We use
// redirect:"manual" and only ever follow hops that stay inside the trusted
// news.google.com aggregator; the moment a redirect leaves it we treat that as
// the publisher and validate its host through assertPublicHost (SSRF protection:
// a private/loopback/link-local host is never returned). The chain is capped at
// 5 hops with a per-hop timeout. Returns the publisher URL, or null if we never
// reach one (loop, cap exceeded, challenge page, or the final host is still the
// aggregator itself). Best-effort and silent: any failure returns null so the
// caller can fall back to the search providers.
async function followGoogleRedirect(googleUrl) {
  let current;
  try {
    current = validateSourceUrl(String(googleUrl).slice(0, 2000));
  } catch {
    return null;
  }
  if (!/news\.google\.com/i.test(current)) return null; // not a Google News link

  const seen = new Set();
  for (let hop = 0; hop <= READER_MAX_REDIRECTS; hop++) {
    if (seen.has(current)) return null; // redirect loop
    seen.add(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READER_TIMEOUT_MS);
    try {
      const res = await fetch(current, {
        headers: {
          "User-Agent": SCRAPE_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,text/plain,application/xml",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      // A final response (non-3xx, or 3xx without a Location) means we reached the
      // end of the chain. For a Google News link that end is the aggregator
      // interstitial, not the publisher -> no resolution.
      if (!(res.status >= 300 && res.status < 400) || !res.headers.get("location")) {
        return null;
      }
      const next = new URL(res.headers.get("location"), current).toString();
      const nextHost = new URL(next).hostname;
      // A server-side fetch never receives a real publisher redirect from Google
      // News — instead it lands on consent.google.com / accounts.google.com (the
      // GDPR/region consent wall) or loops inside the aggregator. Treat those as
      // "resolution impossible" rather than mistaking the consent host for the
      // publisher (which would fetch the consent interstitial as "the article").
      if (/(^|\.)(consent|accounts)\.google\.com$/i.test(nextHost)) return null;
      // Only follow hops that stay inside the trusted aggregator; anything else is
      // the publisher. Match the aggregator as a whole host (boundary-anchored) so
      // a look-alike like "xnews.google.com" or "news.google.com.evil" is NOT
      // treated as the aggregator and is instead validated as a publisher target.
      if (/(^|\.)news\.google\.com$/i.test(nextHost)) {
        current = next; // still inside the aggregator — keep following
        continue;
      }
      // We've left the aggregator — this is the publisher. Validate its host
      // before returning (assertPublicHost rejects private/loopback/link-local).
      try {
        await assertPublicHost(nextHost);
      } catch {
        return null;
      }
      return next;
    } catch (err) {
      if (err && err.name === "AbortError") return null; // hop timed out
      return null; // any other failure (network, DNS) -> best-effort null
    } finally {
      clearTimeout(timer);
    }
  }
  return null; // exceeded the hop cap
}

// Google News RSS <link> values are redirect URLs that loop back to the Google
// News SPA server-side (they never reach the publisher). Resolve the real article
// URL by searching DuckDuckGo for the title on the source's own domain and
// decoding the `uddg` redirect param. Serialized + paced via ddgResolveChain so
// we never hammer DDG in parallel (which triggers rate limiting). Cached so we
// rarely re-query. Best-effort: returns null on any failure. Falls back to the
// GDELT DOC API if DuckDuckGo can't resolve the URL.
async function resolveGoogleNewsUrl(googleUrl, title, domain, chains = scannerChains) {
  if (resolvedUrlMap.has(googleUrl)) return resolvedUrlMap.get(googleUrl);
  // Session-only negative cache: a URL that just failed all resolvers is skipped
  // so the reader / scanner don't re-hammer it. Cleared if a later resolution wins.
  if (resolverNegativeCache.has(googleUrl)) return null;
  resolverStats.attempts++; // a real (non-cached) resolution is being attempted
  // A publisher NAME (e.g. "Reuters") is not a domain; DDG's `site:` and GDELT's
  // `domain:` filters only match real domains, so a name makes every variant
  // fail. Treat a name-only value as "no domain" and resolve by title alone.
  const effectiveDomain = domain && domain.includes(".") ? domain : "";
  const cacheAndReturn = (real) => {
    if (!real) {
      // All resolvers exhausted for this URL this session — remember the miss so
      // we don't retry it repeatedly (keeps the reader snappy, saves outbound calls).
      resolverNegativeCache.add(googleUrl);
      return null;
    }
    resolverStats.ok++; // a real publisher URL was successfully resolved
    resolvedUrlMap.set(googleUrl, real);
    resolverNegativeCache.delete(googleUrl); // a later success clears any prior miss
    if (!sourceState.resolvedUrls) sourceState.resolvedUrls = {};
    sourceState.resolvedUrls[googleUrl] = real;
    return real;
  };
  // 0) Direct redirect-follow (NEW primary resolver). news.google.com links
  //    302 to the publisher for a browser UA; following that chain directly is
  //    far more reliable than the search-engine fallbacks below, which are often
  //    bot-challenged or blocked. Returns the real publisher URL, or null.
  try {
    const direct = await followGoogleRedirect(googleUrl);
    if (direct) return cacheAndReturn(direct);
  } catch (_) { /* fall through to search providers */ }

  // 1) Jina Reader (keyless) — tried when SEARCH_PROVIDER=jina. Resolves
  //    the title to the real publisher URL via Jina's search endpoint, which
  //    works from any IP (no DDG/GDELT bot-challenge). Falls back to DDG/GDELT
  //    if Jina is unavailable or rate-limited.
  if (activeSearchProvider() === "jina") {
    try {
      const hit = (await jinaSearch(`${title}${effectiveDomain ? ` site:${effectiveDomain}` : ""}`, 5))[0];
      if (hit && hit.url) return cacheAndReturn(hit.url);
    } catch (e) {
      // HTTP 401/402 from Jina's search endpoint are expected on a keyless/free
      // key (search is a paid feature) — resolution falls back to DDG/GDELT, so
      // stay quiet. Only log genuine failures (timeouts, 5xx).
      if (!/HTTP 40[12]/.test(e.message)) console.warn("[resolve] Jina failed, falling back to DDG/GDELT:", e.message);
    }
  }
  // One DuckDuckGo attempt, serialized + paced + rotating UA. Returns the decoded
  // publisher URL or null. We try a few query variants (most specific first) to
  // maximise the chance of a hit despite DDG's occasional challenge page.
  const tryDdg = (queryTitle) => {
    const task = chains.ddg.then(async () => {
      const minGap = 700;
      const wait = chains.lastDdg + minGap - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      chains.lastDdg = Date.now();
      if (!queryTitle) return null;
      const site = effectiveDomain ? ` site:${effectiveDomain}` : "";
      const q = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${queryTitle}${site}`)}`;
      try {
        const res = await fetchTextResource(q, "text/html,application/xhtml+xml,text/plain", 6000, nextResolverUa());
        const uddg = (res.text.match(/uddg=([^&"'\s]+)/) || [])[1];
        if (!uddg) return null;
        const real = decodeURIComponent(uddg);
        return /^https?:\/\//i.test(real) ? real : null;
      } catch {
        return null;
      }
    });
    // Reassign so the next call (title-only fallback) chains AFTER this one,
    // keeping DDG strictly serialised on this chain set.
    chains.ddg = task.catch(() => null);
    return task;
  };
  // 2) DuckDuckGo (primary): title + site, then title alone (broader).
  const ddgUrl = (await tryDdg(title)) || (await tryDdg(String(title).replace(/\s*[–—-]\s*[^–—-]+$/, "").trim() || title));
  if (ddgUrl) return cacheAndReturn(ddgUrl);
  // 3) GDELT DOC API (secondary): real publisher URLs directly. Reached only when
  //    DDG fails, so rarely exercised — but it gives the scan a second (third)
  //    chance to fetch a real preview in production.
  const gdeltUrl = await resolveViaGdelt(title, effectiveDomain, chains);
  return cacheAndReturn(gdeltUrl);
}

// Resolve an article to its real publisher URL via the GDELT DOC API. GDELT
// needs a slower pace (≈1 req / 5s) and a well-formed query, so we serialise it
// on its own chain. We only accept a result whose domain actually matches the
// source, so we never inject an unrelated article. Returns null on any failure.
async function resolveViaGdelt(title, domain, chains = scannerChains) {
  if (!title || !domain) return null;
  // Try an exact quoted phrase first, then a looser keyword query, so a partial
  // title still has a chance of matching the article in GDELT's index.
  const queries = [];
  const clean = String(title).replace(/\s*[–—-]\s*[^–—-]+$/, "").trim() || title;
  queries.push(`domain:${domain} "${clean}"`);
  const kw = clean.split(/\s+/).filter(w => w.length > 3).slice(0, 6).join(" ");
  if (kw && kw !== clean) queries.push(`domain:${domain} ${kw}`);
  const task = chains.gdelt.then(async () => {
    const dm = domain.replace(/^www\./i, "");
    for (const q of queries) {
      const minGap = 5500;
      const wait = chains.lastGdelt + minGap - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      chains.lastGdelt = Date.now();
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&maxrecords=10&format=json&sortby=datedesc`;
      try {
        const res = await fetchTextResource(url, "application/json,text/plain", 6000, nextResolverUa());
        const j = JSON.parse(res.text);
        const arts = j.articles || [];
        const match = arts.find(a => a.domain && a.domain.replace(/^www\./i, "").includes(dm)) || arts[0];
        if (!match || !/^https?:\/\//i.test(match.url)) continue;
        // Guard against an aggregator that GDELT mislabels with our domain.
        try {
          const host = new URL(match.url).hostname.replace(/^www\./i, "");
          if (!host.includes(dm)) continue;
        } catch { continue; }
        return match.url;
      } catch {
        continue;
      }
    }
    return null;
  });
  chains.gdelt = task.catch(() => null);
  return task;
}

// Build a short lead excerpt to PREVIEW the text a proposed change would add.
// Strategy (reliable + low-cost first, network only when needed):
//   1. If the RSS description already summarises the article (substantive content
//      beyond the headline + publisher name), use it directly — no fetch, no rate
//      limits. We explicitly reject "Title - Publisher" packaging, which Google
//      News often returns instead of a summary.
//   2. Otherwise (thin snippet) try to fetch the real article. Google News RSS
//      links can't be followed to the publisher server-side, so resolve the real
//      URL via DuckDuckGo/GDELT (serialized + cached) and extract the body.
// Detect an anti-bot / bot-wall / "verify you are human" interstitial page.
// These are returned (often with a 200, sometimes a 403/503) when a site blocks
// automated access, and must NOT be treated as the article body.
function looksLikeBotWall(text) {
  const lc = (text || "").toLowerCase();
  const markers = [
    "enable javascript and cookies",
    "verify you are human",
    "checking your browser before",
    "just a moment",
    "are you a robot",
    "are you a human",
    "access denied",
    "you are being rate limited",
    "please verify you are a human",
    "cloudflare",
    "attention required",
    "ddos protection",
    "please stand by",
    "automated access is disabled",
    "this site requires javascript",
    "unable to fetch this page",
  ];
  return markers.some(m => lc.includes(m));
}

// Returns { text, blocked }. `text` is a usable lead excerpt, or null. `blocked`
// is true when the source blocked automated access (bot-wall / anti-scrape), so
// the caller can flag the proposal for manual review instead of caching garbage.
// Returns { text, body, blocked }.
//  - `text`   = a short lead (≤ maxChars) used for the review-card preview.
//  - `body`   = a fuller slice (≤ bodyMaxChars) of the extracted article, used as
//               the ENRICHMENT input so the model can summarise substance that
//               sits beyond the first few sentences (e.g. an enumerated "roadmap"
//               whose steps appear mid-article). Null when only a thin snippet was
//               available and no body fetch ran.
//  - `blocked`= true when the source blocked automated access (bot-wall), so the
//               caller can flag the proposal for manual review.
// Both `text` and `body` are derived from a SINGLE fetched payload — there is no
// second network call for the enrichment body.
async function fetchArticlePreview(item, { timeoutMs = 12000, maxChars = 720, bodyMaxChars = 3500, domain } = {}) {
  if (!item) return { text: null, body: null, blocked: false };
  const snippetText = stripHtml(item.snippet || item.description || "").replace(/\s+/g, " ").trim();
  const titleText = String(item.title || "").toLowerCase();
  // A snippet is only usable if it carries real information BEYOND the headline
  // and publisher name. Google News frequently returns just "Title - Publisher",
  // which is NOT a summary — in that case we must fetch the article body instead.
  const publisher = String(item.publisher || item.sourceName || "").toLowerCase();
  const extra = snippetText.toLowerCase()
    .replace(titleText, "")
    .replace(publisher, "")
    .replace(/[–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const snippetIsThin = snippetText.length < 120 || extra.length < 40;

  const toLead = (s, n) => {
    const sentences = s.match(/[^.!?]+[.!?]+/g) || [s];
    let lead = sentences.slice(0, n).join(" ").trim();
    if (lead.length > maxChars) lead = lead.slice(0, maxChars).trim().replace(/[,;]\s*$/, "") + "…";
    return lead;
  };
  // The enrichment body is the fuller extracted text, capped to keep the model
  // call cheap; the card preview (text) is always the shorter lead.
  const toBody = (s) => (s && s.length > bodyMaxChars ? s.slice(0, bodyMaxChars).trim() : (s || null));

  if (!snippetIsThin) {
    return { text: toLead(snippetText, 3), body: null, blocked: false };
  }

  if (!item.url) return { text: null, body: null, blocked: false };
  let articleUrl = item.url;
  if (/news\.google\.com/i.test(articleUrl)) {
    // Render's server-side egress can't follow Google News' 302 redirect — it
    // lands on the consent/GDPR wall, so resolveGoogleNewsUrl returns null
    // (live /healthz shows resolver attempts:18, ok:0). Jina's reader resolves
    // + extracts the redirect from its OWN infra, so when Jina is the active
    // provider we extract the Google News URL directly instead of relying on the
    // local resolver. This is what unblocks proposal previews (and therefore
    // enrichment) on the free-tier host.
    if (activeSearchProvider() === "jina") {
      try {
        const jt = await jinaExtract(item.url, timeoutMs);
        if (jt && jt.length >= 140 && !looksLikeBotWall(jt)) {
          return { text: toLead(jt, 4), body: toBody(jt), blocked: false };
        }
      } catch (_) { /* fall through to the local resolver / direct fetch */ }
    }
    // The local resolver fails 100% of the time from Render's egress, so don't
    // bother with it. Try the governed Jina extractor (keyed, works from any IP)
    // as a second attempt before giving up on the preview.
    try {
      const via = await extractor.extractArticle(item.url, { licenseClass: "news-fair-use" });
      if (via && via.text && via.text.trim().length >= 140) {
        return { text: toLead(via.text, 4), body: toBody(via.text), blocked: false };
      }
    } catch (_) { /* fall through */ }
    return { text: null, body: null, blocked: false };
  }
  try {
    let full;
    if (activeSearchProvider() === "jina") {
      full = await jinaExtract(articleUrl, timeoutMs);
    } else {
      const resource = await fetchTextResource(articleUrl, "text/html,application/xhtml+xml,text/plain", timeoutMs);
      full = extractText(resource.text).replace(/\s+/g, " ").trim();
    }
    if (full.length < 140) return { text: null, body: null, blocked: false };
    if (looksLikeBotWall(full)) return { text: null, body: null, blocked: true };
    return { text: toLead(full, 4), body: toBody(full), blocked: false };
  } catch (err) {
    // Distinguish an access block (bot-wall / anti-scrape) from a transient
    // network error so we flag the former for manual review rather than retry
    // endlessly on something that will never succeed automatically.
    const msg = (err && err.message ? err.message : "").toLowerCase();
    const accessBlocked = /http (401|403|429|503)|forbidden|access denied|unable to fetch|are you a robot|verify you are human|cloudflare/i.test(msg);
    return { text: null, body: null, blocked: accessBlocked };
  }
}

// Run an async mapper over items with bounded concurrency (so a slow article
// fetch doesn't serialize the whole scan).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        // One item failing must not reject Promise.all and abandon the rest of
        // the scan. Record the error and keep going.
        results[i] = { error: String((err && err.message) || err) };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// P3 — auto-draft the suggested edit shown in the review panel (pre-filled). The
// draft now embeds a real preview of the source text when available, so the
// proposed change reads like the curated entries already on the app.
function draftEdit(item, action, publisher, label, preview) {
  const cite = ` [Source: ${publisher}, ${label}]`;
  const info = (preview || stripHtml(item.snippet || item.description || "")).trim();
  const body = info ? `${info} ` : "";
  if (action === "deadline") return `New compliance deadline announced: ${item.title}. ${body}${cite}`;
  if (action === "correction") return `This position appears to have changed — ${item.title}. ${body}${cite}`;
  return `Latest (${label}): ${body}${cite}`;
}
function draftNewRecord(item, publisher, label, categoryKey, preview) {
  const cite = `Source: ${publisher} (${label}).`;
  const body = (preview || stripHtml(item.snippet || item.description || "")).trim();
  const catLabel = CATEGORY_LABELS[categoryKey] || "Knowledge Entry";
  if (!body) return `Add as new ${catLabel} — "${item.title}". ${cite}`;
  return `Add as new ${catLabel} — "${item.title}".\n\n${body}\n\n${cite} Verify details against the official source before relying on this entry.`;
}

// Robust JSON extraction for model output. Tries, in order: the raw string, a
// fenced block (``` or ```json ... ```), and finally the outermost {...} span so
// that prose such as "Here is the JSON:" before/after the object does not break
// parsing. Returns the parsed object, or undefined on total failure.
function extractJson(s) {
  const t = String(s || "").trim();
  const tryParse = (str) => {
    try { return JSON.parse(str); } catch { return undefined; }
  };
  let obj = tryParse(t);
  if (obj && typeof obj === "object") return obj;
  const fenced = t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
  obj = tryParse(fenced);
  if (obj && typeof obj === "object") return obj;
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last > first) {
    obj = tryParse(t.slice(first, last + 1));
    if (obj && typeof obj === "object") return obj;
  }
  return undefined;
}

// Look up the curated content of an existing matched record so the model can
// frame a rewrite as a DELTA against what the app already says.
// Per-dataset cache of the parsed curated data files. existingRecordContent runs
// once per matched ("update"/"correction"/"deadline") proposal during a scan;
// without this it re-read + re-parsed the full file for EVERY such proposal
// (the N+1 read the scan used to do). Keyed by file mtime so a write that
// changes the file (integrate) is picked up automatically on the next read.
const contentCache = { timeline: null, knowledge: null, "use-cases": null };
const CONTENT_FILE = { timeline: "regulatory-timeline.json", knowledge: "knowledge.json", "use-cases": "current-use-cases.json" };
function loadContent(dataset) {
  const file = CONTENT_FILE[dataset];
  if (!file) return null;
  const p = path.join(__dirname, "data", file);
  try {
    const st = fs.statSync(p);
    const cached = contentCache[dataset];
    if (cached && cached.mtime === st.mtimeMs) return cached.data;
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    contentCache[dataset] = { mtime: st.mtimeMs, data };
    return data;
  } catch { return null; }
}

function existingRecordContent(matched) {
  if (!matched || !matched.dataset) return "";
  const data = loadContent(matched.dataset);
  if (!data) return "";
  if (matched.dataset === "timeline") {
    const ev = (data.events || []).find(e => e.title === matched.title);
    return ev ? ev.description || "" : "";
  }
  if (matched.dataset === "use-cases") {
    const p = (data.patterns || []).find(p => p.title === matched.title);
    return p ? p.content || "" : "";
  }
  if (matched.dataset === "knowledge") {
    for (const cat of Object.values(data.categories || {})) {
      const sub = (cat.subsections || []).find(s => s.title === matched.title);
      if (sub) return sub.content || "";
    }
  }
  return "";
}

// Combined enrichment: ask the model to (a) classify why this is suggested and
// (b) rewrite the raw source excerpt into the app's house style. For updates we
// pass the existing entry so the rewrite reads as a delta. Returns null on any
// failure so the caller keeps the heuristic category and a pending/rate-limited
// status — the raw excerpt is NEVER presented as the finished suggestion.
// Quality gate for an enriched model result. Returns null when valid, or a
// human-readable reason string when the output must be rejected/retried. Guards
// the structured schema from the overhaul: every enriched update must carry a
// substantive English summary, a jurisdiction, and a "why it matters" impact
// statement — and must not merely restate the headline.
function enrichmentFailure(obj, prop) {
  if (!obj || typeof obj !== "object") return "no structured output";
  const summary = typeof obj.styledSummary === "string" ? obj.styledSummary.trim() : "";
  if (!summary) return "missing styledSummary";
  if (summary.length < 80) return "styledSummary too short (<80 chars)";
  const jurisdiction = typeof obj.jurisdiction === "string" ? obj.jurisdiction.trim() : "";
  if (jurisdiction.length < 2) return "missing jurisdiction";
  // The "why it matters" rationale is now folded INTO styledSummary (the single
  // combined entry text), so there is no separate field to validate here.
  // Restatement guard: a good summary must add materially beyond the headline.
  const title = String((prop && prop.title) || "").toLowerCase();
  if (title.length > 12) {
    const sumTok = new Set(summary.toLowerCase().match(/[a-z]+/g) || []);
    const titleTok = new Set(title.match(/[a-z]+/g) || []);
    let novel = 0;
    for (const t of sumTok) if (!titleTok.has(t)) novel++;
    const novelFrac = sumTok.size ? novel / sumTok.size : 0;
    if (novelFrac < 0.3) return "summary restates the headline without new content";
  }
  return null;
}

async function enrichWithModel(prop, excerpt, opts = {}) {
  const allowReject = opts.allowReject !== false; // scan lane honours rejections; manual lane forces a summary
  const text = (excerpt || stripHtml(prop.snippet || prop.description || "")).trim();
  if (!text) return null;
  const existing = prop.matchedRecord
    ? `EXISTING APP ENTRY (title: ${prop.matchedRecord.title}):\n${existingRecordContent(prop.matchedRecord).slice(0, 700) || "(content unavailable)"}\n\n`
    : "";
  // Manual submissions are analyst-curated, so we tell the model to always
  // produce a styledSummary and never reject them as non-substantive.
  const forceNote = allowReject ? "" : "\n\nThis item was manually submitted by an analyst for the AI & gaming competitive-intelligence knowledge base. It is always substantive — produce a full styledSummary and do NOT set rejected:true.";
  const system = `You rewrite AI-regulation/policy and AI×gaming news into the house style of a curated competitive-intelligence knowledge base. House style: formal, neutral, third-person, factual; state concrete figures, dates and regulation/article references; 2-4 sentences that describe what the document ACTUALLY SAYS — never merely echo the headline; no promotional or journalistic language; never invent facts not in the source. ${STYLE_EXAMPLES}${forceNote}`;
  const user = `Analyse this AI-regulation/policy or AI×gaming source and return ONE structured knowledge-base entry.${existing}
SOURCE TITLE (${prop.publisher || "unknown"}): ${prop.title}
SOURCE TEXT:
${text}

Return ONLY valid JSON:
{
  "updateCategory": one of "information-outdated" | "additional-information" | "new-case-study" | "new-deadline" | "new-development",
  "jurisdiction": the relevant legal scope, e.g. "EU", "United Kingdom", "United States", "France", "global" (use "unknown" only if genuinely unspecified),
  "styledSummary": 2-4 sentences in English in the knowledge-base house style. Describe what the source ACTUALLY says AND — crucially — WHY it matters as an update to the knowledge base: what gap it fills, or which existing node it updates or outdates. For an update to an existing entry, write it so it could be appended to (or replace) that node. State concrete figures, dates and regulation/article references. Max 600 chars. Do NOT add a citation line — the app shows the source link. Never invent facts.
  "rejected": true ONLY if this is a job posting, a hiring/careers page, an event invitation, or otherwise not a substantive AI-regulation/policy or AI×gaming development. If rejected, set styledSummary to "".
}`;
  const build = (obj) => ({
    updateCategory: UPDATE_REASON_KEYS.includes(obj.updateCategory) ? obj.updateCategory : (prop.detectedAction === "deadline" ? "new-deadline" : "new-development"),
    styledSummary: obj.styledSummary.slice(0, 600).trim(),
    jurisdiction: String(obj.jurisdiction || "unknown").slice(0, 80).trim(),
  });
  const parse = (raw) => { try { return extractJson(raw); } catch { return null; } };

  const raw = await summariseEngine.runModelChat(system, user, { maxTokens: 600, temperature: 0.2, json: true, timeoutMs: 25000, lane: "scan" });
  if (raw && raw.rateLimited) return { rateLimited: true };
  if (!raw) return null;
  const obj = parse(raw);
  if (obj && obj.rejected === true) {
    // Forced (manual) path: still use the summary if the model provided one.
    if (!allowReject && obj.styledSummary && obj.styledSummary.trim()) return build(obj);
    return { rejected: true }; // Option B: model judged this non-substantive
  }
  if (!obj) return null;
  const fail = enrichmentFailure(obj, prop);
  if (!fail) return build(obj);

  // Quality gate failed. The scan lane gets ONE stricter retry (paced like the
  // first call); the manual (forced) lane returns best-effort rather than
  // blocking an analyst-curated item.
  if (!allowReject) return build(obj);
  await paceScanModelCall();
  const retryUser = user + `\n\nPREVIOUS OUTPUT FAILED VALIDATION: ${fail}. Rewrite with a substantive 2-4 sentence English summary describing the document's actual content and concrete impact (and why it matters as a knowledge-base update), a real "jurisdiction", and no headline restatement.`;
  const raw2 = await summariseEngine.runModelChat(system, retryUser, { maxTokens: 600, temperature: 0.2, json: true, timeoutMs: 25000, lane: "scan" });
  if (raw2 && raw2.rateLimited) return { rateLimited: true };
  const obj2 = parse(raw2);
  if (obj2 && obj2.rejected === true) return { rejected: true };
  if (obj2) {
    const fail2 = enrichmentFailure(obj2, prop);
    if (!fail2) return build(obj2);
  }
  // Both attempts failed validation -> flag for manual review (UI shows it as
  // "Manual review required"); surface any partial fields for the reviewer.
  return { blocked: true, partial: build(obj2 || obj) };
}

// Generate an AI styledSummary for a stored (manual) item when one is missing.
// Reuses the scan enrichment prompt so manual items match the app's house style
// and AI-regulation framing. Forced (non-rejecting) because the analyst pasted
// this deliberately — we never want to drop a manually-submitted article to raw
// text. Never clobbers an existing good summary and respects the engine cooldown.
async function summariseStoredItem(prop, { force = true } = {}) {
  if (!prop || prop.styledSummary) return null;          // already have one; never clobber
  if (isScanRateLimited()) return null;                  // engine cooldown — skip; text still stored
  const text = (prop.body || prop.preview || stripHtml(prop.snippet || "")).trim();
  if (text.length < 80) return null;                     // not enough to summarise
  try {
    const enriched = await enrichWithModel(prop, text, { allowReject: !force });
    if (enriched && enriched.styledSummary) {
      prop.styledSummary = enriched.styledSummary;
      prop.enrichStatus = "done";
      if (enriched.updateCategory) prop.updateCategory = enriched.updateCategory;
      if (enriched.jurisdiction) prop.jurisdiction = enriched.jurisdiction;
      return enriched.styledSummary;
    }
  } catch (_) { /* best effort */ }
  return null;
}

// Whether a pending proposal still needs (re-)enrichment. A fully-enriched item
// has a real preview, a heuristic category, a >=80-char combined summary, AND a
// jurisdiction. Items written by the pre-rebuild code (no jurisdiction, or a
// short legacy summary) return true so the scan loop and the admin re-enrich
// endpoint can upgrade them with the quality-gated prompt instead of leaving
// them frozen forever.
function needsEnrichment(prop) {
  const hasPreview = prop.preview && prop.preview.length;
  const hasReason = prop.updateCategory && UPDATE_REASON_LABELS[prop.updateCategory];
  const hasStyled = prop.styledSummary && prop.styledSummary.length >= 80;
  const hasJurisdiction = prop.jurisdiction && prop.jurisdiction.length >= 2;
  return !(hasPreview && hasReason && hasStyled && hasJurisdiction);
}

// Core per-proposal enrichment, shared by the background scan loop and the admin
// re-enrich endpoint. Fetches a real preview of the article, re-validates
// language on the body, then runs the quality-gated model enrichment. Mutates
// `prop` in place; the CALLER is responsible for persisting via saveProposed().
// `runState` carries the per-run call counter: { callsThisRun: 0 }. `fetcher`
// defaults to fetchArticlePreview and is injectable for tests.
// Returns one of: "enriched" | "blocked" | "rejected" | "rate-limited" | "pending".
async function enrichOneProposal(prop, runState, fetcher = fetchArticlePreview) {
  const PER_PROPOSAL_BACKOFF_MS = config.SCAN_PROPOSAL_BACKOFF_MS;
  let preview = null, blocked = false, result = null;
  try {
    result = await fetcher(prop, { domain: prop.sourceDomain });
    preview = result.text;
    blocked = !!result.blocked;
  } catch { /* best effort */ }
  // Record the attempt even on failure so the cooldown guards against
  // re-hammering a URL the resolver can't currently resolve.
  prop.lastPreviewAttempt = new Date().toISOString();
  if (blocked) {
    // Cache hygiene (#5): do NOT overwrite a previously good preview; flag for
    // manual review and keep any existing good styledSummary untouched.
    prop.fetchStatus = "blocked";
    return "blocked";
  }
  prop.fetchStatus = "ok";
  if (preview) {
    // Cache hygiene (#5): only overwrite the preview when we have content.
    prop.preview = preview;
    if (prop.detectedAction === "new") {
      prop.targetCategory = detectKnowledgeCategory(`${prop.title} ${preview}`, prop.category);
    }
  }
  // (C) Re-validate language on the REAL article text.
  // Prefer the fuller body (when we fetched one) for enrichment so the model
  // sees substance beyond the short card lead; otherwise fall back to the lead/
  // preview, then the RSS snippet. (Step 2: stop echoing headlines when the
  // "5 steps" sit mid-article, past the ≤720-char preview lead.)
  const baseText =
    (result.body && result.body.trim().length >= 140 ? result.body : preview) ||
    stripHtml(prop.snippet || prop.description || "");
  if (baseText && looksNonEnglish(baseText, 3)) {
    prop.rejectedByLanguage = true;
    prop.status = "rejected";
    return "rejected";
  }
  if (!baseText) {
    // Nothing to work with: the live preview fetch failed and there is no usable
    // snippet. Leave an honest "pending" state so a later scan retries.
    prop.enrichStatus = "pending";
    return "pending";
  }
  let enriched = null;
  // Three gates before we are allowed to spend a request.
  const outOfRunBudget = runState.callsThisRun >= SCAN_CALLS_PER_RUN_CAP;
  const outOfDayBudget = scanBudgetRemaining() <= 0;
  if (!isScanRateLimited() && !outOfRunBudget && !outOfDayBudget) {
    // Pace the call so we can never exceed the provider's per-minute ceiling,
    // and count it before it is issued (a failed attempt still consumes quota).
    await paceScanModelCall();
    runState.callsThisRun++;
    consumeScanBudget();
    try { enriched = await enrichWithModel(prop, baseText); } catch { /* best effort */ }
  } else if (outOfRunBudget || outOfDayBudget) {
    // Budget exhausted — do NOT set a cooldown. The proposal stays eligible so
    // the next scan (or the next UTC day) can finish it.
    if (!prop.styledSummary) prop.enrichStatus = "pending";
    return "pending";
  }
  if (enriched && enriched.rateLimited) {
    // Model hit a rate limit: set a per-proposal backoff (deliberately longer
    // than the engine cooldown so parked proposals re-eligible a few at a time).
    prop.enrichCooldownUntil = new Date(Date.now() + PER_PROPOSAL_BACKOFF_MS).toISOString();
    prop.enrichStatus = "rate-limited";
    return "rate-limited";
  }
  if (enriched && enriched.rejected) {
    // Option B: the model determined this is not a substantive AI-regulation/
    // policy development. Drop it from the queue so it never reaches review.
    prop.rejectedByModel = true;
    prop.status = "rejected";
    return "rejected";
  }
  if (enriched && enriched.blocked) {
    // Quality gate failed on both attempts -> manual review, not a bad publish.
    prop.fetchStatus = "blocked";
    if (enriched.partial) {
      prop.styledSummary = enriched.partial.styledSummary || prop.styledSummary || null;
      prop.jurisdiction = enriched.partial.jurisdiction || null;
    }
    if (!prop.styledSummary) prop.enrichStatus = "done";
    return "blocked";
  }
  if (!enriched) {
    // Don't clobber a prior good AI summary if the model just hiccuped.
    if (prop.styledSummary) { prop.enrichStatus = "done"; return "enriched"; }
    // No styled summary and model unavailable -> honest pending state; the next
    // scan (past the per-proposal backoff) retries.
    prop.enrichStatus = "rate-limited";
    prop.enrichCooldownUntil = new Date(Date.now() + PER_PROPOSAL_BACKOFF_MS).toISOString();
    return "rate-limited";
  }
  // Success: persist the model output and mark done. The combined rationale
  // lives inside styledSummary (no separate whyItMatters field).
  prop.updateCategory = enriched.updateCategory;
  prop.styledSummary = enriched.styledSummary || null;
  prop.jurisdiction = enriched.jurisdiction || null;
  prop.enrichStatus = "done";
  const styled = enriched.styledSummary;
  prop.suggestedEdit = prop.detectedAction === "new"
    ? draftNewRecord(prop, prop.publisher, prop.publishedLabel, prop.targetCategory, styled)
    : draftEdit(prop, prop.detectedAction, prop.publisher, prop.publishedLabel, styled);
  return "enriched";
}

// Drop obvious recruitment / non-substantive content before the scan model is
// ever called. This keeps job postings, career pages, "we're hiring" blurbs and
// internship listings out of the Suggested Updates queue (Option A of the
// scan-noise fix) and also saves a scan model call on junk.
const JOB_POSTING_RE = /\b(we'?re\s+hiring|now\s+hiring|apply\s+(now|today|here)|job\s+(opening|posting|listing|vacancy|opportunity)|(open|available)\s+(position|role|vacancy)|position(s)?\s+(available|open)|hiring\s+(for|now)|recruit(ing|ment)|talent\s+(acquisition|search)|careers?\s+(at|page|section)|join\s+(our|the|us)\s+team|\bintern(ship)?\b|\bvacanc(y|ies)\b|\bstaff\s+(opening|position)\b)/i;

function looksLikeJobPosting(text) {
  return JOB_POSTING_RE.test(text || "");
}

// Classify a fetched item: English-only, compared to existing content, and either
// dropped (duplicate/non-English) or returned as a proposed change.
function classifyItem(source, item, index) {
  const text = `${item.title} ${item.description || ""}`;
  if (!sourceLanguageAllowed(source)) return null; // (B) drop non-English-declared source
  if (looksNonEnglish(text, 2)) return null; // (a) drop non-English (incl. Latin-script EU languages)
  if (looksLikeJobPosting(text)) return null; // (a2) drop recruitment / non-substantive noise
  const itemTokens = new Set(tokenize(text));
  if (itemTokens.size < 2) return null;
  const itemStrong = strongTermsIn(text);

  const publisher = item.sourceName || source.name;
  const base = {
    id: hashId(item.url || item.title),
    source: source.id,
    sourceDomain: source.domain,
    publisher,
    title: item.title,
    url: item.url,
    snippet: stripHtml(item.description || ""),
    publishedAt: item.publishedAt,
    publishedLabel: item.publishedAt ? formatLabel(item.publishedAt) : "Recent",
    category: source.category,
    licenseClass: source.licenseClass || "open",
    createdAt: new Date().toISOString(),
    ingestedAt: new Date().toISOString(),
    // Phase 3 retention groundwork: regulatory (3y) vs use-case (living dataset).
    retentionClass: source.category === "use-case" ? "use-case" : "regulatory",
    status: "pending",
  };

  const matched = bestMatch(itemTokens, itemStrong, index);
  if (matched) {
    let action = "update";
    const lc = text.toLowerCase();
    if (/\b(deadline|due|compliance date|effective|enters? into force|by \d{4}|from \d{4})\b/.test(lc) && /\d{4}/.test(lc)) action = "deadline";
    else if (/\b(ruling|decision|judg|court|fine|ban|prohibit|overturn|supersede|repeal|amend|enforce)\b/.test(lc)) action = "correction";
    base.detectedAction = action;
    base.matchConfidence = Number((matched.rank).toFixed(2));
    base.matchedRecord = { dataset: matched.dataset, recordId: matched.recordId, title: matched.title };
    // Target follows the matched record unless this is a deadline (timeline).
    base.targetDataset = action === "deadline" ? "timeline" : matched.dataset;
    base.targetCategory = matched.dataset === "knowledge" ? null : null;
    base.suggestedEdit = draftEdit(item, action, publisher, base.publishedLabel);
    return base;
  }

  // No matching existing record. The News + Search tab is already AI×gaming
  // curated, so any in-tab article with no KB match is a candidate "gap" — but
  // we still require a domain anchor (a strong AI/reg term OR a broader
  // AI×gaming term) so non-AI noise that slipped into the tab is dropped. This
  // widens discovery beyond the reg-only STRONG_TERMS while keeping the
  // AI-regulation-primary guardrail intact.
  if (itemStrong.size >= 1 || domainTermsIn(text).size >= 1) {
    base.detectedAction = "new";
    base.matchConfidence = 0;
    base.matchedRecord = null;
    // Classify the target category from the article content (not the source
    // category) so a regulator's model assessment lands under Case Studies.
    base.targetCategory = detectKnowledgeCategory(text, source.category);
    base.targetDataset = source.category === "use-case" ? "use-cases" : "knowledge";
    base.suggestedEdit = draftNewRecord(item, publisher, base.publishedLabel, base.targetCategory);
    return base;
  }

  return null; // drop: noise / not relevant to existing curated content
}

// Apply an approved proposal to the real curated dataset (user-gated write).
function integrateProposal(prop, edit, target, targetCategoryKey) {
  const fileMap = { timeline: "regulatory-timeline.json", knowledge: "knowledge.json", "use-cases": "current-use-cases.json" };
  const file = fileMap[target];
  if (!file) throw new Error("Unknown target dataset: " + target);
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data", file), "utf8"));
  const publisher = prop.publisher;
  const url = prop.url;

  if (prop.matchedRecord && prop.matchedRecord.dataset === target) {
    if (target === "timeline") {
      const ev = (data.events || []).find(e => e.title === prop.matchedRecord.title);
      if (ev) ev.description = `${ev.description || ""}\n\n${edit}`.trim();
    } else if (target === "knowledge") {
      for (const cat of Object.values(data.categories || {})) {
        const sub = (cat.subsections || []).find(s => s.title === prop.matchedRecord.title);
        if (sub) { sub.content = `${sub.content || ""}\n\n${edit}`.trim(); break; }
      }
    } else if (target === "use-cases") {
      const p = (data.patterns || []).find(p => p.title === prop.matchedRecord.title);
      if (p) p.content = `${p.content || ""}\n\n${edit}`.trim();
    }
  } else {
    if (target === "timeline") {
      data.events = data.events || [];
      data.events.unshift({
        date: (prop.publishedAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
        label: prop.publishedLabel || "Recent",
        title: prop.title,
        jurisdiction: sourceRegistryJurisdiction(prop) || "EU/UK",
        category: "Proposed Update",
        description: edit,
        impact: `Proposed from ${publisher}. Verify via the official link before relying on it.`,
        link: url,
        linkLabel: publisher,
      });
    } else if (target === "knowledge") {
      const key = sanitizeCategoryKey(targetCategoryKey) || sanitizeCategoryKey(prop.targetCategory) || "regulations";
      if (!data.categories[key]) data.categories[key] = { label: CATEGORY_LABELS[key] || key, icon: "", subsections: [] };
      data.categories[key].subsections = data.categories[key].subsections || [];
      data.categories[key].subsections.unshift({ title: prop.title, content: edit, sources: [{ label: publisher, url }] });
    } else if (target === "use-cases") {
      data.patterns = data.patterns || [];
      data.patterns.unshift({ title: prop.title, content: edit, games: [] });
    }
  }

  fs.writeFileSync(path.join(__dirname, "data", file), JSON.stringify(data, null, 2));
  // Hard-invalidate the dataset cache so the next read is guaranteed fresh even
  // if the write's mtime lands in the same tick as the prior cache entry. mtime
  // auto-invalidation in getDataset is the backup; this is the belt-and-suspenders.
  if (target === "timeline") clearDatasetCache("regulatory-timeline");
  if (target === "knowledge") clearDatasetCache("knowledge");
  if (target === "use-cases") clearDatasetCache("current-use-cases");
}
function sourceRegistryJurisdiction(prop) {
  const s = (loadSourceRegistry() || []).find(x => x.id === prop.source);
  return s ? (s.jurisdiction || "EU/UK") : "EU/UK";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatLabel(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "Recent";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

async function runSourceScan({ force = false } = {}) {
  if (sourceScanInFlight) {
    const held = Date.now() - sourceScanStartedAt;
    if (held < SOURCE_SCAN_STALE_MS) {
      return { skipped: true, reason: "scan already in flight" };
    }
    console.warn(`[source-scan] stale lock held ${Math.round(held / 1000)}s — superseding with a new scan`);
  }
  sourceScanInFlight = true;
  sourceScanStartedAt = Date.now();
  scanModelCallsThisRun = 0; // reset per-run call counter for /healthz
  console.log(`[source-scan] starting (force=${!!force})`);
  const startedAt = Date.now();

  try {
    const index = buildExistingIndex();
    // Rebuild: reuse the SAME articles shown in the News + Search tab instead of
    // a separate Google-News-RSS source registry. The tab is already AI×gaming
    // curated, so this removes the bespoke scan-only feed lane entirely.
    const articles = await getScanArticleCandidates();
    // Three independent guards stop the same item being proposed twice:
    //   1. `seen`      — per-scan URL set below.
    //   2. knownIds   — proposal id already present in the review queue.
    //   3. pendingKeys— composite "record-title|action|url" so we don't re-propose
    //                   the same underlying change (e.g. a 2nd deadline on a record
    //                   we already have a pending proposal for).
    const knownIds = new Set((proposedChanges.items || []).map(i => i.id));
    const pendingKeys = new Set(
      (proposedChanges.items || [])
        .filter(i => i.status === "pending")
        .map(i => `${i.matchedRecord ? i.matchedRecord.title : ""}|${i.detectedAction}|${i.url}`)
    );
    let existing = (proposedChanges.items || []).filter(
      p => !p.rejectedByModel && !p.rejectedByLanguage && proposalLanguageOk(p)
    );
    const newProps = []; // proposals created in THIS scan that still need enrichment
    let scanned = 0, considered = 0, proposed = 0;
    const counts = { update: 0, deadline: 0, correction: 0, new: 0 };
    const seen = new Set();

    for (const item of articles) {
      if (!item.url || seen.has(item.url)) continue;
      seen.add(item.url);
      considered++;
      const prop = classifyItem(syntheticSourceForArticle(item), item, index);
      if (!prop) continue;                       // safety: classifier returned nothing
      if (knownIds.has(prop.id)) continue;        // already proposed/acted on
      const dedupeKey = `${prop.matchedRecord ? prop.matchedRecord.title : ""}|${prop.detectedAction}|${prop.url}`;
      if (pendingKeys.has(dedupeKey)) continue;   // avoid re-proposing same record change
      existing.push(prop);
      newProps.push(prop);
      prop._newlyProposed = true;
      knownIds.add(prop.id);
      pendingKeys.add(dedupeKey);
      proposed++;
      counts[prop.detectedAction] = (counts[prop.detectedAction] || 0) + 1;
    }
    scanned = 1;

    // Enrich each new proposal with a real preview of the source article so the
    // review panel shows the actual text that would be added (and so the target
    // category can be refined from the full article text, not just the headline).
    // Bounded concurrency + short timeout keep the background scan responsive.
    //
    // SELF-HEALING: also re-enrich EXISTING pending proposals that still have no
    // preview. Previously a failed resolver fetch left a proposal stuck with
    // "No extractable summary" forever, because later scans skipped it. Now we
    // retry those on each scan (capped + cooldown-guarded) so previews fill in
    // over time as the resolver succeeds, instead of being permanently blank.
    const toEnrich = [...newProps];
    const newIds = new Set(newProps.map(p => p.id));
    // Retry budget per scan. Was 20, which let a single scan queue 20 model
    // calls — a large fraction of the 35-request free-tier day — and guaranteed
    // a burst that tripped the per-minute ceiling. Kept deliberately small;
    // unfinished proposals simply roll forward to the next scan.
    const RETRY_CAP = config.SCAN_RETRY_CAP;
    const RETRY_COOLDOWN_MS = 20 * 60 * 1000; // at most one retry / 20 min per proposal
    let retryAdded = 0;
    for (const prop of existing) {
      if (retryAdded >= RETRY_CAP) break;
      if (newIds.has(prop.id)) continue; // already covered by the newProps pass
      if (prop.status !== "pending") continue;
      // Skip only when FULLY enriched under the current schema (preview +
      // heuristic reason + >=80-char combined summary + jurisdiction). Items
      // written by the pre-rebuild code (no jurisdiction, or a short legacy
      // summary) are re-eligible so the quality-gated prompt upgrades them; a
      // proposal that got a heuristic category but no styledSummary is retried so
      // it can later receive the AI "Proposed Entry" summary once the model key
      // is available.
      if (!needsEnrichment(prop)) continue;
      // Skip proposals still inside a model rate-limit cooldown — re-calling the
      // model now would just 429 again and burn the daily token quota.
      if (prop.enrichCooldownUntil && Date.now() < new Date(prop.enrichCooldownUntil).getTime()) continue;
      if (prop.lastPreviewAttempt) {
        const since = Date.now() - new Date(prop.lastPreviewAttempt).getTime();
        if (since < RETRY_COOLDOWN_MS) continue;
      }
      toEnrich.push(prop);
      retryAdded++;
    }

    // Model calls spent by THIS scan run — the in-process ceiling that still
    // holds even when the persisted daily counter has been wiped by a restart.
    const runState = { callsThisRun: 0 };

    if (toEnrich.length) {
      // Per-proposal cooldown set when a scan call is rate-limited.
      //
      // This was 3 minutes, which caused a stampede: the engine's own cooldown
      // holds every call for an hour, so by the time it lapsed EVERY parked
      // proposal had been eligible again for ~57 minutes and they all fired at
      // once, instantly re-tripping the limit. A backoff longer than the engine
      // cooldown restores the stagger, so proposals come back a few at a time.
      const PER_PROPOSAL_BACKOFF_MS = config.SCAN_PROPOSAL_BACKOFF_MS;
      // Concurrency 1: enrichment is now strictly serial. Combined with the
      // paced gap between model calls this makes the per-minute ceiling
      // structurally unreachable.
      await mapWithConcurrency(toEnrich, 1, async (prop) => {
        const status = await enrichOneProposal(prop, runState);
        // Scan-discovery accounting: only newly-proposed items that the model
        // rejects (language or non-substantive) decrement the discovery counters.
        if (status === "rejected" && prop._newlyProposed) {
          proposed = Math.max(0, proposed - 1);
          counts[prop.detectedAction] = Math.max(0, (counts[prop.detectedAction] || 1) - 1);
        }
      });
    }

    // Drop any proposals the model rejected as non-substantive (Option B: job
    // postings, careers pages, event invites, etc). They were already added to
    // the `seen` set so they won't be re-scanned on the next pass.
    existing = existing.filter(p => !p.rejectedByModel && !p.rejectedByLanguage);

    proposedChanges.items = existing.slice(-300);
    sourceState.lastFullScan = new Date().toISOString();
    saveSourceState();
    saveProposed();

    return {
      scanned,
      considered,
      proposed,
      counts,
      // Request accounting — makes it obvious from the logs alone whether a scan
      // was throttled by the run cap, the daily budget, or a provider 429.
      modelCalls: runState.callsThisRun,
      dailyBudget: { used: scanBudget().used, limit: SCAN_DAILY_CALL_BUDGET },
      durationMs: Date.now() - startedAt,
    };
  } finally {
    sourceScanInFlight = false;
  }
}
// Status for the client: how many PROPOSED changes are waiting for review.
app.get("/api/regulatory-status", (req, res) => {
  const pending = (proposedChanges.items || []).filter(i => i.status === "pending");
  const counts = { update: 0, deadline: 0, correction: 0, new: 0 };
  pending.forEach(i => { counts[i.detectedAction] = (counts[i.detectedAction] || 0) + 1; });
  res.json({
    success: true,
    monitoring: true,
    scanning: sourceScanInFlight,
    scanStartedAt: sourceScanInFlight ? sourceScanStartedAt : null,
    lastScanAt: sourceState.lastFullScan,
    pendingCount: pending.length,
    counts,
    model: {
      enabled: isModelReady(),
      keyLoaded: !!process.env.OPEN_MODEL_API_KEY,
      name: DEFAULT_MODEL,
      baseUrl: (process.env.OPEN_MODEL_BASE_URL || "https://api.groq.com/openai/v1"),
    },
  });
});

// Liveness probe. Deliberately side-effect free: the keep-alive cron hits THIS
// endpoint, not /api/source-scan, so waking the container costs zero model
// requests. Scans are driven by the internal scheduler instead.
app.get("/healthz", (req, res) => {
  const stuckRateLimited = (proposedChanges.items || [])
    .filter(i => i.status === "pending" && i.enrichStatus === "rate-limited").length;
  const resolverSuccessRate = resolverStats.attempts > 0
    ? Math.round((resolverStats.ok / resolverStats.attempts) * 100)
    : null;
  res.json({
    ok: true,
    commit: DEPLOYED_COMMIT,
    newsSeedArticles: (bundledNewsCache?.articles || []).length,
    uptimeSeconds: Math.round(process.uptime()),
    lastScanAt: sourceState.lastFullScan || null,
    scanning: sourceScanInFlight,
    scanBudget: { used: scanBudget().used, limit: SCAN_DAILY_CALL_BUDGET, day: scanBudget().day },
    callBudget: { used: scanModelCallsThisRun, limit: SCAN_CALLS_PER_RUN_CAP },
    stuckRateLimitedProposals: stuckRateLimited,
    resolver: { attempts: resolverStats.attempts, ok: resolverStats.ok, successRatePct: resolverSuccessRate },
    // Signals whether the running process can see DEEPL_API_KEY. If false, the
    // zh-CN KB / news / Q&A paths serve English by design. This lets a live
    // probe confirm the key is actually present in the deployed environment
    // (Render env vars require a redeploy to take effect on the running
    // instance) without exposing the secret value.
    deeplConfigured: !!process.env.DEEPL_API_KEY,
    // Live signal (PR #95): did an ACTUAL tiny DeepL translation succeed? This
    // proves the key is valid + reachable, not merely present. null = probe not
    // yet run (first few seconds after boot); boolean once warm. The probe is
    // cached with a TTL so healthz never blocks on the network.
    deeplWorking: mtService.getDeeplStatus(),
    // The most recent DeepL failure reason (PR #96): when deeplWorking is false
    // this tells you WHY — e.g. "DeepL HTTP 456: Quota exceeded" (Free plan
    // exhausted), "DeepL HTTP 403: Forbidden" (wrong/expired key or wrong
    // endpoint), or a network error. null = no failure observed yet.
    deeplError: mtService.getLastDeeplError(),
    // Which search legs are configured, which one would answer next, and whether
    // any is circuit-broken. Makes a degraded search visible to a live probe
    // instead of only showing up as empty result sets.
    search: searchProvider.searchProviderStatus(),
    // EPO OPS (patents): whether the credentials are visible to the running
    // process, and whether the client is currently throttled or circuit-broken.
    // Makes a quota lockout diagnosable from a live probe instead of only
    // showing up as an empty Patents view. Never exposes the key itself.
    patents: epoClient.status(),
  });
});

// Read-only diagnostic probe. Admin-gated (same-origin + optional shared secret).
// Fetches an arbitrary public URL server-side and reports METADATA ONLY — HTTP
// status, content-type, byte length, RSS <item> count, and the final URL after
// redirects. It never returns the response body. It uses a raw fetch (NOT
// fetchTextResource) so a 403/404 is SURFACED as `status` rather than thrown,
// which is exactly what we need to answer "is Bing News RSS reachable from
// Render?" without guessing. Reuses validateSourceUrl + assertPublicHost for
// SSRF safety (rejects localhost/IP-literal/private/reserved hosts + DNS recheck).
app.get("/api/_diag/fetch", requireAdmin, async (req, res) => {
  try {
    try { assertSameOrigin(req); }
    catch { return res.status(403).json({ error: "Cross-origin requests are not allowed" }); }

    const url = String(req.query.url || "").trim();
    if (!url) return res.status(400).json({ error: "A `url` query parameter is required" });

    let validated, parsedHost;
    try {
      validated = validateSourceUrl(url);
      parsedHost = new URL(validated).hostname;
      await assertPublicHost(parsedHost);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let response;
    try {
      response = await fetch(validated, {
        headers: {
          "User-Agent": SCRAPE_USER_AGENT,
          Accept: "application/rss+xml,application/xml,text/xml,text/html;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      if (e.name === "AbortError") return res.status(504).json({ error: "Timed out", url: validated });
      return res.status(502).json({ error: "Fetch failed: " + e.message, url: validated });
    }

    // Re-validate the FINAL host after redirects (a 302 to a private IP must be blocked).
    let finalHostOk = true;
    try { await assertPublicHost(new URL(response.url).hostname); } catch { finalHostOk = false; }

    const body = await response.text().catch(() => "");
    clearTimeout(timeout);

    const contentType = response.headers.get("content-type") || "";
    const itemCount = (body.match(/<item[\s>]/gi) || []).length;

    res.json({
      ok: true,
      requested: validated,
      finalUrl: response.url,
      status: response.status,
      statusText: response.statusText,
      contentType,
      bytes: Buffer.byteLength(body, "utf8"),
      itemCount,
      redirected: response.redirected,
      finalHostOk,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trigger a crawl of the allowlist. The scan can now take a while (it fetches
// each proposed article to build a real preview), so we run it in the background
// and return immediately. The client polls /api/proposed-changes separately.
app.post("/api/source-scan", whenAuth(requireAdminRole), (req, res) => {
  const force = !!(req.body && req.body.force);
  const result = runSourceScan({ force });
  result
    .then(r => console.log("[source-scan] completed:", JSON.stringify(r)))
    .catch(err => console.warn("[source-scan] failed:", err.message));
  res.json({ success: true, started: true, scanning: sourceScanInFlight });
});

// Admin: immediately re-enrich stale (pre-#81) and rate-limited pending
// proposals without waiting for the next scheduled scan tick. Reuses the shared
// enrichOneProposal helper, so it applies the same quality-gated prompt and
// language gate as the background scan. Respects the per-run call cap, the daily
// budget, and per-proposal cooldowns unless force:true. Molly can use this after
// a deploy to upgrade frozen items and recover the "stuck rate-limited" queue.
app.post("/api/admin/proposed/reenrich", requireAdmin, async (req, res) => {
  const force = !!(req.body && req.body.force);
  const items = (proposedChanges.items || []).filter(i => i.status === "pending");
  const toRe = items.filter(p =>
    needsEnrichment(p) || p.enrichStatus === "rate-limited" || (force && p.fetchStatus === "blocked"));
  const runState = { callsThisRun: 0 };
  const counts = {
    selected: toRe.length, enriched: 0, rateLimited: 0,
    blocked: 0, rejected: 0, pending: 0, skipped: 0,
  };
  for (const prop of toRe) {
    if (!force && prop.enrichCooldownUntil && Date.now() < new Date(prop.enrichCooldownUntil).getTime()) {
      counts.skipped++;
      continue;
    }
    const status = await enrichOneProposal(prop, runState);
    if (counts[status] !== undefined) counts[status]++;
    else counts.skipped++;
  }
  saveProposed();
  res.json({
    success: true, ...counts,
    dailyBudget: { used: scanBudget().used, limit: SCAN_DAILY_CALL_BUDGET },
  });
});

// List pending proposed changes for the review panel.
//
// Only "presentable" items are returned: those with an AI-styled summary, OR
// those blocked behind a manual-review wall (bot-wall the resolver couldn't
// fetch). Rate-limited / quota placeholders — pending items with no summary —
// are hidden until a later scan enriches them, so the panel never shows blank
// "AI rewrite unavailable" cards. `enrichingCount` reports how many pending
// items are still in that pipeline (for a subtle "M enriching…" hint) without
// rendering them.
app.get("/api/proposed-changes", (req, res) => {
  const pending = (proposedChanges.items || []).filter(i => i.status === "pending");
  const isPresentable = (i) =>
    (i.styledSummary && i.styledSummary.length) || i.fetchStatus === "blocked";
  const presentable = pending.filter(isPresentable);
  const enrichingCount = pending.filter(
    (i) => !(i.styledSummary && i.styledSummary.length) && i.fetchStatus !== "blocked"
  ).length;
  presentable.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, pending: presentable, pendingCount: presentable.length, enrichingCount });
});

// Optional shared-secret auth for state-changing endpoints. DISABLED by default
// (ADMIN_API_KEY unset) so existing behaviour is preserved. When ADMIN_API_KEY
// is set, mutating endpoints require the `X-Admin-Key` header to match, which
// stops any visitor from rewriting curated datasets or burning the model budget.
function requireAdmin(req, res, next) {
  // Accounts v1: a valid admin session satisfies the gate too.
  if (auth.isAuthEnabled() && req.user && req.user.role === "admin") return next();
  const key = process.env.ADMIN_API_KEY;
  if (!key) return next();
  const provided = req.get("x-admin-key") || (req.body && req.body.adminKey);
  if (provided !== key) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Gate for the shared, editable datasets (Option B). Reuses ADMIN_API_KEY when
// EDITOR_API_KEY is absent, so a trusted team needs only one shared secret.
// FAILS CLOSED: with no key configured it refuses, never silently open.
function requireEditor(req, res, next) {
  // Accounts v1: a valid admin/user session satisfies the editor gate too.
  if (auth.isAuthEnabled() && req.user && (req.user.role === "admin" || req.user.role === "editor")) return next();
  const key = process.env.EDITOR_API_KEY || process.env.ADMIN_API_KEY;
  if (!key) return res.status(500).json({ error: "Editor auth not configured" });
  const provided =
    req.get("x-editor-key") || req.get("x-admin-key") ||
    (req.body && (req.body.editorKey || req.body.adminKey));
  if (provided !== key) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// Run a role-checking middleware ONLY when auth is enabled. When auth is
// disabled the app stays fully open (legacy behavior) — this wrapper is what
// keeps endpoint gating from accidentally locking the live app if AUTH_ENABLED
// is off. The global authGate already rejects unauthenticated callers when auth
// is on, so these only add a role requirement on top.
function whenAuth(mw) {
  return (req, res, next) => {
    if (!auth.isAuthEnabled()) return next();
    return mw(req, res, next);
  };
}

// Any authenticated user. Used for cost endpoints (LLM/search) so anonymous
// callers can't burn quota, while every logged-in viewer can still use Q&A.
function requireAuth(req, res, next) {
  return req.user ? next() : res.status(401).json({ error: "unauthorized" });
}

// Strict admin-role gate for destructive/expensive endpoints (e.g. source
// scan) so editors cannot trigger them. Accepts an admin session OR the
// ADMIN_API_KEY header; otherwise 403 (fails closed).
function requireAdminRole(req, res, next) {
  if (req.user && req.user.role === "admin") return next();
  const key = process.env.ADMIN_API_KEY;
  if (key && req.get("x-admin-key") === key) return next();
  return res.status(403).json({ error: "admin required" });
}

// KB translation-cache maintenance (PR #91). Admin-only.
app.post("/api/admin/purge-news-translations", requireAdmin, async (req, res) => {
  try {
    const purged = await kbTranslate.purgeStaleNewsTranslations();
    res.json({ success: true, purged });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.post("/api/admin/retranslate-kb", requireAdmin, async (req, res) => {
  try {
    const cleared = await kbTranslate.clearKbTranslations();
    // Re-translate every KB dataset and report per-dataset success so a broken
    // key is self-diagnosing (the response shows exactly which datasets failed
    // to produce Chinese). On success this also warms the cache.
    const report = await kbTranslate.retranslateAllKb("zh-CN");
    res.json({ success: true, cleared, ...report });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Direct, full-document edit of a shared dataset (Option B). The request body is
// the entire dataset JSON; it is upserted into Supabase with editor attribution.
// Disk JSON stays a fallback seed only, so we do NOT write it here.
app.put("/api/datasets/:name", requireEditor, async (req, res) => {
  const { name } = req.params;
  if (!DATASET_FILE[name]) return res.status(404).json({ error: "Unknown dataset" });
  if (typeof req.body !== "object" || req.body === null || Array.isArray(req.body))
    return res.status(400).json({ error: "Body must be a JSON object" });
  const pool = getDbPool();
  if (!pool) return res.status(500).json({ error: "Database not configured" });
  const editor = req.get("x-editor-name") || "unknown";
  try {
    await pool.query(
      `INSERT INTO datasets(name, data, updated_by, version)
       VALUES($1, $2::jsonb, $3, 1)
       ON CONFLICT (name) DO UPDATE
       SET data = EXCLUDED.data, updated_by = EXCLUDED.updated_by,
           updated_at = now(), version = datasets.version + 1`,
      [name, JSON.stringify(req.body), editor]
    );
    setDatasetCache(name, req.body);
    res.json({ success: true, name, updated_by: editor });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Thread D: shared, team-side ingestion (watch-URL + report-upload) ---
// POST /api/sources — add a watched URL (editor-gated; D1 = URL only, report
// upload lands in D2). Ingestion runs in the background; the row starts
// 'pending' and flips to 'ingested' (with a [T#] id) once fetched.
app.post("/api/sources", requireEditor, async (req, res) => {
  if (req.body?.kind !== "url") {
    return res.status(400).json({ error: "Only kind:'url' is supported in this release (report upload arrives in D2)" });
  }
  const url = typeof req.body.url === "string" ? req.body.url.trim() : "";
  if (!url) return res.status(400).json({ error: "A url is required" });
  const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
  const editor = req.get("x-editor-name") || "unknown";
  try {
    const source = await sources.addSourceUrl(url, title, editor);
    res.status(202).json({ success: true, source });
  } catch (e) {
    if (/Database not configured/.test(e.message)) return res.status(500).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// GET /api/sources — list (open read; shared reference data, no secrets).
app.get("/api/sources", async (req, res) => {
  try {
    const list = await sources.listSources();
    res.json({ success: true, sources: list });
  } catch (e) {
    if (/Database not configured/.test(e.message)) return res.status(500).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

// POST /api/sources/:id/refresh — re-ingest a source (editor-gated). Used by the
// UI refresh button now; the D3 watch-cron will call the same core later.
app.post("/api/sources/:id/refresh", requireEditor, async (req, res) => {
  try {
    const updated = await sources.refreshSource(req.params.id);
    res.json({ success: true, source: updated });
  } catch (e) {
    if (/Database not configured/.test(e.message)) return res.status(500).json({ error: e.message });
    if (/not found/i.test(e.message)) return res.status(404).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// DELETE /api/sources/:id — remove a source (editor-gated). Lets an editor clear
// failed/duplicate rows from the Team Sources list. Citable [T#] ids are not
// reused afterwards, so existing references in stored answers stay valid.
app.delete("/api/sources/:id", requireEditor, async (req, res) => {
  try {
    await sources.deleteSource(req.params.id);
    res.json({ success: true, id: req.params.id });
  } catch (e) {
    if (/Database not configured/.test(e.message)) return res.status(500).json({ error: e.message });
    res.status(400).json({ error: e.message });
  }
});

// Integrate an approved proposal into the curated dataset (user-gated write).
app.post("/api/proposed-changes/:id/integrate", requireAdmin, (req, res) => {
  try {
    const id = req.params.id;
    const prop = (proposedChanges.items || []).find(i => i.id === id);
    if (!prop) return res.status(404).json({ error: "Proposal not found" });
    const edit = (req.body && req.body.edit) ? String(req.body.edit) : (prop.suggestedEdit || prop.title);
    const target =
      (req.body && req.body.targetDataset) ||
      (prop.matchedRecord && prop.matchedRecord.dataset) ||
      (prop.category === "use-case" ? "use-cases" : prop.category === "academic" ? "knowledge" : "timeline");
    const targetCategoryKey = req.body && req.body.targetCategoryKey;
    if (targetCategoryKey && !Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, targetCategoryKey)) {
      return res.status(400).json({ error: "Invalid targetCategoryKey" });
    }
    integrateProposal(prop, edit, target, targetCategoryKey);
    prop.status = "integrated";
    (proposedChanges.integratedIds = proposedChanges.integratedIds || []).push(id);
    saveProposed();
    res.json({ success: true, target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss a proposal so it stops showing and isn't re-proposed.
app.post("/api/proposed-changes/:id/dismiss", requireAdmin, (req, res) => {
  const id = req.params.id;
  const prop = (proposedChanges.items || []).find(i => i.id === id);
  if (!prop) return res.status(404).json({ error: "Proposal not found" });
  prop.status = "dismissed";
  (proposedChanges.dismissedIds = proposedChanges.dismissedIds || []).push(id);
  saveProposed();
  res.json({ success: true });
});

// Server-side scheduler: scan sources whose TTL has elapsed. The single-flight
// lock prevents overlapping scans.
//
// Cadence is deliberately conservative. The theoretical ceiling on model calls
// is (minutes_per_day / tick_minutes) x calls_per_scan, so a 5-minute tick was
// budgeting for thousands of calls a day against the 35/day free-tier allowance.
// At 60 minutes, with the per-run cap, the scan lane cannot outrun its quota.
const SOURCE_SCAN_TICK_MS = config.SOURCE_SCAN_TICK_MS;
// The block below is a module-load side effect: it must NOT run when this file
// is required by a test harness. `require.main === module` is true only when the
// file is executed directly (e.g. `node server.js`).
if (require.main === module) {
  setInterval(() => {
    runSourceScan({ force: false }).catch(() => {});
    try { runRetentionSweep(); } catch (_) { /* non-fatal */ }
  }, SOURCE_SCAN_TICK_MS);
}

// News-refresh cron (Thread B): keep the default news selection fresh on a fixed
// clock even with zero visitors, so the feed feels live without anyone hitting
// the endpoint. The refresh is a keyless Google/Bing RSS fan-out (no AI tokens)
// and reuses the coalesced, single-flight triggerNewsBackgroundRefresh, which
// also broadcasts to any open SSE subscribers. Cadence is env-tunable so it can
// be throttled on a tight budget.
const NEWS_CRON_MS = config.NEWS_CRON_MS;
if (require.main === module) {
  setInterval(() => {
    const competitors = resolveNewsCompetitors();
    triggerNewsBackgroundRefresh(newsSelectionKey(competitors), competitors);
  }, NEWS_CRON_MS);
}

// Boot scan, guarded. Render's free tier spins the container down when idle, so
// every wake-up is a fresh process — an unguarded boot scan meant one scan per
// wake, no matter what the tick interval said. The guard consults the PERSISTED
// last-scan timestamp so a restart shortly after a scan doesn't repeat it.
const BOOT_SCAN_MIN_GAP_MS = config.BOOT_SCAN_MIN_GAP_MS;
if (require.main === module) {
  setTimeout(() => {
  const last = sourceState.lastFullScan ? new Date(sourceState.lastFullScan).getTime() : 0;
  const since = Date.now() - last;
  if (last && since < BOOT_SCAN_MIN_GAP_MS) {
    console.log(`[source-scan] boot scan skipped — last scan ${Math.round(since / 60000)}m ago (min gap ${Math.round(BOOT_SCAN_MIN_GAP_MS / 60000)}m)`);
    return;
  }
  runSourceScan({ force: false }).catch(() => {});
  try { runRetentionSweep(); } catch (_) { /* non-fatal */ }
  }, 30000);
}

// GET /api/status
app.get("/api/status", (req, res) => {
  res.json({
    mode: "Tavily web search (API key required)",
    searchProvider: "Tavily",
    scrapeProvider: "Readable web text + public video captions",
  });
});

// GET /api/knowledge — serve the structured knowledge base
app.get("/api/knowledge", async (req, res) => {
  try {
    const { category, search } = req.query;

    const knowledgeCache = await kbTranslate.getDatasetTranslated("knowledge", req.query.lang);
    if (!knowledgeCache) return res.status(500).json({ error: "Failed to load knowledge dataset" });

    // Curated base only — live/auto-sourced items are NOT injected here; they
    // surface via the proposed-changes review queue instead.
    const categories = {};
    for (const [key, cat] of Object.entries(knowledgeCache.categories)) {
      categories[key] = { ...cat, subsections: [...(cat.subsections || [])] };
    }

    let result;
    if (category && categories[category]) {
      result = {
        sourceDocuments: knowledgeCache.sourceDocuments,
        categories: { [category]: categories[category] },
      };
    } else {
      result = { sourceDocuments: knowledgeCache.sourceDocuments, categories };
    }

    if (search) {
      const query = search.toLowerCase();
      const filtered = {};
      for (const [key, cat] of Object.entries(result.categories)) {
        const matchingSubsections = cat.subsections.filter(
          (s) =>
            s.title.toLowerCase().includes(query) ||
            s.content.toLowerCase().includes(query)
        );
        if (matchingSubsections.length > 0) {
          filtered[key] = { ...cat, subsections: matchingSubsections };
        }
      }
      result = {
        sourceDocuments: knowledgeCache.sourceDocuments,
        categories: filtered,
      };
    }

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/network — serve competitor network data
app.get("/api/network", async (req, res) => {
  try {
    const networkCache = await kbTranslate.getDatasetTranslated("network", req.query.lang);
    if (!networkCache) return res.status(500).json({ error: "Failed to load network dataset" });
    res.json({ success: true, data: networkCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tencent-products — Tencent's AI/gaming product portfolio
app.get("/api/tencent-products", async (req, res) => {
  try {
    const tencentProductsCache = await kbTranslate.getDatasetTranslated("tencent-products", req.query.lang);
    if (!tencentProductsCache) return res.status(500).json({ error: "Failed to load tencent-products dataset" });
    res.json({ success: true, data: tencentProductsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/current-use-cases — consolidated game-by-game AI implementations
app.get("/api/current-use-cases", async (req, res) => {
  try {
    const currentUseCasesCache = await kbTranslate.getDatasetTranslated("current-use-cases", req.query.lang);
    if (!currentUseCasesCache) return res.status(500).json({ error: "Failed to load current-use-cases dataset" });
    // Curated base only — live/auto-sourced items surface via the review queue.
    const data = {
      ...currentUseCasesCache,
      patterns: [...(currentUseCasesCache.patterns || [])],
    };
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gaming-trends — AI gaming trends (9 LLM use cases expanded)
app.get("/api/gaming-trends", async (req, res) => {
  try {
    const gamingTrendsCache = await kbTranslate.getDatasetTranslated("gaming-trends", req.query.lang);
    if (!gamingTrendsCache) return res.status(500).json({ error: "Failed to load gaming-trends dataset" });
    res.json({ success: true, data: gamingTrendsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gaming-trends/search — live web search for a trend, via the chain
app.post("/api/gaming-trends/search", whenAuth(requireAuth), async (req, res) => {
  try {
    const { keywords, limit = 5 } = req.body;
    if (!keywords) return res.status(400).json({ error: "Search keywords required" });

    const { results, provider } = await searchProvider.searchWeb(keywords, { limit });
    res.json({ success: true, data: results, keywords, provider });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/regulatory-timeline — EU & UK AI regulatory deadlines
app.get("/api/regulatory-timeline", async (req, res) => {
  try {
    const regulatoryTimelineCache = await kbTranslate.getDatasetTranslated("regulatory-timeline", req.query.lang);
    if (!regulatoryTimelineCache) return res.status(500).json({ error: "Failed to load regulatory-timeline dataset" });
    // Curated base only — live/auto-sourced items surface via the review queue.
    const data = {
      ...regulatoryTimelineCache,
      events: [...(regulatoryTimelineCache.events || [])],
    };
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/risks — cross-referenced risk analysis
app.get("/api/risks", async (req, res) => {
  try {
    const risksCache = await kbTranslate.getDatasetTranslated("risks", req.query.lang);
    if (!risksCache) return res.status(500).json({ error: "Failed to load risks dataset" });
    res.json({ success: true, data: risksCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/company-locations — UK & EU company and regulator locations
app.get("/api/company-locations", async (req, res) => {
  try {
    const companyLocationsCache = await kbTranslate.getDatasetTranslated("company-locations", req.query.lang);
    if (!companyLocationsCache) return res.status(500).json({ error: "Failed to load company-locations dataset" });
    res.json({ success: true, data: companyLocationsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================================
// Patents — EPO OPS (live, compliant patent data)
// -----------------------------------------------------------------------------
// Two rules govern this whole block (docs/patents-epo-ops-scope.md):
//   1. QUOTA. OPS enforces a Fair Use allowance per hour AND per week. Every
//      query is cached durably in Postgres first, so a repeated search costs
//      zero quota and survives Render's cold starts.
//   2. ATTRIBUTION. Results must credit the EPO and deep-link to Espacenet
//      (EPO's own viewer) — never Google Patents, which blocks iframing.
// =============================================================================

// Self-healing, same convention as proposed_changes / allowed_emails: the table
// is created on first DB contact so no manual migration step is needed.
let _patentsCacheEnsured = false;
async function ensurePatentsCacheTable(pool) {
  if (_patentsCacheEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patents_cache (
      cache_key   TEXT PRIMARY KEY,
      query       JSONB NOT NULL DEFAULT '{}'::jsonb,
      payload     JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  _patentsCacheEnsured = true;
}

// Returns the cached payload, or null on a miss / expiry / ANY DB error. The
// feature must degrade to a live OPS call — never fail because the cache did.
async function readPatentCache(key) {
  const pool = getDbPool();
  if (!pool) return null;
  try {
    await ensurePatentsCacheTable(pool);
    const { rows } = await pool.query(
      `SELECT payload, updated_at FROM patents_cache WHERE cache_key = $1`,
      [key]
    );
    const row = rows && rows[0];
    if (!row || !row.payload) return null;
    const age = Date.now() - new Date(row.updated_at).getTime();
    if (Number.isFinite(age) && age > config.PATENT_CACHE_TTL_MS) return null;
    return typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
  } catch (e) {
    console.warn("[patents] cache read failed; going live:", e.message);
    return null;
  }
}

// Cache hygiene. Bumping the key prefix in buildCacheKey already makes stale
// entries unreachable, but they would sit in the table until the TTL expired —
// and after a query-construction fix those rows are actively misleading to
// anyone reading the table. Safe to delete: this is a cache, so a miss just
// costs one OPS call.
async function purgeStalePatentCache(pool, { maxAgeDays = 7 } = {}) {
  await ensurePatentsCacheTable(pool);
  // Drop anything written by an older key format (pre-`v2~`). Count rows live
  // in the same table under a `cpccount:` prefix and are deliberately kept —
  // they are still current and were expensive to produce.
  const stale = await pool.query(
    `DELETE FROM patents_cache WHERE cache_key NOT LIKE 'v2~%' AND cache_key NOT LIKE 'cpccount:%'`
  );
  // Drop counts written under an older query format (e.g. the zeros produced by
  // the malformed CPC codes in #111). Safe: they are cache rows, and a miss just
  // costs one OPS call.
  const staleCounts = await pool.query(
    `DELETE FROM patents_cache WHERE cache_key LIKE 'cpccount:%' AND cache_key NOT LIKE $1`,
    [`cpccount:${CPC_COUNT_VERSION}:%`]
  );
  // Then the general TTL sweep, so the table cannot grow without bound.
  const aged = await pool.query(
    `DELETE FROM patents_cache WHERE updated_at < now() - ($1 || ' days')::interval`,
    [String(maxAgeDays)]
  );
  return (stale.rowCount || 0) + (staleCounts.rowCount || 0) + (aged.rowCount || 0);
}

async function writePatentCache(key, query, payload) {
  const pool = getDbPool();
  if (!pool) return;
  try {
    await ensurePatentsCacheTable(pool);
    await pool.query(
      `INSERT INTO patents_cache (cache_key, query, payload, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, now())
       ON CONFLICT (cache_key) DO UPDATE
       SET query = EXCLUDED.query, payload = EXCLUDED.payload, updated_at = now()`,
      [key, JSON.stringify(query), JSON.stringify(payload)]
    );
  } catch (e) {
    // Non-fatal: a cache write failure must never fail the user's request.
    console.warn("[patents] cache write failed (non-fatal):", e.message);
  }
}

// The companies we track as potential patent applicants.
//
// Source is `network.json` (the Competitor Web), NOT `company-locations.json`,
// and that choice is deliberate. company-locations is a MAP of office and
// regulator sites, so it lists studio locations ("Ubisoft Montreal / La Forge",
// "Rockstar North") and bodies that will never file a patent (European
// Commission, UK AI Safety Institute, UK ICO, EDPB). network.json is the set of
// actual companies we track — the right population for a patent search.
// It is still data, not code: edit data/network.json to change the list.
function trackedCompanies() {
  const net = getDataset("network");
  if (!net) return [];
  const rows = [];
  const push = (c) => { if (c && c.id && c.name) rows.push(c); };
  push(net.center);
  for (const c of Array.isArray(net.competitors) ? net.competitors : []) push(c);
  return rows;
}

// Cross-reference one patent against the tracked companies. A company matches
// when ANY of its distinctive tokens appears in an applicant or inventor name,
// so an OPS applicant of "DeepMind Limited" still resolves to Google DeepMind.
// Substring (not equality) is deliberate — OPS name strings are noisy.
function matchPatentCompanies(patent, companies) {
  const haystacks = [...(patent.applicants || []), ...(patent.inventors || [])]
    .map(s => String(s || "").toLowerCase())
    .filter(Boolean);
  if (!haystacks.length) return [];
  const ids = [];
  for (const c of companies) {
    // Match on every alias the name contains, so "Take-Two / Rockstar Games"
    // resolves against an applicant of "ROCKSTAR GAMES, INC."
    const aliases = applicantAliases(c && c.name);
    if (!aliases.length) continue;
    const hit = aliases.some(a => {
      const toks = companyTokens(a);
      return toks.length ? toks.some(t => haystacks.some(h => h.includes(t)))
                         : haystacks.some(h => h.includes(a.toLowerCase()));
    });
    if (hit) ids.push(c.id);
  }
  return [...new Set(ids)];
}

// GET /api/patents/company-options — the filter vocabulary for the Patents view.
// Deliberately UNGATED (unlike /api/patents): it only exposes the same public KB
// data already served elsewhere, and gating it would break the dropdown.
//
// Each company carries BOTH names, and the distinction is load-bearing:
//   `name`      — for DISPLAY, translated into the active language.
//   `queryName` — the canonical ENGLISH name, which is what must be sent to OPS.
// The KB translation cache rewrites company names into Chinese, so sending the
// display name would build a CQL query out of Chinese text and match nothing.
app.get("/api/patents/company-options", async (req, res) => {
  try {
    const canonical = trackedCompanies();
    let displayNames = new Map();
    const translated = await kbTranslate.getDatasetTranslated("network", req.query.lang);
    const source = translated || getDataset("network") || {};
    const collect = (c) => { if (c && c.id && c.name) displayNames.set(c.id, c.name); };
    collect(source.center);
    for (const c of Array.isArray(source.competitors) ? source.competitors : []) collect(c);

    const companies = canonical
      .map(c => ({
        id: c.id,
        name: displayNames.get(c.id) || c.name,   // display (translated if available)
        queryName: c.name,                        // canonical English -> builds the CQL
        sectors: c.sectors || [],
      }))
      .filter(c => c.id && c.name)
      .sort((a, b) => String(a.name).localeCompare(String(b.name)));

    res.json({
      success: true,
      companies,
      // Grouped chips rather than a flat list: the old A63F/G06N/G06T/G10L/H04N
      // set was far too broad (A63F covers playing cards, chess, roulette and
      // pinball). Each chip maps to one or more verified CPC codes.
      cpcGroups: CPC_GROUPS.map(g => ({
        id: g.id,
        label: g.label,
        chips: g.chips.map(c => ({ id: c.id, label: c.label, codes: c.codes, hint: c.hint || "" })),
      })),
      cpcDefaults: CPC_DEFAULT_CODES,
      configured: epoClient.isConfigured(),
      attribution: "Data: EPO OPS",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/patents — live EPO OPS patent search (cache-first).
// Query: company, keyword, cpc (comma-separated), from/to (YYYYMMDD),
//        range (1-25), sort (date|relevance), abstracts (0 to skip).
app.get("/api/patents", whenAuth(requireAuth), async (req, res) => {
  try {
    if (!epoClient.isConfigured()) {
      return res.status(503).json({
        success: false,
        code: "epo_not_configured",
        error: "EPO OPS not configured — set EPO_OPS_KEY and EPO_OPS_SECRET to enable live patent search.",
      });
    }

    const query = {
      company: String(req.query.company || "").trim(),
      keyword: String(req.query.keyword || "").trim(),
      cpc: String(req.query.cpc || "").split(",").map(s => s.trim()).filter(Boolean),
      from: String(req.query.from || "").trim(),
      to: String(req.query.to || "").trim(),
      range: req.query.range,
      sort: String(req.query.sort || "date").trim(),
      abstracts: req.query.abstracts !== "0",
    };
    if (!query.company && !query.keyword && !query.cpc.length) {
      return res.status(400).json({
        success: false,
        code: "empty_query",
        error: "Provide a company, keyword or CPC filter.",
      });
    }

    // Cache FIRST — this is the quota guard, not just a latency win.
    const cacheKey = buildCacheKey(query);
    const cached = await readPatentCache(cacheKey);
    if (cached) return res.json({ ...cached, cached: true });

    const { patents, totalAvailable, diagnostics, cql } = await epoClient.search(query, { limit: query.range });

    // A parse failure must NEVER look like "no patents found". If OPS reported
    // hits but we could not turn them into cards, that is our bug — surface it
    // as a 502 with the raw counts instead of an empty 200 the user would read
    // as "this company has no patents".
    if (diagnostics && diagnostics.totalResultCount > 0 && patents.length === 0) {
      return res.status(502).json({
        success: false,
        code: "epo_parse_failed",
        error: `EPO OPS reported ${diagnostics.totalResultCount} matching publications but none could be parsed.`,
        cql,
        diagnostics,
      });
    }

    // Abstracts are a separate OPS call per hit, so they are opt-out and capped
    // inside the client (MAX_ABSTRACT_LOOKUPS).
    if (query.abstracts) await epoClient.enrichWithAbstracts(patents);
    // OPS exposes no dependable sort parameter, so "newest first" is applied
    // here rather than being pushed down into the query.
    if (query.sort === "date") {
      patents.sort((a, b) => String(b.publicationDate || "").localeCompare(String(a.publicationDate || "")));
    }

    // Cross-ref against the ENGLISH KB names (not the translated ones) so
    // matching stays stable whichever language the UI is in.
    const withMatches = patents.map(p => ({ ...p, matchedCompanies: matchPatentCompanies(p, trackedCompanies()) }));

    const payload = {
      success: true,
      query,
      cql,
      count: withMatches.length,
      totalAvailable,
      patents: withMatches,
      cached: false,
      fetchedAt: new Date().toISOString(),
      attribution: "Data: EPO OPS",
      // Exposed so an empty result is explainable on screen: is it a genuinely
      // empty search (totalResultCount 0) or did we fail to read OPS's answer?
      diagnostics,
    };
    await writePatentCache(cacheKey, query, payload);
    res.json(payload);
  } catch (err) {
    const code = (err && err.code) || "epo_error";
    const status =
      code === "epo_not_configured" ? 503 :
      code === "epo_throttled" ? 429 :
      code === "epo_circuit_open" ? 503 :
      /required|Provide a/i.test(String((err && err.message) || "")) ? 400 : 502;
    res.status(status).json({ success: false, code, error: (err && err.message) || "EPO OPS request failed" });
  }
});

// =============================================================================
// Patents — classification verification + per-chip hit counts
// -----------------------------------------------------------------------------
// These exist because the group-level CPC codes above are only useful if OPS
// searches them HIERARCHICALLY — i.e. that `A63F13/00` also returns documents
// classified A63F13/67. We proved that works at subclass level but never at
// group level, and if it does not, every chip silently returns zero. That is
// exactly the failure mode that cost two deploy cycles in #109/#110, so these
// probes make the assumption checkable instead of assumed.
// Both are quota-sensitive: one OPS call per item, cached, and aborted the
// moment OPS throttles or the breaker opens. Partial results are returned
// rather than an error, so the UI degrades instead of breaking.
// =============================================================================

// Bump this whenever the way a count QUERY is built changes. Counts are cached
// for hours, so a fix to code formatting would otherwise keep serving stale
// numbers — which is exactly what happened: every chip cached a `0` produced by
// the malformed un-spaced CPC form, and kept replaying it.
const CPC_COUNT_VERSION = "c2";

// Namespaced so a count can never collide with (or be served as) a real search.
function countCacheKey(kind, id, codes) {
  return `cpccount:${CPC_COUNT_VERSION}:${kind}:${id}:${buildCacheKey({ cpc: codes, range: 1, sort: "relevance", abstracts: false })}`;
}

async function cpcCountsFor(items, kind) {
  const counts = {};
  let throttled = false;
  for (const item of items) {
    // Bail the instant OPS pushes back — finishing the loop would burn the
    // remaining hourly quota for numbers that are nice-to-have at best.
    const st = epoClient.status();
    if (st.throttled || st.circuitOpen) { throttled = true; break; }

    const codes = item.codes || [item.code];
    const id = item.id || item.code;
    const key = countCacheKey(kind, id, codes);
    try {
      const cached = await readPatentCache(key);
      if (cached && typeof cached.count === "number") {
        counts[id] = cached.count;
        continue;
      }
      const res = await epoClient.search({ cpc: codes }, { limit: 1 });
      counts[id] = res.totalAvailable || 0;
      await writePatentCache(key, { kind, id, codes }, { count: counts[id] });
    } catch (err) {
      const code = err && err.code;
      if (code === "epo_throttled" || code === "epo_circuit_open") { throttled = true; break; }
      // One bad code must not sink the whole probe.
      counts[id] = null;
    }
  }
  return { counts, throttled };
}

// GET /api/patents/cpc-counts — matching publications per chip, for the UI.
app.get("/api/patents/cpc-counts", whenAuth(requireAuth), async (req, res) => {
  try {
    if (!epoClient.isConfigured()) {
      return res.status(503).json({ success: false, code: "epo_not_configured", error: "EPO OPS not configured." });
    }
    const { counts, throttled } = await cpcCountsFor(CPC_CHIPS, "chip");
    res.json({ success: true, counts, throttled, attribution: "Data: EPO OPS" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/patents/validate-cpc — per-CODE counts. Admin-only: this is a
// one-off verification tool, not a UI data source, and it costs one OPS call
// per code. Run it after any change to the chip definitions; any code
// reporting 0 is either wrong or not searched hierarchically.
app.get("/api/patents/validate-cpc", whenAuth(requireAdminRole), async (req, res) => {
  try {
    if (!epoClient.isConfigured()) {
      return res.status(503).json({ success: false, code: "epo_not_configured", error: "EPO OPS not configured." });
    }
    // `?codes=A63F13/00,G06N3/092` tests a chosen subset. Important under a
    // small search allowance: validating all codes costs one call each, far
    // more than OPS allows in a window, so checking two or three at a time is
    // the only practical way to confirm the format works.
    const wanted = String(req.query.codes || "")
      .split(",")
      .map(isCpcCode)
      .filter(Boolean);
    if (req.query.codes && !wanted.length) {
      return res.status(400).json({ success: false, code: "bad_codes", error: "No valid CPC codes supplied." });
    }
    const items = (wanted.length ? wanted : CPC_ALL_CODES.map(isCpcCode)).map(code => ({ code }));
    const { counts, throttled } = await cpcCountsFor(items, "code");
    const dead = Object.entries(counts).filter(([, n]) => n === 0).map(([c]) => c);
    res.json({
      success: true,
      counts,
      // Show what each code became after formatting — the spaced `/low` form is
      // what OPS actually receives, and seeing it makes format bugs obvious.
      asSent: Object.fromEntries(items.map(i => [i.code, buildCql({ cpc: [i.code] })])),
      throttled,
      total: Object.keys(counts).length,
      emptyCodes: dead,   // investigate these before trusting the chips
      attribution: "Data: EPO OPS",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/patents/probe-cpc-format — determine empirically which CPC spelling
// OPS accepts, instead of guessing and taking the tab down again.
//
// History, because it explains why this exists: `A63F13/00` (concatenated)
// returned 0 results everywhere; `A63F 13/67/low` (the form the EPO's Espacenet
// notes recommend for subgroups) returned HTTP 500 SERVER.DomainAccess. Both
// were wrong in different ways, and each cost a deploy to discover.
//
// This runs one search per candidate spelling and reports status + hit count,
// so the correct form is measured rather than inferred. Admin-only: it spends
// OPS searches (~2-3 per call).
app.get("/api/patents/probe-cpc-format", whenAuth(requireAdminRole), async (req, res) => {
  try {
    if (!epoClient.isConfigured()) {
      return res.status(503).json({ success: false, code: "epo_not_configured", error: "EPO OPS not configured." });
    }
    const raw = normaliseCpc(req.query.code || "A63F13/00").replace(/\/LOW$/, "");
    if (!CPC_CODE_RE.test(raw)) {
      return res.status(400).json({ success: false, code: "bad_code", error: "Provide a CPC code, e.g. A63F13/00" });
    }
    const spaced = raw.replace(/^([A-HY]\d{2}[A-Z])(\d+)/, "$1 $2");
    const isSubgroup = /\//.test(raw) && !/\/(0+)$/.test(raw);

    const candidates = [
      ["concatenated", raw],
      ["spaced", spaced],
    ];
    // /low is offered only for comparison — it is not used in production.
    if (req.query.includeLow === "1") candidates.push([`spaced + /low${isSubgroup ? "" : " (main group)"}`, `${spaced}/low`]);

    const results = {};
    for (const [name, code] of candidates) {
      const cql = `cpc = "${code}"`;
      try {
        const r = await epoClient.searchCql(cql, { limit: 1 });
        results[name] = { cql, ok: true, count: r.totalAvailable };
      } catch (e) {
        results[name] = { cql, ok: false, code: e.code || null, error: String(e.message || e).slice(0, 180) };
      }
    }
    res.json({
      success: true,
      input: req.query.code || "A63F13/00",
      isSubgroup,
      results,
      // What the app sends today, for comparison against the candidates.
      current: `cpc = "${isCpcCode(raw)}"`,
      attribution: "Data: EPO OPS",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// =============================================================================
// Patents — headline translation
// -----------------------------------------------------------------------------
// Patent titles arrive in whatever language the filing office used. The UI
// shows them verbatim, which is correct, but a Chinese or French headline is
// unreadable to most users — so offer a small opt-in translation of the TITLE
// ONLY (translating abstracts too would ~5x the DeepL cost for little gain).
// =============================================================================
const MAX_TRANSLATE_CHARS = 400;   // abuse/cost guard: patent titles are short
const TRANSLATABLE_LANGS = ["en", "zh-CN"];
const PN_RE = /^[A-Z]{2}[0-9A-Z]{1,20}$/;

let _patentTransEnsured = false;
async function ensurePatentTranslationsTable(pool) {
  if (_patentTransEnsured) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS patent_translations (
      pn            TEXT NOT NULL,
      lang          TEXT NOT NULL,
      content_hash  TEXT NOT NULL,
      title_source  TEXT NOT NULL,
      title_target  TEXT NOT NULL,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (pn, lang)
    );
  `);
  _patentTransEnsured = true;
}

async function readPatentTranslation(pn, lang, hash) {
  const pool = getDbPool();
  if (!pool) return null;
  try {
    await ensurePatentTranslationsTable(pool);
    const { rows } = await pool.query(
      `SELECT title_source, title_target FROM patent_translations WHERE pn=$1 AND lang=$2 AND content_hash=$3`,
      [pn, lang, hash]
    );
    const row = rows && rows[0];
    return row ? row.title_target : null;
  } catch (e) {
    console.warn("[patents] translation read failed (non-fatal):", e.message);
    return null;
  }
}

async function writePatentTranslation(pn, lang, hash, source, target) {
  const pool = getDbPool();
  if (!pool) return;
  try {
    await ensurePatentTranslationsTable(pool);
    await pool.query(
      `INSERT INTO patent_translations (pn, lang, content_hash, title_source, title_target, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (pn, lang) DO UPDATE
       SET content_hash=EXCLUDED.content_hash, title_source=EXCLUDED.title_source,
           title_target=EXCLUDED.title_target, updated_at=now()`,
      [pn, lang, hash, source, target]
    );
  } catch (e) {
    console.warn("[patents] translation write failed (non-fatal):", e.message);
  }
}

// POST /api/patents/translate — translate one patent headline.
// Body: { pn, title, target }  (target: "en" | "zh-CN")
// Auth-gated like /api/patents. Cached by (pn, lang, title hash) so a headline
// is never paid for twice.
app.post("/api/patents/translate", whenAuth(requireAuth), async (req, res) => {
  try {
    const body = req.body || {};
    const pn = String(body.pn || "").trim().toUpperCase();
    const title = String(body.title || "").trim();
    const targetRaw = String(body.target || "").trim().toLowerCase();
    const target = targetRaw === "zh" ? "zh-CN" : targetRaw;

    if (!PN_RE.test(pn)) {
      return res.status(400).json({ success: false, code: "bad_pn", error: "A valid publication number is required." });
    }
    if (!title || title.length > MAX_TRANSLATE_CHARS) {
      return res.status(400).json({
        success: false, code: "bad_title",
        error: `Title must be 1-${MAX_TRANSLATE_CHARS} characters.`,
      });
    }
    if (!TRANSLATABLE_LANGS.includes(target)) {
      return res.status(400).json({ success: false, code: "bad_target", error: 'target must be "en" or "zh-CN".' });
    }

    const hash = crypto.createHash("sha1").update(title).digest("hex").slice(0, 16);
    const cached = await readPatentTranslation(pn, target, hash);
    if (cached) {
      return res.json({ success: true, pn, target, translated: cached, source: title, cached: true });
    }

    // mtService walks DeepL -> Google and applies chip-fidelity verification
    // (it rejects a translation that mangles embedded codes, which matters for
    // titles containing publication numbers or chemical/formula tokens).
    // No source language: patent titles can be in any language, so let the
    // provider auto-detect rather than guessing.
    const translated = await mtService.translateText(title, { target, source: "" });
    if (!translated || translated === title) {
      return res.status(502).json({
        success: false, code: "translation_unavailable",
        error: "No translation provider returned a result. Check the DeepL key.",
      });
    }
    await writePatentTranslation(pn, target, hash, title, translated);
    res.json({ success: true, pn, target, translated, source: title, cached: false });
  } catch (err) {
    res.status(500).json({ success: false, code: "translate_failed", error: err.message });
  }
});

const PORT = config.PORT;
// Only bind a port when executed directly. Guarded so a test harness can
// `require("./server")` (registering routes on `app`) without opening a socket.
if (require.main === module) {
  // Bind the port FIRST so the app is always reachable. The Supabase cache
  // preload runs in the background and falls back to on-disk JSON if the DB is
  // unreachable — a stalled DB connection must never block server startup.
  app.listen(PORT, () => {
    console.log(`\n  Insights Tool`);
    console.log(`  Server running at http://localhost:${PORT}`);
    console.log(`  Python: ${PYTHON ? `${PYTHON} — video transcripts enabled` : "NOT FOUND — video transcripts disabled"}`);
    console.log(`  Search: Tavily web search (requires TAVILY_API_KEY)\n`);
    // When DATABASE_URL is set, shared datasets are served from Supabase once
    // the background preload completes; until then the on-disk JSON is used.
  });

  const pool = getDbPool();
  if (pool) {
    attachDb(pool);
    // Accounts v1: hand the app's pg pool to the auth module so it can read the
    // optional allowed_emails table, and make sure that table exists.
    auth.__setPool(pool);
    ensureAllowedEmailsTable(pool)
      .then(() => console.log("  allowed_emails table ready (Supabase-managed allow-list)."))
      .catch((e) => console.warn("[auth] allowed_emails table ensure failed:", e.message));
    primeDatasetCacheFromDb()
      .then(() => console.log("  Datasets cache preloaded from database."))
      .catch((e) => console.warn("[datasets] DB preload failed; using disk fallback:", e.message));
    // Suggested-Updates durable store (Leg 2): load from Supabase so enrichment
    // progress survives cold starts. Degrades to disk/in-memory on any error.
    primeProposedFromDb()
      .then(() => {})
      .catch((e) => console.warn("[proposed] DB preload failed; using disk fallback:", e.message));
    // KB translation cache (PR #91): create tables if absent. Degrades to
    // English fallback on any error.
    kbTranslate.ensureKbTranslationsTable()
      .then(() => {})
      .catch((e) => console.warn("[kbTranslate] table ensure failed; using English fallback:", e.message));
    // Patents (EPO OPS): create the durable query cache if absent. Harmless when
    // the OPS credentials aren't set — the table just stays empty.
    ensurePatentsCacheTable(pool)
      .then(() => purgeStalePatentCache(pool))
      .then((n) => { if (n) console.log(`  patents_cache purged ${n} stale row(s).`); })
      .catch((e) => console.warn("[patents] cache table ensure failed (queries will not be cached):", e.message));
    // Patent headline translations (reuses the DeepL key already configured).
    ensurePatentTranslationsTable(pool)
      .then(() => {})
      .catch((e) => console.warn("[patents] translations table ensure failed:", e.message));
    // DeepL liveness probe (PR #95): warm the cached status shortly after boot
    // so /healthz reports deeplWorking without waiting for the first ping.
    mtService.ensureDeeplStatus()
      .then(() => {})
      .catch((e) => console.warn("[deepl] liveness probe failed:", e.message));
  }
}

// =============================================================================
// Test/integration exports
// -----------------------------------------------------------------------------
// Everything above is the production HTTP server. The block below is exported so
// a test harness (node:test, Phase E) can unit-test the pure logic without
// booting the server (see the `require.main === module` guards above). `app`
// lets integration tests hit routes via supertest; the rest are pure functions.
// =============================================================================
module.exports = {
  app,
  config,

  // Pure classification / matching helpers
  isLikelyEnglish,
  looksNonEnglish,
  enrichmentFailure,
  enrichWithModel,
  needsEnrichment,
  enrichOneProposal,
  sourceLanguageAllowed,
  proposalLanguageOk,
  overlap,
  bestMatch,
  detectKnowledgeCategory,
  classifyItem,
  looksLikeJobPosting,
  JOB_POSTING_RE,

  // Scan quota / pacing
  scanBudget,
  scanBudgetRemaining,
  paceScanModelCall,

  // Model-output parsing
  extractJson,

  // Web evidence cost controls (PR #2) — pure helpers, exported for tests
  localEvidenceCovers,
  citedWebIds,

  // Suggested-Updates preview fetch — exported so tests can verify the
  // Google-News -> Jina direct-extract path (Leg 1 resolver fix).
  fetchArticlePreview,
  jinaExtract,

  // Suggested-Updates durable store (Leg 2) — exported for the DB round-trip test.
  saveProposed,
  primeProposedFromDb,
  persistProposedStore,
  getProposedChanges,
  setProposedChanges,
  getSourceState,

  // Text segmentation
  splitSentences,

  // HTML sanitising
  stripHtml,

  // News subhead enrichment (option 2: deferred, timeout-capped)
  enrichTopArticles,
  fetchArticleSubhead,
  searchSubhead,
  extractSubhead,
  isGoogleNewsBoilerplate,
  pickSubheadCandidate,

  // Web-search provider chain (tavily -> brave -> jina)
  searchWeb,
  searchWebDetailed,
  searchProvider,

  // Bing News RSS fallback (Google-News-blocked path)
  isBingRedirector,
  unwrapBingNewsLink,
  parseBingNewsRss,
  searchBingNewsRss,

  // Patents — EPO OPS (live patent search)
  epoClient,
  buildCql,
  buildCacheKey,
  matchPatentCompanies,
  companyTokens,
  readPatentCache,
  writePatentCache,
  ensurePatentsCacheTable,
  purgeStalePatentCache,
  trackedCompanies,
  ensurePatentTranslationsTable,
  readPatentTranslation,
  writePatentTranslation,
  cpcCountsFor,
  MAX_TRANSLATE_CHARS,
  CPC_GROUPS,
  CPC_CHIPS,
  CPC_ALL_CODES,
  CPC_DEFAULT_CODES,
  EPO_MAX_ITEMS,

  // Reader proxy (Suggested Updates split-screen reader) — hardened, text-only.
  validateSourceUrl,
  assertPublicHost,
  isPrivateOrReservedIp,
  fetchReaderContent,
  applyRealSource,
  readStreamWithCap,
  createRateLimiter,
  summariseStoredItem,
  storeManualContent,
  writeStoreBody,

  // Resolver chains — exported so tests can assert the News-tab enrichment and
  // the background scanner use independent chains (no cross-contention).
  resolveGoogleNewsUrl,
  followGoogleRedirect,
  resolverNegativeCache,
  newsChains,
  scannerChains,
  resolvedUrlMap,
};
