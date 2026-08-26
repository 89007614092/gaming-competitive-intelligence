"use strict";

// Security headers (helmet) regression test.
//
// Verifies that the app applies Content-Security-Policy (starting permissive:
// allows the single inline TMap config script + inline styles) plus the other
// baseline hardening headers. The headers are applied at the app level so they
// appear on every response, including static assets.

const { test, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("http");

const srv = require("../server");
const app = srv.app;

let server;
before(async () => {
  server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
});
after(() => new Promise((resolve) => server.close(resolve)));

function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.address().port, path, method: "GET" },
      (res) => { res.resume(); resolve(res); }
    );
    req.on("error", reject);
    req.end();
  });
}

test("helmet applies CSP + baseline hardening headers", async () => {
  const res = await get("/locales.js");
  const csp = res.headers["content-security-policy"];
  assert.ok(csp, "Content-Security-Policy header should be present");
  assert.ok(csp.includes("default-src 'self'"), "CSP should default to 'self'");
  assert.ok(csp.includes("script-src"), "CSP should define script-src");
  assert.ok(csp.includes("'unsafe-inline'"), "CSP should allow the inline TMap config script");
  assert.ok(csp.includes("style-src"), "CSP should define style-src");
  assert.ok(csp.includes("img-src"), "CSP should define img-src");
  assert.ok(csp.includes("frame-src 'none'"), "CSP should block framing");

  assert.equal(res.headers["x-content-type-options"], "nosniff", "X-Content-Type-Options should be nosniff");
  assert.ok(/DENY/i.test(res.headers["x-frame-options"] || ""), "X-Frame-Options should be DENY");
  assert.ok(res.headers["referrer-policy"], "Referrer-Policy should be set");
});

test("CSP allows same-origin scripts and https images (app assets + news images)", async () => {
  const res = await get("/locales.js");
  const csp = res.headers["content-security-policy"];
  assert.ok(csp.includes("script-src 'self'"), "script-src must allow 'self' (bundled app.js/locales.js)");
  assert.ok(csp.includes("img-src 'self' data: https:"), "img-src must allow https (external news images)");
});
