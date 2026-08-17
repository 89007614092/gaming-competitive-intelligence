"use strict";
// License gate — the governance enforcement layer for extracted content.
//
// Every stored/served article carries a `licenseClass` (open / news-fair-use /
// api-restricted / restricted). This module turns that class into the concrete
// rules the rest of the app must obey:
//
//   open            -> full text, no restriction (public official sources)
//   news-fair-use   -> full text INTERNAL; external exposure capped to a
//                      300-word excerpt + mandatory attribution
//   api-restricted  -> full text but honour the source API's TTL (never persist
//                      beyond it — see the writeStoreBody guard in server.js)
//   restricted      -> metadata + link + snippet ONLY — never full text
//                      (no paywall circumvention)
//
// The `internal` flag is the single switch. This app is internal-only today, so
// it is called with `internal: true` and news-fair-use items keep full text.
// Flip it to `false` the moment any content is exposed externally and the
// 300-word cap + attribution kicks in automatically.

const EXCERPT_MAX_WORDS = 300;

const LICENSE_LABELS = {
  "open": "Open",
  "news-fair-use": "News · fair use",
  "api-restricted": "API-restricted",
  "restricted": "Restricted",
};

const VALID_CLASSES = Object.keys(LICENSE_LABELS);

function normalizeAttribution(item) {
  // Prefer an explicit attribution object; otherwise derive from the item.
  if (item.attribution && typeof item.attribution === "object") {
    return {
      source: item.attribution.source || "",
      title: item.attribution.title || item.title || "",
      url: item.attribution.url || item.url || "",
      retrievedAt: item.attribution.retrievedAt || null,
      licenseClass: item.attribution.licenseClass || item.licenseClass || "open",
    };
  }
  let host = "";
  try { host = item.url ? new URL(item.url).hostname : (item.sourceDomain || ""); } catch { /* keep empty */ }
  return {
    source: host,
    title: item.title || "",
    url: item.url || "",
    retrievedAt: item.retrievedAt || item.ingestedAt || null,
    licenseClass: item.licenseClass || "open",
  };
}

function excerptWords(text, max) {
  const words = (text || "").trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(" ");
  return words.slice(0, max).join(" ") + " …";
}

// Shape an item for storage/serving according to its license class.
// `item` is any object carrying at least `licenseClass` (and ideally text/body,
// url, title, attribution). Returns a new object — never mutates the input.
function applyLicenseGate(item, { internal = true } = {}) {
  if (!item || typeof item !== "object") return item;
  const cls = VALID_CLASSES.includes(item.licenseClass)
    ? item.licenseClass
    : (item.attribution && VALID_CLASSES.includes(item.attribution.licenseClass)
      ? item.attribution.licenseClass
      : "open");
  const attribution = normalizeAttribution(item);

  // restricted -> metadata + link + snippet ONLY. Never full text.
  if (cls === "restricted") {
    return {
      ...item,
      text: "",
      body: "",
      gated: true,
      gateReason: "restricted",
      snippet: item.snippet || "",
      link: item.url || attribution.url || "",
      attribution,
    };
  }

  // news-fair-use -> full text internally; external exposure capped to excerpt.
  if (cls === "news-fair-use" && !internal) {
    const full = item.text || item.body || "";
    return {
      ...item,
      text: excerptWords(full, EXCERPT_MAX_WORDS),
      body: excerptWords(full, EXCERPT_MAX_WORDS),
      gated: true,
      gateReason: "external-fair-use-excerpt",
      attribution: { ...attribution, licenseClass: "news-fair-use" },
    };
  }

  // open / api-restricted / internal news-fair-use -> full text allowed.
  return { ...item, gated: false, attribution };
}

module.exports = {
  applyLicenseGate,
  normalizeAttribution,
  LICENSE_LABELS,
  VALID_CLASSES,
  EXCERPT_MAX_WORDS,
};
