// config.js — centralised operational tunables for the server.
//
// Why this file exists:
//   - Every configurable knob is discoverable in ONE place (mirrored in
//     .env.example), instead of being scattered as ad-hoc `process.env` reads
//     across server.js.
//   - Reading process.env in a single module means a test harness can `require`
//     this module (and server.js) WITHOUT any side effects (no server boot, no
//     scheduled scans) — see the `require.main === module` guards in server.js.
//
// Semantics: env vars are typed once here. `num()` returns the fallback for an
// unset/empty/env-invalid value, so callers never re-implement "|| default".

const num = (raw, fallback) => {
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
};

module.exports = {
  // --- External search provider (used by /api/news + gaming-trends search) ---
  TAVILY_API_KEY: process.env.TAVILY_API_KEY || "",
  // Normalised once here so callers never re-lowercase/trim. "jina" is default.
  // NOTE: this selects the URL-RESOLVER provider (Google-News redirect -> real
  // publisher). It is NOT the web-search chain — see WEB_SEARCH_CHAIN below.
  SEARCH_PROVIDER: (process.env.SEARCH_PROVIDER || "jina").toLowerCase().trim(),
  JINA_API_KEY: process.env.JINA_API_KEY || "",

  // --- Web-search fallback chain (lib/searchProvider.js) ---
  // Order in which providers are tried for /api/search and Q&A web evidence.
  // Tavily was the only external dependency with no fallback; this chain removes
  // that single point of failure. Unknown names are ignored, so a typo cannot
  // take search offline. Default: tavily -> brave -> jina (jina is keyless).
  WEB_SEARCH_CHAIN: (process.env.WEB_SEARCH_CHAIN || "tavily,brave,jina").toLowerCase().trim(),
  // Brave Search API — official, free tier ~2,000 queries/month. Optional: when
  // unset, Brave is simply skipped and the chain falls through to Jina.
  BRAVE_API_KEY: process.env.BRAVE_API_KEY || "",

  // --- Scan-lane pacing / quota (free-tier OpenRouter, ~50 req/day ceiling) ---
  // Min spacing between two scan model calls. This is a PROCESS-GLOBAL slot
  // (see paceScanModelCall), NOT per-scan: 4s => 15 calls/min, safely under the
  // 20 RPM ceiling that was tripping the 429 bursts.
  SCAN_MODEL_MIN_GAP_MS: num(process.env.SCAN_MODEL_MIN_GAP_MS, 4000),
  // Max model calls a single scan run may make. Unfinished proposals simply roll
  // forward to the next run; this is the load-bearing cap because it is enforced
  // in-process (the daily counter can reset on Render's ephemeral filesystem).
  SCAN_CALLS_PER_RUN_CAP: num(process.env.SCAN_CALLS_PER_RUN_CAP, 8),
  // Max scan model calls per UTC day. Persisted in source-state, rolls over at
  // UTC midnight. 35 leaves headroom under the 50/day free-tier ceiling.
  SCAN_DAILY_CALL_BUDGET: num(process.env.SCAN_DAILY_CALL_BUDGET, 35),
  // Retries per proposal when a single call 429s with a short Retry-After.
  SCAN_RETRY_CAP: num(process.env.SCAN_RETRY_CAP, 3),
  // Short per-proposal backoff after a 429 (NOT the engine's full cooldown), so
  // the next scan retries that proposal much sooner instead of waiting 20 min.
  SCAN_PROPOSAL_BACKOFF_MS: num(process.env.SCAN_PROPOSAL_BACKOFF_MS, 45 * 60 * 1000),

  // --- Scan scheduler ---
  // How often the scan loop wakes. 60 min (was 5 min): at 5 min the theoretical
  // ceiling was thousands of calls/day against a 35/day allowance.
  SOURCE_SCAN_TICK_MS: num(process.env.SOURCE_SCAN_TICK_MS, 60 * 60 * 1000),
  // Skip the boot scan if the last scan was within this window. Render's free
  // tier spins the container down when idle, so every wake is a fresh process;
  // without this guard a restart shortly after a scan would repeat it.
  BOOT_SCAN_MIN_GAP_MS: num(process.env.BOOT_SCAN_MIN_GAP_MS, 60 * 60 * 1000),

  // --- News refresh scheduler (Thread B) ---
  // How often the server proactively refreshes the default news selection so the
  // feed stays "live" on a clock even with no visitors. The refresh is a keyless
  // Google/Bing RSS fan-out (cheap, no AI tokens). 5 min default. Throttle this
  // down on a tight budget.
  NEWS_CRON_MS: num(process.env.NEWS_CRON_MS, 5 * 60 * 1000),

  // --- Server ---
  PORT: num(process.env.PORT, 3000),
};
