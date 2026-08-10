#!/usr/bin/env node
'use strict';

// Reads the JSON emitted by /healthz, persists a "stuck streak" across
// scheduled runs via a state file (managed by actions/cache in the workflow),
// and only escalates after the warning persists for STREAK_THRESHOLD pings.
// Read-only: never triggers a scan, so it costs zero model-quota.

const fs = require('fs');
const path = require('path');

const WS = process.env.GITHUB_WORKSPACE || process.cwd();
const bodyPath = path.join(WS, 'healthz-body.json');
const statePath = path.join(WS, 'health-streak.json');
const webhook = process.env.HEALTH_WEBHOOK_URL || '';
const threshold = Number(process.env.STREAK_THRESHOLD || '3');

function loadJSON(p, fb) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fb;
  }
}

async function postMsg(text) {
  try {
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, content: text }), // text=Slack, content=Discord
    });
    console.log('webhook posted:', r.status);
  } catch (e) {
    console.log('webhook error:', e.message);
  }
}

(async () => {
  const h = loadJSON(bodyPath, null);
  if (!h || typeof h !== 'object') {
    console.log('::error::could not parse /healthz body');
    return;
  }
  console.log('healthz:', JSON.stringify(h));

  const stuck = h.stuckRateLimitedProposals ?? 0;
  const res = h.resolver || {};
  const rate = typeof res.successRatePct === 'number' ? res.successRatePct : null;
  const sb = h.scanBudget || {};
  const budgetExhausted =
    typeof sb.used === 'number' && typeof sb.limit === 'number' ? sb.used >= sb.limit : false;

  const warns = [];
  if (stuck > 0) warns.push(`stuckRateLimitedProposals=${stuck} (enrichment backlog not clearing)`);
  if (rate !== null && rate < 50) warns.push(`resolver.successRatePct=${rate}% (Google News resolver degraded)`);
  if (budgetExhausted) warns.push(`scanBudget ${sb.used}/${sb.limit} exhausted`);

  const prev = loadJSON(statePath, { stuckStreak: 0 });
  const prevStreak = Number(prev.stuckStreak || 0);
  const prevEscalated = prevStreak >= threshold;

  // A single stuck reading mid-scan is normal; persistence is the real signal.
  const streak = warns.length > 0 ? prevStreak + 1 : 0;
  fs.writeFileSync(statePath, JSON.stringify({ stuckStreak: streak, lastRun: new Date().toISOString() }));

  if (warns.length === 0) {
    console.log('::notice::health diagnostics OK');
    if (prevEscalated) {
      console.log('::notice::health recovered (stuck streak cleared)');
      if (webhook) await postMsg('✅ Gaming CI health recovered: stuck enrichment backlog cleared.');
    }
    return;
  }

  if (streak < threshold) {
    console.log(`::notice::health warning (watching ${streak}/${threshold}): ${warns.join(' | ')}`);
    return;
  }

  // Persistent: escalate as a warning annotation + (optional) webhook push.
  console.log(`::warning::${warns.join(' | ')} (persistent ${streak} consecutive pings)`);
  if (webhook && !prevEscalated) {
    await postMsg('⚠️ Gaming CI health alert (persistent): ' + warns.join('; '));
  }
})();
