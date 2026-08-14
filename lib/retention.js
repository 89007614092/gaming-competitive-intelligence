// Phase 3 retention policy — pure, unit-testable, no server imports.
//
// Drives retention off the `retentionClass` tag that Phase 2 attached to every
// proposed item (derived from the AI-regulation source category):
//   regulatory -> full text kept 3y, then purged
//   use-case   -> full text kept 180d, then rolled to excerpt-only (kept)
// A legal-hold id set (env RETENTION_LEGAL_HOLD_IDS) overrides everything and
// keeps an item at "full" forever.
//
// Lane A (AI-regulation) items are all official/regulatory, so the "link-only"
// floor reserved for restricted license classes is not triggered here; the
// mechanism supports it for when gaming/news-fair-use lands in Phase 4.

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const RETENTION_WINDOWS = {
  regulatory: { fullMs: 3 * YEAR_MS, roll: "purge" },
  "use-case": { fullMs: 180 * DAY_MS, roll: "excerpt" },
};

// Safe default for an item with no/unknown class: keep full for 3y then purge.
const DEFAULT_WINDOW = { fullMs: 3 * YEAR_MS, roll: "purge" };

const EXCERPT_MAX_WORDS = 300;

function windowFor(retentionClass) {
  return RETENTION_WINDOWS[retentionClass] || DEFAULT_WINDOW;
}

function toHoldSet(legalHoldIds) {
  if (!legalHoldIds) return new Set();
  return legalHoldIds instanceof Set ? legalHoldIds : new Set(legalHoldIds);
}

// Returns one of: "full" | "excerpt" | "purged".
// `now` is a timestamp (ms) so tests can be deterministic. Falls back to "full"
// when the ingest time is missing (safe default: keep rather than delete).
function computeRetentionState(item, now = Date.now(), legalHoldIds = []) {
  if (!item || item.id == null) return "purged";
  const hold = toHoldSet(legalHoldIds);
  if (hold.has(item.id)) return "full";
  const ingestedAt = item.ingestedAt || item.createdAt;
  const ingested = ingestedAt ? Date.parse(ingestedAt) : NaN;
  if (Number.isNaN(ingested)) return "full";
  const ageMs = now - ingested;
  const win = windowFor(item.retentionClass);
  if (ageMs < win.fullMs) return "full";
  if (win.roll === "excerpt") return "excerpt";
  return "purged";
}

// Truncate to a max word count, appending an ellipsis when cut. Used when a
// use-case item rolls from "full" to "excerpt" so only a short, attributed
// snippet is retained (per the news-fair-use cap).
function rollToExcerpt(text, maxWords = EXCERPT_MAX_WORDS) {
  if (!text || typeof text !== "string") return text || "";
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/);
  if (words.length <= maxWords) return trimmed;
  return words.slice(0, maxWords).join(" ") + " …";
}

module.exports = {
  YEAR_MS,
  DAY_MS,
  RETENTION_WINDOWS,
  DEFAULT_WINDOW,
  EXCERPT_MAX_WORDS,
  windowFor,
  computeRetentionState,
  rollToExcerpt,
};
