"use strict";

// Governor for background patent warming.
//
// The measured budget is small: OPS reported `search=green:5` — about five
// searches in flight. A monthly warm of the 24 technology chips is only 24
// searches, which is nothing over a month. So this is NOT a rationer; **it is a
// pacer.**
//
// The failure it exists to prevent: 24 searches issued back to back against 5 in
// flight produces roughly 19 x HTTP 403, and two failures open the circuit
// breaker — which short-circuits EVERY OPS call, so a background job would take
// interactive search down with it. Burst, not volume, is the risk.
//
// Consequently:
//   - ONE search per tick, always. A burst is impossible by construction.
//   - The gate is the header OPS just gave us, never a hard-coded rate. The
//     window length is never stated in the header, so any constant would be a
//     guess; colour and remaining rate are OPS's own accounting.
//   - Unknown means skip. We never spend on a guess.
//   - `reserve` is what we refuse to spend, so warming cannot leave an
//     interactive user with nothing.

const { searchBudget } = require("./epoOps");

const DEFAULTS = {
  enabled: false,          // ship dark: wiring exists, nothing runs until enabled
  reserve: 2,
  tickMs: 60 * 1000,
  sampleLimit: 10,         // small: the weekly fair-use cap is measured in bytes
  backoffMs: 60 * 1000,
  backoffMaxMs: 30 * 60 * 1000,
};

function createPatentWarmer(opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const now = typeof o.now === "function" ? o.now : () => Date.now();
  const log = typeof o.log === "function" ? o.log : () => {};
  const chips = Array.isArray(o.chips) ? o.chips : [];

  let cursor = 0;
  let running = false;
  let backoffUntil = 0;
  let backoffMs = o.backoffMs;

  const state = {
    enabled: !!o.enabled,
    lastTickAt: null,
    lastChip: null,
    lastBudget: null,
    lastSkipReason: null,
    backoffUntil: null,
    warmed: 0,
    skipped: 0,
  };

  // Read what OPS most recently told us, plus the client's own latches.
  function readBudget() {
    const st = o.epoClient && typeof o.epoClient.status === "function" ? o.epoClient.status() : {};
    // A weekly fair-use block is not something to pace around — stop entirely.
    if (st.fairUse) return { allowed: false, reason: "fair-use", colour: null, rate: null };
    if (st.circuitOpen) return { allowed: false, reason: "circuit-open", colour: null, rate: null };
    if (st.throttled) return { allowed: false, reason: "throttled", colour: null, rate: null };
    const b = searchBudget(st.throttlingControl, o.reserve);
    return { allowed: b.allowed, reason: b.reason || null, colour: b.colour, rate: b.rate };
  }

  function skip(reason) {
    state.skipped += 1;
    state.lastSkipReason = reason;
    return { ran: false, reason };
  }

  // Round-robin by default so every chip gets a turn; the caller may pass
  // `next` to order by staleness instead.
  function pick() {
    if (typeof o.next === "function") return o.next(chips, now());
    if (!chips.length) return null;
    const chip = chips[cursor % chips.length];
    cursor = (cursor + 1) % chips.length;
    return chip;
  }

  async function tick() {
    const t = now();
    state.lastTickAt = new Date(t).toISOString();
    if (!state.enabled) return skip("disabled");
    if (running) return skip("busy");
    if (t < backoffUntil) return skip("backoff");

    const budget = readBudget();
    state.lastBudget = { colour: budget.colour, rate: budget.rate };
    if (!budget.allowed) return skip(budget.reason || "budget");

    // Claim the slot BEFORE any await. Setting it after `pick()` left a window
    // where a second tick saw running=false and started its own search — which
    // is precisely the burst this governor exists to prevent.
    running = true;
    let chip = null; // hoisted: the catch block names it in the log line
    try {
      // Awaited so the caller can order by staleness, which needs a cache read.
      chip = await pick();
      if (!chip) return skip("nothing-to-warm");
      const row = await o.warm(chip);
      state.warmed += 1;
      state.lastChip = chip.id || chip.code || null;
      state.lastSkipReason = null;
      backoffMs = o.backoffMs; // a clean run resets the ramp
      return { ran: true, chip: state.lastChip, row };
    } catch (err) {
      const code = (err && err.code) || "error";
      backoffUntil = t + backoffMs;
      backoffMs = Math.min(backoffMs * 2, o.backoffMaxMs);
      state.lastSkipReason = code;
      log(`[patent-warm] ${chip.id || chip.code} failed (${code}) — backing off ${Math.round(backoffMs / 1000)}s`);
      return { ran: false, reason: code, error: err };
    } finally {
      running = false;
    }
  }

  function status() {
    const t = now();
    return {
      ...state,
      backoffUntil: backoffUntil > t ? new Date(backoffUntil).toISOString() : null,
      chips: chips.length,
      tickMs: o.tickMs,
      reserve: o.reserve,
    };
  }

  return { tick, status, readBudget, setEnabled: (v) => { state.enabled = !!v; } };
}

// Turn a cached warm row into what the UI shows.
//
// The honesty invariant lives here: the competitor figure is a share OF THE
// SAMPLE WE LOOKED AT, never of the whole corpus. "9 of the 10 most recent" is
// true and checkable; "9% of filings" would be a fabrication drawn from ten
// documents. So `matched` is clamped to `sampleSize` — and if no sample was
// drawn, there is no competitor signal to show at all.
function describeChipRow(chip, cached, names = new Map()) {
  if (!cached) return null;
  const sampleSize = Math.max(0, Number(cached.sampleSize) || 0);
  const competitors = [];
  let hits = 0;
  for (const [id, n] of Object.entries(cached.competitors || {})) {
    const v = Number(n) || 0;
    if (v <= 0) continue;
    hits += v;
    competitors.push({ id, name: names.get(id) || id, hits: v });
  }
  competitors.sort((a, b) => b.hits - a.hits);
  // One patent can match two companies, so the sum can exceed the sample.
  const claimed = cached.matched != null ? Number(cached.matched) : hits;
  const matched = Math.min(Math.max(0, claimed || 0), sampleSize);
  return {
    id: chip.id,
    label: chip.label || chip.id,
    group: chip.group || null,
    count: Math.max(0, Number(cached.count) || 0),
    sampleSize,
    matched,
    competitors,
    observedAt: cached.observedAt || null,
  };
}

module.exports = { createPatentWarmer, describeChipRow, WARM_DEFAULTS: DEFAULTS };
