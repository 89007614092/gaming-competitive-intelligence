// Phase 4 split-reader: SSRF guard chain + size cap + rate limiter.
// No external network is required; the abuse case stands up a LOCAL server on
// 127.0.0.1 and asserts the proxy refuses to contact it.
const assert = require("assert");
const { test } = require("node:test");
const http = require("http");
const { ReadableStream } = require("stream/web");
const srv = require("../server");

const { validateSourceUrl, assertPublicHost, isPrivateOrReservedIp, fetchReaderContent, readStreamWithCap, createRateLimiter } = srv;

test("validateSourceUrl: rejects non-http(s) and local/private hosts", () => {
  for (const bad of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "javascript:alert(1)",
    "gopher://127.0.0.1:6379/",
    "http://localhost/article",
    "http://127.0.0.1/x",
    "http://0.0.0.0/x",
    "http://10.0.0.5/x",
    "http://192.168.1.1/x",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::1]/x",
  ]) {
    assert.throws(() => validateSourceUrl(bad), new RegExp("."), `should reject: ${bad}`);
  }
  // A normal public URL is accepted and returned as a string.
  assert.strictEqual(typeof validateSourceUrl("https://www.bbc.co.uk/news/article"), "string");
});

test("isPrivateOrReservedIp: classifies addresses correctly", () => {
  for (const priv of ["127.0.0.1", "10.0.0.1", "172.16.5.4", "192.168.0.1", "169.254.169.254", "::1", "fc00::1"]) {
    assert.ok(isPrivateOrReservedIp(priv), `expected private: ${priv}`);
  }
  for (const pub of ["8.8.8.8", "1.1.1.1", "203.0.113.5", "::ffff:8.8.8.8"]) {
    assert.ok(!isPrivateOrReservedIp(pub), `expected public: ${pub}`);
  }
});

test("assertPublicHost: blocks private/loopback literals and resolves public", async () => {
  for (const host of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "localhost"]) {
    await assert.rejects(() => assertPublicHost(host), /Blocked address range|Could not resolve/);
  }
  // A genuine public hostname must NOT be flagged as a blocked range (idempotent
  // with or without network — we only forbid the "Blocked address range" path).
  try {
    await assertPublicHost("example.com");
  } catch (e) {
    assert.ok(!/Blocked address range/.test(e.message), "public host must not be blocked");
  }
});

test("fetchReaderContent: never contacts a local server (SSRF abuse case)", async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.end("<html><body>secret internal data</body></html>");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try {
    await assert.rejects(() => fetchReaderContent(`http://127.0.0.1:${port}/`), /Local network|cannot be scraped/);
    await assert.rejects(() => fetchReaderContent(`http://localhost:${port}/`), /Local network|cannot be scraped/);
    await assert.rejects(() => fetchReaderContent(`http://10.255.255.1:9/`), /private|Local/);
    assert.strictEqual(hits, 0, "the local server must never have been contacted");
  } finally {
    await new Promise(r => server.close(r));
  }
});

test("readStreamWithCap: enforces the byte ceiling", async () => {
  const big = [];
  for (let i = 0; i < 200; i++) big.push(new Uint8Array(1000)); // 200 KB
  const over = { body: new ReadableStream({ pull(c) { if (big.length) c.enqueue(big.shift()); else c.close(); } }) };
  await assert.rejects(() => readStreamWithCap(over, 5000), /too large/i);

  const small = [new Uint8Array(Buffer.from("hello ")), new Uint8Array(Buffer.from("world"))];
  const ok = { body: new ReadableStream({ pull(c) { if (small.length) c.enqueue(small.shift()); else c.close(); } }) };
  const text = await readStreamWithCap(ok, 5000);
  assert.strictEqual(text, "hello world");
});

test("createRateLimiter: throttles after the window budget", async () => {
  const lim = createRateLimiter({ windowMs: 50, max: 3 });
  assert.strictEqual(lim.limit("ip"), true);
  assert.strictEqual(lim.limit("ip"), true);
  assert.strictEqual(lim.limit("ip"), true);
  assert.strictEqual(lim.limit("ip"), false, "4th call in window is blocked");
  assert.strictEqual(lim.limit("other"), true, "different key has its own budget");
  await new Promise(r => setTimeout(r, 70));
  assert.strictEqual(lim.limit("ip"), true, "budget resets after the window");
});
