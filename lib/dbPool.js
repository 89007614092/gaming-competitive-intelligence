"use strict";

// Shared Postgres pool factory — single source of truth for connection options.
//
// Forces IPv4 (family: 4) by default. Render free-tier containers have no IPv6
// egress route, so a dual-stack Supabase host that resolves to AAAA would fail
// with ENETUNREACH before TLS even starts. Pinning to the A record removes that
// intermittent boot-time failure.
//
// Override with PG_FAMILY (4 or 6) if your host/infra changes addressing — no
// code change or redeploy required.

function getFamily() {
  const raw = process.env.PG_FAMILY;
  if (raw === undefined || raw === "") return 4;
  const f = Number(raw);
  if (Number.isNaN(f) || (f !== 4 && f !== 6)) return 4;
  return f;
}

// pg: the required "pg" module (caller guards its presence).
// connectionString: DATABASE_URL.
// opts.max: pool size (default 5).
function makePool(pg, connectionString, { max = 5 } = {}) {
  if (!pg || !connectionString) return null;
  return new pg.Pool({ connectionString, max, family: getFamily() });
}

module.exports = { makePool, getFamily };
