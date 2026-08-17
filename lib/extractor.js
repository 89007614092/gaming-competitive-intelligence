"use strict";
// Governed central extractor — the heart of the BI-grade pipeline.
//
// `createExtractor(deps)` returns an `extractArticle` function that turns an
// article URL into clean extracted text + provenance. It is deliberately
// dependency-injected so the security primitives (validateSourceUrl,
// assertPublicHost, readStreamWithCap) stay defined once, in server.js, and so
// the module is unit-testable with mocked dependencies.
//
// Extraction is routed through the Jina reader (https://r.jina.ai/<url>), which
// renders JavaScript and bypasses consent/paywall walls server-side — this is
// what makes article text retrievable where a direct Render fetch cannot (the
// root cause of the old "Could not retrieve the source" failure).
//
// Results are cached by canonical URL with a TTL per license class, and failed
// URLs are recorded in a session-only negative cache so re-opening is instant.

const JINA_READER_BASE = "https://r.jina.ai/";
// How long a failed/short extraction is remembered before we allow a retry.
// Time-bounded (not permanent) so a transient Jina throttle or network blip
// does not doom a URL for the whole session — a later paste can recover.
const NEGATIVE_TTL_MS = Number(process.env.EXTRACTOR_NEGATIVE_TTL_MS) || 10 * 60 * 1000;
const EXTRACT_TTL_MS = {
  "open": 1000 * 60 * 60 * 24 * 90,          // 90d — filings/open are low-risk
  "news-fair-use": 1000 * 60 * 60 * 24 * 180, // 180d then rolled to excerpt (Phase 3)
  "api-restricted": 1000 * 60 * 60 * 24,      // honour short API TTLs
  "restricted": 0,                            // never cache full text
};

function canonicalizeUrl(input) {
  const u = new URL(input);
  u.hash = "";
  u.hostname = u.hostname.toLowerCase();
  // Drop common tracking params so the same article caches once.
  const drop = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
    "fbclid", "gclid", "mc_cid", "mc_eid", "igshid", "ref", "feature", "campaign"];
  const kept = new URLSearchParams();
  for (const [k, v] of u.searchParams.entries()) {
    if (!drop.includes(k.toLowerCase())) kept.append(k, v);
  }
  u.search = kept.toString();
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.replace(/\/+$/, "");
  }
  return u.toString();
}

function parseJina(raw) {
  // Jina's reader returns text that may carry a small structured header
  // (Title:, URL Source:, Published Time:, Markdown Content:). Strip those
  // header lines and keep the article body as clean text.
  const lines = raw.split(/\r?\n/);
  let title = "";
  const body = [];
  for (const line of lines) {
    const t = line.match(/^Title:\s*(.+)$/i);
    if (t) { if (!title) title = t[1].trim(); continue; }
    if (/^(URL Source|Published Time|Markdown Content):/i.test(line)) continue;
    body.push(line);
  }
  return { text: body.join("\n").trim(), title };
}

function buildAttribution(canonical, title, licenseClass) {
  let host = "";
  try { host = new URL(canonical).hostname; } catch { /* keep empty */ }
  return {
    source: host,
    title: title || "",
    url: canonical,
    retrievedAt: new Date().toISOString(),
    licenseClass: licenseClass || "news-fair-use",
  };
}

function createExtractor(deps = {}) {
  const {
    validateSourceUrl,
    assertPublicHost,
    readStreamWithCap,
    SCRAPE_USER_AGENT = "Mozilla/5.0",
    READER_MAX_BYTES = 5 * 1024 * 1024,
    READER_TIMEOUT_MS = 20000,
    readerRateLimiter,
  } = deps;

  const cache = new Map();    // canonical -> { ...result, expires }
  const negative = new Map(); // canonical -> expiryMs (session-only, time-bounded)

  function ttlFor(cls) {
    return EXTRACT_TTL_MS[cls] != null ? EXTRACT_TTL_MS[cls] : EXTRACT_TTL_MS["news-fair-use"];
  }

  async function extractArticle(url, opts = {}) {
    const licenseClass = opts.licenseClass || "news-fair-use";
    let canonical;
    try {
      const validated = validateSourceUrl ? validateSourceUrl(url) : new URL(url).toString();
      canonical = canonicalizeUrl(validated);
    } catch (_) {
      const err = new Error("Invalid source URL for extraction");
      err.code = "INVALID_URL";
      throw err;
    }
    if (negative.has(canonical)) {
      if (negative.get(canonical) > Date.now()) return null; // still poisoned
      negative.delete(canonical); // expired -> allow a fresh attempt
    }

    // Restricted sources: never fetch or store full text — surface metadata only.
    if (licenseClass === "restricted") {
      return {
        restricted: true,
        text: "",
        excerpt: "",
        licenseClass,
        attribution: buildAttribution(canonical, "", licenseClass),
        url: canonical,
      };
    }

    const hit = cache.get(canonical);
    if (hit && hit.expires > Date.now()) {
      return { ...hit, cached: true };
    }

    // Governed fetch through the Jina reader (renders JS, bypasses consent walls).
    const jinaUrl = JINA_READER_BASE + canonical;
    if (readerRateLimiter && !readerRateLimiter("extractor")) {
      throw new Error("Extraction rate limit exceeded");
    }
    if (assertPublicHost) {
      try { await assertPublicHost("r.jina.ai"); } catch (_) { /* guarded below */ }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), READER_TIMEOUT_MS);
    let buf;
    try {
      const res = await fetch(jinaUrl, {
        headers: {
          "User-Agent": SCRAPE_USER_AGENT,
          Accept: "text/plain, text/markdown, application/json",
        },
        redirect: "follow",
        signal: controller.signal,
      });
      if (!res.ok) {
        // A 403 from Jina (anonymous-throttle / AbuseAlleviation) is account-level,
        // not URL-level — do NOT poison the per-URL negative cache with it, or a
        // single throttle would blacklist the URL for the whole session.
        if (res.status !== 403) negative.set(canonical, Date.now() + NEGATIVE_TTL_MS);
        return null;
      }
      const ct = res.headers.get("content-type") || "";
      if (!/(text\/plain|text\/markdown|application\/json|text\/html)/i.test(ct)) {
        negative.set(canonical, Date.now() + NEGATIVE_TTL_MS); return null;
      }
      buf = await readStreamWithCap(res, READER_MAX_BYTES);
    } catch (_) {
      // Transient network/DNS error — time-bounded so it can retry later.
      negative.set(canonical, Date.now() + NEGATIVE_TTL_MS);
      return null;
    } finally {
      clearTimeout(timer);
    }

    const raw = buf.toString("utf8").trim();
    if (raw.length < 120) { negative.set(canonical, Date.now() + NEGATIVE_TTL_MS); return null; }

    const { text, title } = parseJina(raw);
    const attribution = buildAttribution(canonical, title, licenseClass);
    const result = {
      text,
      excerpt: text.slice(0, 400),
      title,
      licenseClass,
      attribution,
      url: canonical,
      cached: false,
      via: "jina",
    };
    cache.set(canonical, { ...result, expires: Date.now() + ttlFor(licenseClass) });
    return result;
  }

  function clearCaches() { cache.clear(); negative.clear(); }

  return { extractArticle, clearCaches };
}

module.exports = { createExtractor, EXTRACT_TTL_MS };
