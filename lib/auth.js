"use strict";

// ============================================================================
// lib/auth.js — minimal v1 accounts: Supabase Auth magic-link + allow-list gate
// ----------------------------------------------------------------------------
// Design goals (agreed 2026-08-26):
//   * Lock the whole web app behind email verification (fixes public Render
//     visibility). Magic-link email is sent by Supabase Auth, so no separate
//     email service is needed.
//   * ALLOWED_EMAILS = comma-separated allow-list → no public signup.
//   * Cookie session (HttpOnly / SameSite=Lax / Secure-on-HTTPS) verified in
//     Node. NO per-user Postgres tables and NO reliance on RLS — this sidesteps
//     the pg-superuser/RLS mismatch (our DB pool connects as `postgres`, which
//     bypasses RLS and makes auth.uid() null).
//   * Admin role derived from ADMIN_EMAILS; admin session also satisfies the
//     existing requireAdmin/requireEditor key checks (see server.js).
//
// Env contract (all optional — when AUTH_ENABLED is not "1" the whole module is
// inert and the app behaves exactly as before, fully public):
//   AUTH_ENABLED=1
//   SUPABASE_URL=https://xxxx.supabase.co
//   SUPABASE_ANON_KEY=eyJ...            # the anon key is PUBLIC by design
//   ALLOWED_EMAILS=alice@x.com,bob@x.com
//   ADMIN_EMAILS=alice@x.com           # defaults to ALLOWED_EMAILS when unset
// ============================================================================

const crypto = require("crypto");

// ---- Config ----------------------------------------------------------------
function toBool(v) {
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function splitList(raw) {
  return String(raw || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

const AUTH_ENABLED = toBool(process.env.AUTH_ENABLED);
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";
const ALLOWED_EMAILS = splitList(process.env.ALLOWED_EMAILS);
const ADMIN_EMAILS = splitList(process.env.ADMIN_EMAILS).length
  ? splitList(process.env.ADMIN_EMAILS)
  : ALLOWED_EMAILS.slice();

// `true` only when explicitly enabled AND the two Supabase values are present.
// Everything else treats auth as disabled and stays open.
function isAuthEnabled() {
  return AUTH_ENABLED && !!SUPABASE_URL && !!SUPABASE_ANON_KEY;
}

// Fail CLOSED: an empty allow-list means nobody may request a link.
function emailAllowed(email) {
  if (!email) return false;
  const e = String(email).trim().toLowerCase();
  if (ALLOWED_EMAILS.length === 0) return false;
  return ALLOWED_EMAILS.includes(e);
}

function roleForEmail(email) {
  if (!email) return "user";
  const e = String(email).trim().toLowerCase();
  return ADMIN_EMAILS.includes(e) ? "admin" : "user";
}

// ---- Cookie helpers --------------------------------------------------------
function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  if (!header) return [];
  return header
    .split(";")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const idx = c.indexOf("=");
      if (idx === -1) return { name: c, value: "" };
      return { name: c.slice(0, idx), value: decodeURIComponent(c.slice(idx + 1)) };
    });
}

function isHttps(req) {
  return (
    req.secure ||
    req.headers["x-forwarded-proto"] === "https" ||
    req.headers["x-forwarded-ssl"] === "on"
  );
}

function serializeCookie(name, value, opts) {
  opts = opts || {};
  let str = `${name}=${encodeURIComponent(value)}`;
  if (opts.maxAge != null) str += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.path) str += `; Path=${opts.path}`;
  if (opts.domain) str += `; Domain=${opts.domain}`;
  if (opts.expires) {
    str += `; Expires=${opts.expires instanceof Date ? opts.expires.toUTCString() : opts.expires}`;
  }
  if (opts.httpOnly !== false) str += "; HttpOnly";
  if (opts.secure) str += "; Secure";
  if (opts.sameSite) str += `; SameSite=${opts.sameSite}`;
  return str;
}

function applySetCookies(res, cookiesToSet, req) {
  const existing = res.getHeader("Set-Cookie");
  const arr = Array.isArray(existing) ? existing.slice() : existing ? [existing] : [];
  const secure = isHttps(req);
  for (const { name, value, options } of cookiesToSet) {
    const opts = Object.assign({}, options);
    // Force Secure on HTTPS (Render terminates TLS; anon cookie must be secure).
    if (secure) opts.secure = true;
    arr.push(serializeCookie(name, value, opts));
  }
  res.setHeader("Set-Cookie", arr);
}

// ---- Supabase SSR client (lazy + per-request; injectable for tests) ---------
let _mockClient = null; // test seam: when set, all calls use this instead

// Test-only: inject a fake Supabase server client.
function __setMockClientForTest(mock) {
  _mockClient = mock;
}

