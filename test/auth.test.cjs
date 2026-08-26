"use strict";

// Accounts v1 auth tests. Env is set BEFORE requiring lib/auth so the module
// loads in "enabled" mode for this isolated test process.
process.env.AUTH_ENABLED = "1";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_ANON_KEY = "public-anon-key";
process.env.ALLOWED_EMAILS = "alice@x.com,bob@x.com";
process.env.ADMIN_EMAILS = "alice@x.com";

const test = require("node:test");
const assert = require("node:assert");
const auth = require("../lib/auth");

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    _redirect: null,
    _cookies: [],
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    send(o) { this.body = o; return this; },
    redirect(u) { this._redirect = u; return this; },
    getHeader() { return undefined; },
    setHeader() {},
  };
}

function runGate(req, res) {
  return new Promise((resolve) => {
    let nextCalled = false;
    const ret = auth.authGate(req, res, () => { nextCalled = true; });
    Promise.resolve(ret).then(() => resolve({ nextCalled }));
  });
}

test("emailAllowed: allow-list honoured, case-insensitive, empty = closed", () => {
  assert.equal(auth.emailAllowed("alice@x.com"), true);
  assert.equal(auth.emailAllowed("BOB@X.COM"), true);
  assert.equal(auth.emailAllowed("eve@x.com"), false);
  assert.equal(auth.emailAllowed(""), false);
});

test("roleForEmail: admin vs user derivation", () => {
  assert.equal(auth.roleForEmail("alice@x.com"), "admin");
  assert.equal(auth.roleForEmail("bob@x.com"), "user");
  assert.equal(auth.roleForEmail(""), "user");
});

test("roleForEmailAsync: env-listed admin wins without a pool", async () => {
  assert.equal(await auth.roleForEmailAsync("alice@x.com"), "admin");
});

test("roleForEmailAsync: table is_admin = TRUE grants admin", async () => {
  auth.__setPool({ query: async () => ({ rows: [{ is_admin: true }] }) });
  try {
    assert.equal(await auth.roleForEmailAsync("carol@corp.com"), "admin");
  } finally {
    auth.__setPool(null);
  }
});

test("roleForEmailAsync: table is_admin = FALSE is a plain user", async () => {
  auth.__setPool({ query: async () => ({ rows: [{ is_admin: false }] }) });
  try {
    assert.equal(await auth.roleForEmailAsync("carol@corp.com"), "user");
  } finally {
    auth.__setPool(null);
  }
});

test("roleForEmailAsync: DB error fails closed (no admin promotion)", async () => {
  auth.__setPool({ query: async () => { throw new Error("db down"); } });
  try {
    assert.equal(await auth.roleForEmailAsync("carol@corp.com"), "user");
  } finally {
    auth.__setPool(null);
  }
});

test("isAuthEnabled true when env configured", () => {
  assert.equal(auth.isAuthEnabled(), true);
});

test("sendMagicLink calls Supabase only for allow-listed email", async () => {
  let call = null;
  auth.__setMockClientForTest({
    auth: {
      signInWithOtp: async ({ email, options }) => { call = { email, options }; return { error: null }; },
    },
  });
  const req = { body: { email: "bob@x.com" }, headers: { host: "localhost:3000" } };
  const res = makeRes();
  await auth.sendMagicLink(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sent, true);
  assert.equal(call.email, "bob@x.com");
  assert.match(call.options.emailRedirectTo, /https?:\/\/[^/]+\/api\/auth\/callback$/);
});

test("sendMagicLink never reveals non-allowlisted emails (no enumeration)", async () => {
  let calls = 0;
  auth.__setMockClientForTest({
    auth: { signInWithOtp: async () => { calls += 1; return { error: null }; } },
  });
  const req = { body: { email: "eve@x.com" }, headers: { host: "localhost:3000" } };
  const res = makeRes();
  await auth.sendMagicLink(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sent, false);
  assert.equal(calls, 0);
});

test("sendMagicLink uses signInWithPassword when a password is supplied", async () => {
  let otp = 0, pw = null;
  auth.__setMockClientForTest({
    auth: {
      signInWithPassword: async ({ email, password }) => { pw = { email, password }; return { error: null }; },
      signInWithOtp: async () => { otp += 1; return { error: null }; },
    },
  });
  const req = { body: { email: "bob@x.com", password: "hunter2" }, headers: { host: "localhost:3000" } };
  const res = makeRes();
  await auth.sendMagicLink(req, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.sent, false);
  assert.equal(res.body.redirect, "/");
  assert.equal(pw.email, "bob@x.com");
  assert.equal(pw.password, "hunter2");
  assert.equal(otp, 0);
});

test("sendMagicLink consults the allowed_emails table for emails not in env", async () => {
  let otpEmail = null;
  auth.__setMockClientForTest({
    auth: { signInWithOtp: async ({ email }) => { otpEmail = email; return { error: null }; } },
  });
  auth.__setPool({ query: async () => ({ rows: [{ "1": 1 }] }) });
  try {
    const req = { body: { email: "dbuser@corp.com" }, headers: { host: "localhost:3000" } };
    const res = makeRes();
    await auth.sendMagicLink(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.sent, true);
    assert.equal(otpEmail, "dbuser@corp.com");
  } finally {
    auth.__setPool(null);
  }
});

test("sendMagicLink fails closed when the allowed_emails lookup throws", async () => {
  let calls = 0;
  auth.__setMockClientForTest({
    auth: { signInWithOtp: async () => { calls += 1; return { error: null }; } },
  });
  auth.__setPool({ query: async () => { throw new Error("db down"); } });
  try {
    const req = { body: { email: "dbuser@corp.com" }, headers: { host: "localhost:3000" } };
    const res = makeRes();
    await auth.sendMagicLink(req, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.sent, false);
    assert.equal(calls, 0); // never reached Supabase
  } finally {
    auth.__setPool(null);
  }
});

test("authGate: 401 JSON for unauthed API when enabled", async () => {
  auth.__setMockClientForTest({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } });
  const res = makeRes();
  const { nextCalled } = await runGate({ path: "/api/knowledge", headers: {} }, res);
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test("authGate: lets /api/auth/callback and /login through without a session", async () => {
  const res1 = makeRes();
  const a = await runGate({ path: "/api/auth/callback", headers: {} }, res1);
  assert.equal(a.nextCalled, true);

  const res2 = makeRes();
  const b = await runGate({ path: "/login", headers: {} }, res2);
  assert.equal(b.nextCalled, true);
});

test("authGate: sets req.user and passes authed requests; admin role derived", async () => {
  auth.__setMockClientForTest({
    auth: { getUser: async () => ({ data: { user: { email: "alice@x.com", id: "u1" } }, error: null }) },
  });
  const req = { path: "/api/knowledge", headers: {} };
  const res = makeRes();
  const { nextCalled } = await runGate(req, res);
  assert.equal(nextCalled, true);
  assert.equal(req.user.email, "alice@x.com");
  assert.equal(req.user.role, "admin");
});

test("authGate: static assets pass without a session", async () => {
  const res = makeRes();
  const { nextCalled } = await runGate({ path: "/styles.css", headers: {} }, res);
  assert.equal(nextCalled, true);
});

test("serializeCookie builds flags correctly", () => {
  const c = auth.serializeCookie("sb", "v", { maxAge: 100, path: "/", httpOnly: true, secure: true, sameSite: "Lax" });
  assert.match(c, /^sb=v/);
  assert.match(c, /Max-Age=100/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
});
