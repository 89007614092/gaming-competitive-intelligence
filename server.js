const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
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
} = require("./summarise-engine");
const config = require("./config");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

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

// ===== Tavily Web Search (API key required) =====
// Replaces the old self-scraped DuckDuckGo search (run via a Python subprocess),
// which got rate-limited / served bot-challenges from Render's shared IP and
// always timed out. Tavily is a proper search API that returns structured
// results reliably from any IP. Requires TAVILY_API_KEY in the environment.

function tavilySearch(query, limit = 10) {
  return new Promise((resolve, reject) => {
    const apiKey = config.TAVILY_API_KEY;
    if (!apiKey) {
      return reject(new Error("Search API key not configured (set TAVILY_API_KEY)"));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.min(Number(limit) || 10, 20),
        search_depth: "basic",
        include_answer: false,
      }),
      signal: controller.signal,
    })
      .then(async (resp) => {
        clearTimeout(timeout);
        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          throw new Error(`Search API returned HTTP ${resp.status}: ${txt.slice(0, 160)}`);
        }
        const json = await resp.json();
        const results = Array.isArray(json.results) ? json.results : [];
        resolve(
          results
            .filter(item => item.url && (item.title || item.content))
            .map(item => ({
              title: item.title || item.url,
              url: item.url,
              description: String(item.content || item.title || "").slice(0, 900),
            }))
        );
      })
      .catch((err) => {
        clearTimeout(timeout);
        if (err.name === "AbortError") return reject(new Error("Search timed out"));
        reject(err);
      });
  });
}

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
  const validated = validateSourceUrl(url);
  const parsedHost = new URL(validated).hostname;
  await assertPublicHost(parsedHost); // resolve + reject private/loopback before fetching
  try {
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

async function fetchReaderContent(url, opts = {}) {
  const maxBytes = Number(opts.maxBytes) || READER_MAX_BYTES;
  const timeoutMs = Number(opts.timeoutMs) || READER_TIMEOUT_MS;
  const maxRedirects = Number(opts.maxRedirects) || READER_MAX_REDIRECTS;
  if (!url || typeof url !== "string") throw new Error("A valid source URL is required");

  let target = validateSourceUrl(url.slice(0, 2000));
  // Suggested-Update proposal URLs arrive as news.google.com/rss/articles/...
  // redirects that return only a generic Google News landing page ("Comprehensive
  // up-to-date news coverage..."). Resolve them to the real publisher URL first
  // (the same resolver scrapeUrl uses) so the reader fetches the actual article
  // body instead of the aggregator interstitial. Falls back to the original URL
  // if resolution fails; the redirect loop below still re-validates every hop.
  if (/news\.google\.com/i.test(target)) {
    try {
      const real = await resolveGoogleNewsUrl(target, opts.title || "", opts.domain || "");
      if (real) target = real;
    } catch (_) { /* keep the original URL */ }
  }
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
  const finalUrl = response.url || current;
  const title = extractTitle(html) || new URL(finalUrl).hostname;
  return { title, text, url: finalUrl, excerpt: text.slice(0, 400) };
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
    if (!url || typeof url !== "string") {
      return res.status(400).json({ error: "A url query parameter is required" });
    }
    const ip = req.ip || req.headers["x-forwarded-for"] || "unknown";
    if (!readerRateLimiter(ip)) {
      return res.status(429).json({ error: "Too many requests, please slow down" });
    }
    const result = await fetchReaderContent(url, {
      title: typeof req.query.title === "string" ? req.query.title : "",
      domain: typeof req.query.domain === "string" ? req.query.domain : "",
    });
    res.json(result);
  } catch (err) {
    // Generic error mapping — never leak internals (hosts, stack traces).
    const msg = err && err.message ? err.message : "";
    const code = /required|valid source/i.test(msg) ? 400
      : /too large/i.test(msg) ? 413
      : 502; // timeout, redirect loop, unsupported type, blocked/private host, DNS failure
    const message = code === 400 ? "A valid source URL is required"
      : code === 413 ? "The source response exceeded the size limit"
      : "Could not retrieve the source";
    res.status(code).json({ error: message });
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
  if (/news\.google\.com/i.test(sourceUrl)) {
    try {
      const real = await resolveGoogleNewsUrl(sourceUrl, opts.title || "", opts.domain || "");
      if (real) effectiveUrl = real;
    } catch (_) { /* keep the original URL */ }
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

function rankSourceEvidence(text, title = "", focusQuery = "", limit = 5) {
  const normalisedTitle = title.toLowerCase().replace(/\s+/g, " ").trim();
  const sentences = splitSentences(text).slice(0, 600).filter((sentence, index) => {
    const lower = sentence.toLowerCase();
    const boilerplateHits = ["share", "learn more", "sign up", "subscribe", "cookie", "all rights reserved"]
      .filter(term => lower.includes(term)).length;
    if (boilerplateHits >= 2) return false;
    if (index < 4 && normalisedTitle.length > 12 && lower.includes(normalisedTitle.slice(0, 70))) return false;
    return true;
  });
  if (!sentences.length) return [];

  const frequencies = new Map();
  meaningfulWords(sentences.join(" ")).forEach(word => frequencies.set(word, (frequencies.get(word) || 0) + 1));
  const titleWords = new Set(meaningfulWords(title));
  const focusWords = new Set(meaningfulWords(focusQuery));
  const statisticPattern = /(?:\b\d+(?:\.\d+)?%|[$£€¥]\s?\d|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s*(?:million|billion|trillion|percent|users|players|downloads|hours|days|months|years)\b)/i;
  const useCasePattern = /\b(?:use case|used to|using|deployed|implemented|enables?|allows?|powers?|automates?|generates?|assists?|npc|character|player|gameplay|development|production|workflow|personalisation|personalization)\b/i;
  const evidencePattern = /\b(?:according to|reported|found|survey|study|research|data|measured|increased|decreased|reduced|grew|launched|released)\b/i;

  const scored = sentences.map((rawSentence, index) => {
    const sentence = refineSentence(rawSentence);
    const words = meaningfulWords(sentence);
    const unique = [...new Set(words)];
    const focusHits = unique.filter(word => focusWords.has(word)).length;
    const frequencyScore = unique.reduce((total, word) => total + Math.min(frequencies.get(word) || 0, 8), 0) / Math.max(unique.length, 1);
    const titleScore = unique.filter(word => titleWords.has(word)).length * 1.4;
    const focusScore = focusHits * 4.5;
    const positionScore = Math.max(0, 1.4 - index / Math.max(sentences.length, 1));
    const lengthScore = sentence.length >= 75 && sentence.length <= 300 ? 1.1 : 0.2;
    const hasStatistic = statisticPattern.test(sentence);
    const hasUseCase = useCasePattern.test(sentence);
    const evidenceScore = evidencePattern.test(sentence) ? 1.5 : 0;
    const priorityScore = (hasStatistic ? 5 : 0) + (hasUseCase ? 3.5 : 0) + evidenceScore;
    return {
      sentence,
      index,
      hasStatistic,
      hasUseCase,
      focusHits,
      score: frequencyScore + titleScore + focusScore + positionScore + lengthScore + priorityScore,
    };
  });

  const ranked = scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const focused = focusWords.size
    ? ranked.filter(item => item.focusHits > 0 || item.hasStatistic || item.hasUseCase)
    : ranked;
  const candidates = focused.length >= Math.min(2, limit) ? focused : ranked;
  const selected = [];
  for (const item of candidates) {
    if (!item.sentence || selected.some(existing => isNearDuplicate(existing.sentence, item.sentence))) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function rankSourceSentences(text, title = "", limit = 4, focusQuery = "") {
  return rankSourceEvidence(text, title, focusQuery, limit).map(item => item.sentence);
}

function buildThematicFindings(evidenceItems) {
  const definitions = [
    { title: "Statistics & Market Signals", words: ["percent", "million", "billion", "revenue", "growth", "users", "players", "downloads", "market", "survey", "data"] },
    { title: "Applied Use Cases & Player Impact", words: ["use", "game", "player", "npc", "character", "gameplay", "personalisation", "personalization", "experience", "content"] },
    { title: "Technology & Product Capabilities", words: ["model", "technology", "system", "platform", "engine", "feature", "tool", "software", "ai", "automation"] },
    { title: "Development & Production", words: ["developer", "studio", "development", "production", "workflow", "testing", "design", "asset", "code", "launch"] },
    { title: "Risk, Policy & Governance", words: ["risk", "regulation", "law", "privacy", "safety", "copyright", "compliance", "policy", "security", "liability"] },
  ];
  const themes = definitions.map(definition => ({ ...definition, findings: [] }));
  const other = { title: "Other Relevant Evidence", findings: [] };

  evidenceItems.sort((a, b) => b.score - a.score).forEach(item => {
    const lower = item.text.toLowerCase();
    const scoredThemes = themes.map((theme, index) => {
      let score = theme.words.filter(word => lower.includes(word)).length;
      if (index === 0 && item.hasStatistic) score += 5;
      if (index === 1 && item.hasUseCase) score += 4;
      return { theme, score };
    }).sort((a, b) => b.score - a.score);
    const target = scoredThemes[0]?.score ? scoredThemes[0].theme : other;
    if (target.findings.length < 5 && !target.findings.some(existing => isNearDuplicate(existing, item.citedText))) {
      target.findings.push(item.citedText);
    }
  });

  return [...themes, other]
    .filter(theme => theme.findings.length)
    .map(({ title, findings }) => ({ title, findings }));
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

// POST /api/search — Tavily web search (requires TAVILY_API_KEY)
app.post("/api/search", async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    const results = await tavilySearch(query, limit);
    res.json({ success: true, data: results, total: results.length });
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
app.post("/api/summarise", async (req, res) => {
  try {
    const question = String(req.body?.question || "").replace(/\s+/g, " ").trim();
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

    let webEvidence = [];
    let webSearchError = "";
    // When the user attached their own sources, cap the web results so the
    // user's hand-picked context isn't drowned out by internet noise.
    const webCap = userEvidence.length > 0 ? Math.max(2, 6 - userEvidence.length) : 5;

    if (useInternet) {
      try {
        // Fetch more candidates than we keep, then relevance-filter so off-topic
        // hits (e.g. dictionary definitions of a word in the question) are dropped
        // before they can pollute the answer. The "analysis" suffix nudges Tavily
        // away from generic/definition pages toward substantive coverage.
        const webResults = await tavilySearch(`${question} analysis`, 8);
        const filtered = webResultRelevance(question, webResults, 5);
        const kept = filtered
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
          }));
        // Deep-fetch full text for the top 3 most-relevant web results so they are
        // processed as fully as the user's [S#] sources (bounded concurrency;
        // failures fall back to the Tavily snippet). The remaining results keep
        // their 900-char snippet.
        const topWeb = kept.slice(0, 3);
        const restWeb = kept.slice(3);
        const enrichedTop = await mapWithConcurrency(topWeb, 3, async (src) => {
          const full = await fetchArticleBody(src.url, src.text, src.title);
          if (full === src.text) return src;
          return { ...src, text: full, excerpt: full.slice(0, 360) };
        });
        webEvidence = [...enrichedTop, ...restWeb];
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
    // server-side backstop against malformed requests.
    let internetDropped = false;
    if (useInternet && (!useModel || !isModelReady())) {
      webEvidence = [];
      internetDropped = true;
    }

    const evidence = [...appEvidence, ...userEvidence, ...webEvidence];
    let answer;
    let mode;
    let modelError = "";
    let modelTimer;

    if (useModel) {
      mode = "local-open-source-model";
      try {
        answer = await Promise.race([
          generateOpenSourceAnswer(question, evidence),
          new Promise((_, reject) => {
            modelTimer = setTimeout(
              () => reject(new Error("Local model is still warming up; an extractive summary was returned. Try again in a moment for an AI synthesis.")),
              70000
            );
          }),
        ]);
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

function newsCompetitorAliases(company) {
  return company.name
    .split(/\s*\/\s*|\s+x\s+/i)
    .map(alias => alias.replace(/\s*\([^)]*\)\s*/g, " ").trim())
    .filter(alias => alias.length > 2);
}

function newsSelectionKey(competitors) {
  return competitors.map(company => company.id).sort().join(",");
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
  const resource = await fetchTextResource(url, "application/rss+xml,application/xml,text/xml");
  return parseNewsRss(resource.text, topicLabel, query, limit, candidateCompetitors);
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

async function getLiveNewsArticles(selectedCompetitors = []) {
  const topicSearches = NEWS_TOPICS.flatMap(topic =>
    topic.queries.map(query => searchGoogleNewsRss(query, topic.label, 6))
  );
  const competitorSearches = buildCompetitorNewsQueries(selectedCompetitors).map(batch =>
    searchGoogleNewsRss(batch.query, "Competitor News", 8, batch.competitors)
  );
  const searches = [...topicSearches, ...competitorSearches];
  const settled = await Promise.allSettled(searches);
  const seen = new Set();
  const articles = [];

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const article of result.value) {
      // Google News may surface the same story in several queries.
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

  return articles.slice(0, 40);
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

// Cache Tavily results by normalized title so repeated cards for the same
// headline hit the search API at most once per server process.
const subheadTitleCache = new Map();
async function tavilySubhead(title) {
  const norm = String(title || "").trim().toLowerCase();
  if (!norm) return null;
  if (subheadTitleCache.has(norm)) return subheadTitleCache.get(norm);
  const p = (async () => {
    try {
      const results = await tavilySearch(norm, 1);
      const first = results && results[0];
      if (!first) return null;
      // Prefer the clean extracted text Tavily returns for the headline query.
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

async function fetchArticleSubhead(article) {
  const title = article.title || "";
  // Tavily-first: the web-search API returns clean extracted article text, so
  // we skip the failing Google-News resolver + dispatcher entirely. This is the
  // path that replaces the boilerplate with a real lead. When Tavily is
  // unconfigured it returns null fast and we fall through to resolve+fetch.
  try {
    const tav = await tavilySubhead(title);
    const picked = pickSubheadCandidate(tav);
    if (picked) return picked;
  } catch (_) { /* fall through to the resolve+fetch fallback */ }

  // Fallback (Tavily unconfigured / failed): resolve the Google News redirect
  // to the publisher and read the page. Keeps a real lead when Tavily is absent.
  try {
    // News enrichment runs on its OWN resolver chain (newsChains) so it can
    // never starve the background scanner's URL resolution. And it is
    // cache-first: if this article (or the scanner) already resolved the real
    // URL, reuse it instead of hitting a search engine again.
    let target = article.url;
    if (/news\.google\.com/i.test(target)) {
      const cached = resolvedUrlMap.get(target) || (sourceState.resolvedUrls && sourceState.resolvedUrls[target]);
      target = cached || await resolveGoogleNewsUrl(target, title, "", newsChains) || target;
    }
    const page = await fetchTextResource(target);
    // Prefer the editor's strapline (meta description / og:description).
    const strapline = extractMetaDescription(page.text);
    // Fall back to the first 1-2 sentences of the article body.
    const body = extractText(page.text);
    const lead = splitSentences(body).slice(0, 2).join(" ").trim();
    // Reject the Google News boilerplate either way so we never show the
    // generic "Comprehensive up-to-date news coverage…" line.
    return pickSubheadCandidate(strapline, lead);
  } catch (_) {
    return null;
  }
}

// Bounded-concurrency enrichment of the first `limit` articles (default 6) so
// the News tab can show real subheads for the top cards. Each fetch is capped
// by `perArticleTimeoutMs` so a single slow resolution can never pile up, and
// the caller may run this fire-and-forget (after responding) — see /api/news.
// The rest of the cards are filled in lazily by the client as the user scrolls
// (see /api/news/subhead below).
async function enrichTopArticles(articles, limit = 6, concurrency = 5, perArticleTimeoutMs = 15000) {
  const top = articles.slice(0, limit);
  const withTimeout = (p, ms) =>
    Promise.race([p, new Promise((_, reject) => setTimeout(() => reject(new Error("enrich-timeout")), ms))]);
  for (let i = 0; i < top.length; i += concurrency) {
    const batch = top.slice(i, i + concurrency);
    await Promise.all(batch.map(async (a) => {
      try {
        const sub = await withTimeout(fetchArticleSubhead(a), perArticleTimeoutMs);
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

app.get("/api/news", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");

  try {
    const monitoredCompetitors = resolveNewsCompetitors(req.query.competitors);
    const liveArticles = await getLiveNewsArticles(monitoredCompetitors);

    // Single response path for both live and cached fallback. The News tab
    // responds immediately with RSS descriptions; subheads are filled in by the
    // client on scroll (and warmed in the background for the next load).
    let articles = liveArticles;
    let live = true;
    let searchedAt = new Date().toISOString();

    if (articles.length > 0) {
      cacheNews(newsSelectionKey(monitoredCompetitors), {
        generatedAt: searchedAt,
        source: "Google News RSS",
        count: liveArticles.length,
        articles: liveArticles,
      });
    } else {
      const fallback = getNewsFallback(monitoredCompetitors);
      if (fallback?.articles?.length) {
        articles = fallback.articles;
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
    const payload = {
      success: true,
      count: articles.length,
      articles,
      topics: NEWS_TOPICS.map(topic => topic.label),
      monitoredCompetitors: monitoredCompetitors.map(company => ({ id: company.id, name: company.name, custom: Boolean(company.custom) })),
      searchedAt,
      live,
      cached: !live,
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
        const payload = {
          success: true,
          count: fallback.articles.length,
          articles: fallback.articles,
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

// --- Custom competitor definitions (server-persisted) ---
app.get("/api/news/custom-competitors", (req, res) => {
  res.json({ customCompetitors: customCompetitors.slice() });
});

app.post("/api/news/custom-competitors", (req, res) => {
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

app.delete("/api/news/custom-competitors/:id", (req, res) => {
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
    return data && typeof data === "object" ? data : { sources: {}, lastFullScan: null };
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

function saveProposed() {
  try {
    fs.writeFileSync(PROPOSED_FILE, JSON.stringify(proposedChanges, null, 2));
  } catch (_) { /* non-fatal */ }
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
  try {
    const tl = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "regulatory-timeline.json"), "utf8"));
    (tl.events || []).forEach((e, i) =>
      push("timeline", `timeline:${i}`, e.title, `${e.title} ${e.description || ""} ${e.jurisdiction || ""} ${e.category || ""}`));
  } catch (_) {}
  try {
    const kb = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "knowledge.json"), "utf8"));
    for (const [k, cat] of Object.entries(kb.categories || {})) {
      (cat.subsections || []).forEach((s, i) => push("knowledge", `knowledge:${k}:${i}`, s.title, `${s.title} ${s.content || ""}`));
    }
  } catch (_) {}
  try {
    const uc = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "current-use-cases.json"), "utf8"));
    (uc.patterns || []).forEach((p, i) => push("use-cases", `uc:${i}`, p.title, `${p.title} ${p.content || ""} ${(p.games || []).join(" ")}`));
  } catch (_) {}
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

// Google News RSS <link> values are redirect URLs that loop back to the Google
// News SPA server-side (they never reach the publisher). Resolve the real article
// URL by searching DuckDuckGo for the title on the source's own domain and
// decoding the `uddg` redirect param. Serialized + paced via ddgResolveChain so
// we never hammer DDG in parallel (which triggers rate limiting). Cached so we
// rarely re-query. Best-effort: returns null on any failure. Falls back to the
// GDELT DOC API if DuckDuckGo can't resolve the URL.
async function resolveGoogleNewsUrl(googleUrl, title, domain, chains = scannerChains) {
  if (resolvedUrlMap.has(googleUrl)) return resolvedUrlMap.get(googleUrl);
  resolverStats.attempts++; // a real (non-cached) resolution is being attempted
  const cacheAndReturn = (real) => {
    if (!real) return null;
    resolverStats.ok++; // a real publisher URL was successfully resolved
    resolvedUrlMap.set(googleUrl, real);
    if (!sourceState.resolvedUrls) sourceState.resolvedUrls = {};
    sourceState.resolvedUrls[googleUrl] = real;
    return real;
  };
  // 0) Jina Reader (keyless) — tried first when SEARCH_PROVIDER=jina. Resolves
  //    the title to the real publisher URL via Jina's search endpoint, which
  //    works from any IP (no DDG/GDELT bot-challenge). Falls back to DDG/GDELT
  //    if Jina is unavailable or rate-limited.
  if (activeSearchProvider() === "jina") {
    try {
      const hit = (await jinaSearch(`${title}${domain ? ` site:${domain}` : ""}`, 5))[0];
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
      const site = domain ? ` site:${domain}` : "";
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
  // 1) DuckDuckGo (primary): title + site, then title alone (broader).
  const ddgUrl = (await tryDdg(title)) || (await tryDdg(String(title).replace(/\s*[–—-]\s*[^–—-]+$/, "").trim() || title));
  if (ddgUrl) return cacheAndReturn(ddgUrl);
  // 2) GDELT DOC API (secondary): real publisher URLs directly. Reached only when
  //    DDG fails, so rarely exercised — but it gives the scan a second (third)
  //    chance to fetch a real preview in production.
  const gdeltUrl = await resolveViaGdelt(title, domain, chains);
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
async function fetchArticlePreview(item, { timeoutMs = 12000, maxChars = 720, domain } = {}) {
  if (!item) return { text: null, blocked: false };
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

  if (!snippetIsThin) {
    const sentences = snippetText.match(/[^.!?]+[.!?]+/g) || [snippetText];
    let lead = sentences.slice(0, 3).join(" ").trim();
    if (lead.length > maxChars) lead = lead.slice(0, maxChars).trim().replace(/[,;]\s*$/, "") + "…";
    return { text: lead, blocked: false };
  }

  if (!item.url) return { text: null, blocked: false };
  let articleUrl = item.url;
  if (/news\.google\.com/i.test(articleUrl)) {
    const real = await resolveGoogleNewsUrl(item.url, item.title, domain);
    if (!real) return { text: null, blocked: false };
    articleUrl = real;
  }
  try {
    let body;
    if (activeSearchProvider() === "jina") {
      body = await jinaExtract(articleUrl, timeoutMs);
    } else {
      const resource = await fetchTextResource(articleUrl, "text/html,application/xhtml+xml,text/plain", timeoutMs);
      body = extractText(resource.text).replace(/\s+/g, " ").trim();
    }
    if (body.length < 140) return { text: null, blocked: false };
    if (looksLikeBotWall(body)) return { text: null, blocked: true };
    const sentences = body.match(/[^.!?]+[.!?]+/g) || [body];
    let lead = sentences.slice(0, 4).join(" ").trim();
    if (lead.length > maxChars) lead = lead.slice(0, maxChars).trim().replace(/[,;]\s*$/, "") + "…";
    return { text: lead, blocked: false };
  } catch (err) {
    // Distinguish an access block (bot-wall / anti-scrape) from a transient
    // network error so we flag the former for manual review rather than retry
    // endlessly on something that will never succeed automatically.
    const msg = (err && err.message ? err.message : "").toLowerCase();
    const accessBlocked = /http (401|403|429|503)|forbidden|access denied|unable to fetch|are you a robot|verify you are human|cloudflare/i.test(msg);
    return { text: null, blocked: accessBlocked };
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
async function enrichWithModel(prop, excerpt) {
  const text = (excerpt || stripHtml(prop.snippet || prop.description || "")).trim();
  if (!text) return null;
  const existing = prop.matchedRecord
    ? `EXISTING APP ENTRY (title: ${prop.matchedRecord.title}):\n${existingRecordContent(prop.matchedRecord).slice(0, 700) || "(content unavailable)"}\n\n`
    : "";
  const system = `You rewrite AI-regulation/policy news into the house style of a curated competitive-intelligence knowledge base. House style: formal, neutral, third-person, factual; state concrete figures, dates and regulation/article references; 2-3 sentences; no promotional or journalistic language; never invent facts not in the source. ${STYLE_EXAMPLES}`;
  const user = `Classify why this update is proposed and rewrite the source excerpt into ONE knowledge-base entry in house style.${existing}
NEW SOURCE (${prop.publisher || "unknown"}): ${prop.title}
${text}

Return ONLY valid JSON:
{
  "updateCategory": one of "information-outdated" | "additional-information" | "new-case-study" | "new-deadline" | "new-development",
  "updateReason": one short sentence (max 20 words) explaining why this is suggested,
  "styledSummary": the rewritten entry in house style (max 600 chars). Do NOT add a citation line — the app appends the source.
  "rejected": true ONLY if this is a job posting, a hiring/careers page, an event invitation, or otherwise not a substantive AI-regulation/policy development. If rejected, set styledSummary to "" and updateCategory to null.
}`;
  const raw = await runModelChat(system, user, { maxTokens: 500, temperature: 0.2, json: true, timeoutMs: 25000, lane: "scan" });
  if (raw && raw.rateLimited) return { rateLimited: true };
  if (!raw) return null;
  try {
    const obj = extractJson(raw);
    if (obj && obj.rejected === true) return { rejected: true }; // Option B: model judged this non-substantive
    if (!obj || typeof obj.styledSummary !== "string" || !obj.styledSummary.trim()) return null;
    return {
      updateCategory: UPDATE_REASON_KEYS.includes(obj.updateCategory) ? obj.updateCategory : (prop.detectedAction === "deadline" ? "new-deadline" : "new-development"),
      updateReason: String(obj.updateReason || "").slice(0, 240),
      styledSummary: obj.styledSummary.slice(0, 600).trim(),
    };
  } catch {
    return null;
  }
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
  if (!isLikelyEnglish(text)) return null; // (a) drop non-English
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
    createdAt: new Date().toISOString(),
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

  // No matching existing record. Surfacing a brand-new topic is noisy, so only
  // propose it when it is clearly about AI regulation/policy AND comes from an
  // official regulator / legislation / academic source. Competitor & industry
  // "news" with no existing anchor is dropped entirely.
  if (itemStrong.size >= 1 && (source.category === "regulation" || source.category === "academic")) {
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
      if (!data.categories[key]) data.categories[key] = { label: CATEGORY_LABELS[key] || key, icon: "🟢", subsections: [] };
      data.categories[key].subsections = data.categories[key].subsections || [];
      data.categories[key].subsections.unshift({ title: prop.title, content: edit, sources: [{ label: publisher, url }] });
    } else if (target === "use-cases") {
      data.patterns = data.patterns || [];
      data.patterns.unshift({ title: prop.title, content: edit, games: [] });
    }
  }

  fs.writeFileSync(path.join(__dirname, "data", file), JSON.stringify(data, null, 2));
  if (target === "timeline") regulatoryTimelineCache = null;
  if (target === "knowledge") knowledgeCache = null;
  if (target === "use-cases") currentUseCasesCache = null;
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

async function fetchSourceItems(source) {
  const freshness = source.freshness || "7d";
  const query = `site:${source.domain} ${source.terms} when:${freshness}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
  const resource = await fetchTextResource(url, "application/rss+xml,application/xml,text/xml");
  return parseNewsRss(resource.text, source.name, query, source.limit || 5, []);
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
    const sources = loadSourceRegistry();
    const now = Date.now();
    const due = sources.filter(s =>
      force ||
      !sourceState.sources[s.id] ||
      !sourceState.sources[s.id].lastScanAt ||
      (now - sourceState.sources[s.id].lastScanAt) >= (s.ttlMinutes || 15) * 60000
    );

    const index = buildExistingIndex();
    // Three independent guards stop the same item being proposed twice:
    //   1. `seen`      — per-source URL set (above); persisted across scans in
    //                   sourceState so a URL already scanned won't be re-fetched.
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

    for (const source of due) {
      try {
        const items = await fetchSourceItems(source);
        const state = sourceState.sources[source.id] || { seen: [] };
        const seen = new Set(state.seen || []);
        for (const item of items) {
          if (!item.url || seen.has(item.url)) continue;
          seen.add(item.url);
          considered++;
          const prop = classifyItem(source, item, index);
          if (!prop) continue;                       // dropped: non-English or duplicate
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
        sourceState.sources[source.id] = {
          lastScanAt: now,
          name: source.name,
          seen: [...seen].slice(-300),
        };
        scanned++;
      } catch (_) {
        // Skip a failing source; continue with the rest.
      }
    }

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
      const hasPreview = prop.preview && prop.preview.length;
      const hasReason = prop.updateCategory && UPDATE_REASON_LABELS[prop.updateCategory];
      const hasStyled = prop.styledSummary && prop.styledSummary.length;
      // Skip only when FULLY enriched: preview + model reason + a styled summary.
      // A proposal that got a heuristic category but no styledSummary (e.g. the
      // model was offline on its first scan) must be retried so it can later
      // receive the AI "Proposed Entry" summary once the model key is available.
      if (hasPreview && hasReason && hasStyled) continue;
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
    let callsThisRun = 0;

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
        // (a) Fetch a real preview of the source article. A bot-wall / anti-scrape
        // block is recorded as fetchStatus:"blocked" so the UI can ask for manual
        // review instead of caching garbage (#3) or presenting raw scraped text.
        let preview = null;
        let blocked = false;
        try {
          const result = await fetchArticlePreview(prop, { domain: prop.sourceDomain });
          preview = result.text;
          blocked = !!result.blocked;
        } catch { /* best effort */ }
        // Record the attempt even on failure so the cooldown guards against
        // re-hammering a URL that the resolver can't currently resolve.
        prop.lastPreviewAttempt = new Date().toISOString();

        if (blocked) {
          // Cache hygiene (#5): do NOT overwrite a previously good preview with
          // the bot-wall page, and do not set a finished suggestion. Flag for
          // manual review; keep any existing good styledSummary untouched.
          prop.fetchStatus = "blocked";
          return;
        }
        prop.fetchStatus = "ok";

        if (preview) {
          // Cache hygiene (#5): only overwrite the preview when we have content.
          prop.preview = preview;
          if (prop.detectedAction === "new") {
            prop.targetCategory = detectKnowledgeCategory(`${prop.title} ${preview}`, prop.category);
          }
        }

        // (b) Combined enrichment: model-based rewrite + reason. We NEVER present
        // the raw source excerpt (baseText) as the finished suggestion (#4). When
        // the model can't produce a styled summary we mark the proposal as
        // pending / rate-limited so the UI shows an honest notice and the next
        // scan retries it (with the short per-proposal backoff) instead of dumping
        // raw scraped text into the review panel.
        const baseText = preview || stripHtml(prop.snippet || prop.description || "");
        // (C) Re-validate language on the REAL article text. The original gate
        // only saw the RSS title/description, which Google News may auto-translate
        // to English even when the source article is non-English. If the fetched
        // body is non-English, reject the proposal so it never reaches the review
        // panel (and is purged from the persisted queue).
        if (baseText && !isLikelyEnglish(baseText)) {
          prop.rejectedByLanguage = true;
          prop.status = "rejected";
          if (prop._newlyProposed) {
            proposed = Math.max(0, proposed - 1);
            counts[prop.detectedAction] = Math.max(0, (counts[prop.detectedAction] || 1) - 1);
          }
          return;
        }
        if (!baseText) {
          // Nothing to work with: the live preview fetch failed (e.g. the
          // resolver couldn't reach the publisher) and there is no usable
          // snippet. Leave the proposal in an honest "pending" state so the UI
          // does not show the misleading "No extractable summary" copy, and the
          // next scan retries it once the source becomes reachable.
          prop.enrichStatus = "pending";
          return;
        }

        let enriched = null;
        // Three gates before we are allowed to spend a request:
        //   - the engine's cooldown (a 429 already happened; don't pile on),
        //   - this run's call cap, and
        //   - the remaining daily budget.
        // Anything blocked here is left in an honest "pending" state and picked
        // up by a later scan, rather than being filled with raw scraped text.
        const outOfRunBudget = callsThisRun >= SCAN_CALLS_PER_RUN_CAP;
        const outOfDayBudget = scanBudgetRemaining() <= 0;
        if (!isScanRateLimited() && !outOfRunBudget && !outOfDayBudget) {
          // Pace the call so we can never exceed the provider's per-minute
          // ceiling, and count it before it is issued (a failed attempt still
          // consumes provider quota).
          await paceScanModelCall();
          callsThisRun++;
          consumeScanBudget();
          try { enriched = await enrichWithModel(prop, baseText); } catch { /* best effort */ }
        } else if (outOfRunBudget || outOfDayBudget) {
          // Budget exhausted — do NOT set a cooldown. The proposal stays eligible
          // so the next scan (or the next UTC day) can finish it.
          if (!prop.styledSummary) prop.enrichStatus = "pending";
          return;
        }

        if (enriched && enriched.rateLimited) {
          // Model hit a rate limit on this call. Set a per-proposal backoff
          // (default 45 min — deliberately LONGER than the engine's ~1h cooldown
          // so parked proposals re-eligible a few at a time, never all at once)
          // before retrying this proposal, rather than inheriting the engine's
          // full cooldown.
          prop.enrichCooldownUntil = new Date(Date.now() + PER_PROPOSAL_BACKOFF_MS).toISOString();
          prop.enrichStatus = "rate-limited";
          // Cache hygiene (#5): keep any previously-good styled summary; do not
          // rewrite with raw text.
          return;
        }

        if (enriched && enriched.rejected) {
          // Option B: the model determined this is not a substantive
          // AI-regulation/policy development (job posting, careers page, event
          // invite, etc). Mark it and drop it from the queue so it never reaches
          // the review panel. It was already added to the `seen` set, so it won't
          // be re-scanned — and we saved the rest of the enrichment pipeline.
          prop.rejectedByModel = true;
          prop.status = "rejected";
          if (prop._newlyProposed) {
            proposed = Math.max(0, proposed - 1);
            counts[prop.detectedAction] = Math.max(0, (counts[prop.detectedAction] || 1) - 1);
          }
          return;
        }

        if (!enriched) {
          // Don't clobber a prior good AI summary if the model just hiccuped.
          if (prop.styledSummary) {
            prop.enrichStatus = "done";
            return;
          }
          // No styled summary and model unavailable → honest pending state. The
          // UI shows "AI rewrite temporarily unavailable (quota); will auto-enrich
          // when capacity recovers." The next scan (past the per-proposal backoff) retries.
          prop.enrichStatus = "rate-limited";
          prop.enrichCooldownUntil = new Date(Date.now() + PER_PROPOSAL_BACKOFF_MS).toISOString();
          return;
        }

        // Success: persist the model output and mark done.
        prop.updateCategory = enriched.updateCategory;
        prop.updateReason = enriched.updateReason;
        prop.styledSummary = enriched.styledSummary || null;
        prop.enrichStatus = "done";
        const styled = enriched.styledSummary;
        prop.suggestedEdit = prop.detectedAction === "new"
          ? draftNewRecord(prop, prop.publisher, prop.publishedLabel, prop.targetCategory, styled)
          : draftEdit(prop, prop.detectedAction, prop.publisher, prop.publishedLabel, styled);
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
      due: due.length,
      considered,
      proposed,
      counts,
      // Request accounting — makes it obvious from the logs alone whether a scan
      // was throttled by the run cap, the daily budget, or a provider 429.
      modelCalls: callsThisRun,
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
    uptimeSeconds: Math.round(process.uptime()),
    lastScanAt: sourceState.lastFullScan || null,
    scanning: sourceScanInFlight,
    scanBudget: { used: scanBudget().used, limit: SCAN_DAILY_CALL_BUDGET, day: scanBudget().day },
    callBudget: { used: scanModelCallsThisRun, limit: SCAN_CALLS_PER_RUN_CAP },
    stuckRateLimitedProposals: stuckRateLimited,
    resolver: { attempts: resolverStats.attempts, ok: resolverStats.ok, successRatePct: resolverSuccessRate },
  });
});

// Trigger a crawl of the allowlist. The scan can now take a while (it fetches
// each proposed article to build a real preview), so we run it in the background
// and return immediately. The client polls /api/proposed-changes separately.
app.post("/api/source-scan", (req, res) => {
  const force = !!(req.body && req.body.force);
  const result = runSourceScan({ force });
  result
    .then(r => console.log("[source-scan] completed:", JSON.stringify(r)))
    .catch(err => console.warn("[source-scan] failed:", err.message));
  res.json({ success: true, started: true, scanning: sourceScanInFlight });
});

// List pending proposed changes for the review panel.
app.get("/api/proposed-changes", (req, res) => {
  const items = (proposedChanges.items || [])
    .filter(i => i.status === "pending")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, pending: items, pendingCount: items.length });
});

// Optional shared-secret auth for state-changing endpoints. DISABLED by default
// (ADMIN_API_KEY unset) so existing behaviour is preserved. When ADMIN_API_KEY
// is set, mutating endpoints require the `X-Admin-Key` header to match, which
// stops any visitor from rewriting curated datasets or burning the model budget.
function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_API_KEY;
  if (!key) return next();
  const provided = req.get("x-admin-key") || (req.body && req.body.adminKey);
  if (provided !== key) return res.status(401).json({ error: "Unauthorized" });
  next();
}

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
  setInterval(() => { runSourceScan({ force: false }).catch(() => {}); }, SOURCE_SCAN_TICK_MS);
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
  }, 30000);
}

// POST /api/scrape — extract readable website text or a public video transcript
app.post("/api/scrape", async (req, res) => {
  try {
    const { url, title = "" } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    const result = await scrapeUrl(url, { title });
    const wordCount = result.text.split(/\s+/).filter(Boolean).length;
    const summarySentences = rankSourceSentences(result.text, result.title, 4);
    res.json({
      success: true,
      data: {
        metadata: {
          title: result.title,
          url: result.url,
          originalUrl: result.originalUrl || url,
          sourceType: result.sourceType,
          extractionMethod: result.extractionMethod,
          language: result.language,
          wordCount,
          characterCount: result.text.length,
        },
        summary: summarySentences.join(" "),
        content: result.text,
        markdown: result.text,
      },
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// GET /api/status
app.get("/api/status", (req, res) => {
  res.json({
    mode: "Tavily web search (API key required)",
    searchProvider: "Tavily",
    scrapeProvider: "Readable web text + public video captions",
  });
});

// GET /api/knowledge — serve the structured knowledge base
let knowledgeCache = null;
app.get("/api/knowledge", (req, res) => {
  try {
    const { category, search } = req.query;

    if (!knowledgeCache) {
      knowledgeCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "knowledge.json"), "utf8")
      );
    }

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
let networkCache = null;
app.get("/api/network", (req, res) => {
  try {
    if (!networkCache) {
      networkCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "network.json"), "utf8")
      );
    }
    res.json({ success: true, data: networkCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tencent-products — Tencent's AI/gaming product portfolio
let tencentProductsCache = null;
app.get("/api/tencent-products", (req, res) => {
  try {
    if (!tencentProductsCache) {
      tencentProductsCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "tencent-products.json"), "utf8")
      );
    }
    res.json({ success: true, data: tencentProductsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/current-use-cases — consolidated game-by-game AI implementations
let currentUseCasesCache = null;
app.get("/api/current-use-cases", (req, res) => {
  try {
    if (!currentUseCasesCache) {
      currentUseCasesCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "current-use-cases.json"), "utf8")
      );
    }
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
let gamingTrendsCache = null;
app.get("/api/gaming-trends", (req, res) => {
  try {
    if (!gamingTrendsCache) {
      gamingTrendsCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "gaming-trends.json"), "utf8")
      );
    }
    res.json({ success: true, data: gamingTrendsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gaming-trends/search — live web search (Tavily) for a trend
app.post("/api/gaming-trends/search", async (req, res) => {
  try {
    const { keywords, limit = 5 } = req.body;
    if (!keywords) return res.status(400).json({ error: "Search keywords required" });

    const results = await tavilySearch(keywords, limit);
    res.json({ success: true, data: results, keywords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/regulatory-timeline — EU & UK AI regulatory deadlines
let regulatoryTimelineCache = null;
app.get("/api/regulatory-timeline", (req, res) => {
  try {
    if (!regulatoryTimelineCache) {
      regulatoryTimelineCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "regulatory-timeline.json"), "utf8")
      );
    }
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

// POST /api/regulatory-scan — search for new AI regulatory developments
app.post("/api/regulatory-scan", async (req, res) => {
  try {
    const scanQueries = [
      "EU AI Act 2026 2027 new regulation deadline compliance",
      "UK AI regulation 2026 2027 new bill law policy",
      "AI Act high-risk systems enforcement 2026 2027",
      "EU digital regulation AI gaming 2026",
    ];

    const results = await Promise.allSettled(
      scanQueries.map(async (q) => {
        try {
          const items = await tavilySearch(q, 3);
          return { query: q, results: items };
        } catch (_) { return { query: q, results: [] }; }
      })
    );

    // Collect all results and filter for regulatory relevance
    const seen = new Set();
    const developments = [];

    const regulatoryTerms = [
      "AI Act", "regulation", "compliance", "deadline", "law", "legislation",
      "directive", "enforcement", "prohibited", "high-risk", "GPAI", "DMA",
      "liability", "governance", "regulatory", "fine", "sanction", "ICO",
      "European Commission", "parliament", "council", "data protection",
      "copyright", "transparency", "watermark", "digital"
    ];

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of r.value.results || []) {
        if (!item.url || seen.has(item.url)) continue;
        const text = ((item.title || "") + " " + (item.description || "")).toLowerCase();
        const matchCount = regulatoryTerms.filter(t => text.includes(t.toLowerCase())).length;
        if (matchCount < 2) continue; // Must match at least 2 regulatory terms

        seen.add(item.url);
        developments.push({
          title: item.title,
          url: item.url,
          description: item.description,
          source: "Web search",
          foundAt: new Date().toISOString(),
        });
      }
    }

    res.json({
      success: true,
      count: developments.length,
      developments: developments.slice(0, 15),
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-scan — search for new AI/gaming regulatory knowledge
app.post("/api/knowledge-scan", async (req, res) => {
  try {
    const scanQueries = [
      "AI gaming regulation compliance 2026",
      "generative AI game development law EU UK 2026",
      "AI copyright gaming industry 2026",
      "world models AI regulation 2026",
    ];

    const results = await Promise.allSettled(
      scanQueries.map(async (q) => {
        try {
          const items = await tavilySearch(q, 3);
          return { query: q, results: items };
        } catch (_) { return { query: q, results: [] }; }
      })
    );

    const seen = new Set();
    const items = [];

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of r.value.results || []) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        items.push({
          title: item.title,
          url: item.url,
          description: item.description,
          source: "Web search",
          foundAt: new Date().toISOString(),
        });
      }
    }

    res.json({
      success: true,
      count: items.length,
      items: items.slice(0, 10),
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/risks — cross-referenced risk analysis
let risksCache = null;
app.get("/api/risks", (req, res) => {
  try {
    if (!risksCache) {
      risksCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "risks.json"), "utf8")
      );
    }
    res.json({ success: true, data: risksCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/company-locations — UK & EU company and regulator locations
let companyLocationsCache = null;
app.get("/api/company-locations", (req, res) => {
  try {
    if (!companyLocationsCache) {
      companyLocationsCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "company-locations.json"), "utf8")
      );
    }
    res.json({ success: true, data: companyLocationsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = config.PORT;
// Only bind a port when executed directly. Guarded so a test harness can
// `require("./server")` (registering routes on `app`) without opening a socket.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n  Insights Tool`);
    console.log(`  Server running at http://localhost:${PORT}`);
    console.log(`  Python: ${PYTHON ? `${PYTHON} — video transcripts enabled` : "NOT FOUND — video transcripts disabled"}`);
    console.log(`  Search: Tavily web search (requires TAVILY_API_KEY)\n`);
    // The AI model runs on every answer (with an extractive-citation fallback when
    // unavailable), so there is nothing to preload at startup.
  });
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

  // Text segmentation
  splitSentences,

  // HTML sanitising
  stripHtml,

  // News subhead enrichment (option 2: deferred, timeout-capped)
  enrichTopArticles,
  fetchArticleSubhead,
  tavilySubhead,
  isGoogleNewsBoilerplate,
  pickSubheadCandidate,

  // Reader proxy (Suggested Updates split-screen reader) — hardened, text-only.
  validateSourceUrl,
  assertPublicHost,
  isPrivateOrReservedIp,
  fetchReaderContent,
  readStreamWithCap,
  createRateLimiter,

  // Resolver chains — exported so tests can assert the News-tab enrichment and
  // the background scanner use independent chains (no cross-contention).
  resolveGoogleNewsUrl,
  newsChains,
  scannerChains,
  resolvedUrlMap,
};
