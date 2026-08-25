#!/usr/bin/env node
'use strict';

/*
 * scripts/migrate-patents.js — create the shared `patents` table.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS). The patents feed is shared intel
 * (futureofgaming.com patent reports), so this table is global — NO Row-Level
 * Security, mirroring datasets/sources/proposed_changes. The app also
 * self-heals this table at boot, so running this script is optional.
 *
 * Usage: node scripts/migrate-patents.js
 */

const datasets = require('../lib/datasets');

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
  CREATE INDEX IF NOT EXISTS idx_patents_published ON patents (published_date DESC);
  CREATE INDEX IF NOT EXISTS idx_patents_kb ON patents (kb_company);
`;

async function main() {
  const pool = datasets.getDbPool();
  if (!pool) {
    console.error('No database pool available (DATABASE_URL unset). Set DATABASE_URL and retry.');
    process.exit(1);
  }
  await pool.query(DDL);
  console.log('patents table ready (idempotent).');
  process.exit(0);
}

main().catch((e) => {
  console.error('Migration failed:', e.message);
  process.exit(1);
});