function getSupabaseServer(req, res) {
  if (_mockClient) return _mockClient;
  // Lazy require so the module loads (and node --check / pure tests run) even
  // before `npm install` has fetched @supabase/ssr on a fresh checkout.
  const { createServerClient } = require("@supabase/ssr");
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return parseCookies(req);
      },
      setAll(cookiesToSet) {
        applySetCookies(res, cookiesToSet, req);
      },
    },
  });
}

// ---- Public API ------------------------------------------------------------
// POST /api/auth/magic-link  { email }
// Sends a magic link only if the email is on the allow-list.
async function sendMagicLink(req, res) {
  if (!isAuthEnabled()) {
    return res.status(503).json({ error: "auth not configured" });
  }
  const email = (req.body && req.body.email) || "";
  if (!emailAllowed(email)) {
    // Same response shape as success to avoid enumerating the allow-list.
    return res.json({ ok: true, sent: false });
  }
  const origin = getRequestOrigin(req);
  const supabase = getSupabaseServer(req, res);
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: `${origin}/api/auth/callback` },
  });
  if (error) {
    console.warn("[auth] magic-link error:", error.message);
    return res.status(400).json({ error: error.message });
  }
  return res.json({ ok: true, sent: true });
}

// GET /api/auth/callback?code=...  exchanges the PKCE code for a session cookie
// and redirects into the app.
async function handleCallback(req, res) {
  if (!isAuthEnabled()) {
    return res.status(503).send("auth not configured");
  }
  const code = req.query && req.query.code;
  if (!code) return res.status(400).send("missing code");
  const supabase = getSupabaseServer(req, res);
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    console.warn("[auth] callback exchange error:", error.message);
    return res.status(400).send("authentication failed");
  }
  res.redirect("/");
}

// GET /api/auth/session  → { user: { email, role } } or 401
async function getSession(req, res) {
  if (!isAuthEnabled()) return res.status(401).json({ error: "auth disabled" });
  const user = await getUserFromRequest(req, res);
  if (!user) return res.status(401).json({ error: "unauthorized" });
  return res.json({ user: { email: user.email, role: roleForEmail(user.email), id: user.id } });
}

// POST /api/auth/logout  clears the session cookie.
async function logout(req, res) {
  if (!isAuthEnabled()) return res.status(503).json({ error: "auth not configured" });
  const supabase = getSupabaseServer(req, res);
  await supabase.auth.signOut();
  res.json({ ok: true });
}

// Verify the current session cookie; returns the Supabase user or null.
// Also attaches nothing — callers decide. Used by the gate middleware.
async function getUserFromRequest(req, res) {
  if (!isAuthEnabled()) return null;
  const supabase = getSupabaseServer(req, res);
  const { data, error } = await supabase.auth.getUser();
  if (error || !data || !data.user) return null;
  return data.user;
}

function getRequestOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.secure ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

// ---- Express gate middleware (env-gated) ------------------------------------
// When AUTH_ENABLED: every request needs a valid session except the auth
// endpoints, the login page, /healthz, and static assets (so the login page
// can load its CSS/JS). Unauthenticated API → 401 JSON; HTML → redirect /login.
const STATIC_EXT = [
  ".css", ".js", ".html", ".png", ".jpg", ".jpeg", ".gif", ".ico",
  ".svg", ".woff", ".woff2", ".ttf", ".eot", ".json", ".map", ".webmanifest",
];

function isStaticAsset(pathname) {
  const dot = pathname.lastIndexOf(".");
  if (dot === -1) return false;
  return STATIC_EXT.includes(pathname.slice(dot).toLowerCase());
}

function authGate(req, res, next) {
  if (!isAuthEnabled()) return next(); // auth disabled → fully open (legacy)

  const p = req.path || req.url.split("?")[0];

  // Always-allowed surfaces.
  if (p === "/healthz" || p.startsWith("/api/auth/") || p === "/login" || p === "/login.html") {
    return next();
  }
  // Static assets (CSS/JS/icons) must load even when logged out.
  if (isStaticAsset(p)) return next();

  // Verify session (needs res for cookie reads via SSR client).
  return getUserFromRequest(req, res)
    .then((user) => {
      if (user) {
        req.user = { email: user.email, role: roleForEmail(user.email), id: user.id };
        if (p === "/login") return res.redirect("/"); // already authed, go to app
        return next();
      }
      if (p.startsWith("/api/")) {
        return res.status(401).json({ error: "unauthorized" });
      }
      return res.redirect("/login");
    })
    .catch((err) => {
      console.warn("[auth] gate error:", err.message);
      if (p.startsWith("/api/")) return res.status(401).json({ error: "unauthorized" });
      return res.redirect("/login");
    });
}

module.exports = {
  isAuthEnabled,
  emailAllowed,
  roleForEmail,
  sendMagicLink,
  handleCallback,
  getSession,
  logout,
  getUserFromRequest,
  authGate,
  // test seams
  __setMockClientForTest,
  parseCookies,
  serializeCookie,
  getRequestOrigin,
};
