#!/usr/bin/env node
'use strict';

/*
 * scripts/migrate-kb-translations.js — create the translation-cache tables.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS), so it is safe to run repeatedly and
 * is also invoked automatically at boot by server.js (ensureKbTranslationsTable)
 * — this script is the standalone/CI escape hatch.
 *
 * Run:  DATABASE_URL=... node scripts/migrate-kb-translations.js
 */

const { Client } = require("pg");

const DDL = `
  CREATE TABLE IF NOT EXISTS kb_translations (
    dataset_id     TEXT NOT NULL,
    lang           TEXT NOT NULL,
    content_hash   TEXT NOT NULL,
    translated_json JSONB NOT NULL,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (dataset_id, lang)
  );
  CREATE TABLE IF NOT EXISTS news_translations (
    article_id       TEXT NOT NULL,
    lang             TEXT NOT NULL,
    content_hash     TEXT NOT NULL,
    translated_summary TEXT NOT NULL,
    saved            BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (article_id, lang)
  );
  CREATE INDEX IF NOT EXISTS idx_news_translations_retention
    ON news_translations (saved, updated_at);
`;

// Render free-tier has no IPv6 egress; pin to the A record like lib/dbPool.
function getFamily() {
  const raw = process.env.PG_FAMILY;
  if (raw === undefined || raw === "") return 4;
  const f = Number(raw);
  if (Number.isNaN(f) || (f !== 4 && f !== 6)) return 4;
  return f;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set — aborting.");
    process.exit(1);
  }
  const client = new Client({ connectionString: url, family: getFamily() });
  await client.connect();
  try {
    await client.query(DDL);
    console.log("kb_translations + news_translations are ready (idempotent).");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
