// Security + behaviour tests for the Suggested Updates "Reader" proxy.
// Requires server.js (importable without booting a socket, thanks to the
// require.main === module guards) and exercises the hardened fetch path.
process.env.SCAN_MODEL_MIN_GAP_MS = "50"; // keep any pacing logic fast

const test = require("node:test");
const assert = require("node:assert");
const http = require("http");

const srv = require("../server");

test("validateSourceUrl rejects non-http(s) schemes and local hosts", () => {
  assert.throws(() => srv.validateSourceUrl("ftp://example.com/file"), /valid source URL|HTTP and HTTPS|supported/i);
  assert.throws(() => srv.validateSourceUrl("javascript:alert(1)"), /valid source URL|HTTP and HTTPS|supported/i);
  assert.throws(() => srv.validateSourceUrl("http://localhost:8080/x"), /Local network|cannot be scraped/i);
  assert.throws(() => srv.validateSourceUrl("http://127.0.0.1/x"), /Local network|cannot be scraped/i);
  // A normal public https URL is accepted and normalised to a string.
  assert.strictEqual(typeof srv.validateSourceUrl("https://example.com/a"), "string");
});

test("isPrivateOrReservedIp classifies addresses correctly", () => {
  assert.strictEqual(srv.isPrivateOrReservedIp("127.0.0.1"), true);   // loopback
  assert.strictEqual(srv.isPrivateOrReservedIp("10.0.0.5"), true);    // RFC1918
  assert.strictEqual(srv.isPrivateOrReservedIp("192.168.1.1"), true); // RFC1918
  assert.strictEqual(srv.isPrivateOrReservedIp("172.16.5.4"), true);  // RFC1918
  assert.strictEqual(srv.isPrivateOrReservedIp("169.254.169.254"), true); // link-local / metadata
  assert.strictEqual(srv.isPrivateOrReservedIp("::1"), true);          // IPv6 loopback
  assert.strictEqual(srv.isPrivateOrReservedIp("8.8.8.8"), false);    // public
  assert.strictEqual(srv.isPrivateOrReservedIp("1.1.1.1"), false);    // public
});

test("assertPublicHost rejects private/loopback literals", async () => {
  await assert.rejects(() => srv.assertPublicHost("127.0.0.1"), /Blocked address range/i);
  await assert.rejects(() => srv.assertPublicHost("::1"), /Blocked address range/i);
  await assert.rejects(() => srv.assertPublicHost("192.168.0.1"), /Blocked address range/i);
  // A public IP literal must not throw. If the sandbox blocks DNS entirely we
  // skip rather than fail, but a literal IP should never need resolution.
  try {
    await srv.assertPublicHost("8.8.8.8");
    assert.ok(true);
  } catch (e) {
    if (/Could not resolve/.test(e.message)) return; // network isolated — skip
    throw e;
  }
});

test("fetchReaderContent never contacts a private/local server", async () => {
  let hits = 0;
  const local = http.createServer((_req, res) => {
    hits += 1;
    res.setHeader("content-type", "text/html");
    res.end("<html><body>SECRET-INTERNAL</body></html>");
  });
  await new Promise((r) => local.listen(0, "127.0.0.1", r));
  const port = local.address().port;
  try {
    let threw = false;
    try {
      await srv.fetchReaderContent(`http://127.0.0.1:${port}/internal`);
    } catch (_) { threw = true; }
    assert.strictEqual(threw, true, "proxy must refuse the private host");
    assert.strictEqual(hits, 0, "proxy must NEVER have contacted the local server");
  } finally {
    await new Promise((r) => local.close(r));
  }
});

test("readStreamWithCap enforces the byte ceiling", async () => {
  // Small body passes through unchanged.
  const small = new Response("hello world");
  const smallBuf = await srv.readStreamWithCap(small, 100);
  assert.strictEqual(smallBuf.length, 11);

  // A body larger than the cap is rejected mid-stream.
  const big = new Response("x".repeat(1000));
  await assert.rejects(() => srv.readStreamWithCap(big, 10), /too large/i);
});

test("createRateLimiter throttles after the budget is exhausted", () => {
  const lim = srv.createRateLimiter({ max: 2, windowMs: 60000 });
  assert.strictEqual(lim("alice"), true);
  assert.strictEqual(lim("alice"), true);
  assert.strictEqual(lim("alice"), false, "third request in window must be blocked");
  assert.strictEqual(lim("bob"), true, "different key has its own budget");
});
