"use strict";
// Where a patent deep-link points.
//
// The rule: send the reader to the office that PUBLISHES the document, because
// that link is the one that resolves. US publications go to the USPTO's own
// document server (the actual patent PDF); everything else goes to Espacenet.
//
// Why: Espacenet enforces a "Fair Use" policy against the browser, per IP. Users
// behind a shared corporate egress — or behind a security gateway that
// pre-fetches every link on a page — get
//   "This request has been rejected due to the violation of Fair Use policy 403"
// and never reach the patent. This is NOT the OPS fair-use cap: OPS is the
// token-authed API with its own quota, which is why /healthz can read healthy
// (failures:0, fairUse:false, tokenRequests > 0) while every click-through
// fails. Fixing it meant changing the link target, not the client.
//
// The USPTO endpoint takes the publication number WITHOUT the kind code:
//   US10685152B2     -> /10685152      (200, application/pdf)
//   US20160001181A1  -> /20160001181   (200, application/pdf)
// Appending the kind code (…/10685152B2) returns 404, so it must be stripped.

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const {
  splitPublicationNumber,
  usptoPdfUrl,
  patentUrl,
  espacenetUrl,
  USPTO_PDF_URL,
  ESPACENET_URL,
} = require("../lib/epoOps");

test("splitPublicationNumber separates country, number and kind code", () => {
  assert.deepStrictEqual(splitPublicationNumber("US10685152B2"), { country: "US", number: "10685152", kind: "B2" });
  assert.deepStrictEqual(splitPublicationNumber("US20160001181A1"), { country: "US", number: "20160001181", kind: "A1" });
  assert.deepStrictEqual(splitPublicationNumber("EP4123456A1"), { country: "EP", number: "4123456", kind: "A1" });
});

test("splitPublicationNumber returns null rather than guessing at malformed input", () => {
  // A wrong guess would build a link that cannot resolve, which is worse than
  // falling back to Espacenet.
  for (const bad of ["", null, undefined, "10685152", "US 10685152 B2", "patent"]) {
    assert.strictEqual(splitPublicationNumber(bad), null, `expected null for ${String(bad)}`);
  }
});

test("US granted publications deep-link to the USPTO PDF without the kind code", () => {
  // The kind code is what 404s. Verified live for every US number in data/.
  assert.strictEqual(usptoPdfUrl("US10685152B2"), `${USPTO_PDF_URL}10685152`);
  assert.ok(!usptoPdfUrl("US10685152B2").includes("B2"));
});

test("US pre-grant publications deep-link to the USPTO PDF too", () => {
  // US20160001181A1 is a pre-grant publication: 11 digits, no kind code.
  assert.strictEqual(usptoPdfUrl("US20160001181A1"), `${USPTO_PDF_URL}20160001181`);
});

test("non-US publications stay on Espacenet — there is no equivalent public document server", () => {
  for (const pn of ["EP4123456A1", "WO2020123456A1", "CN112233445A", "JP2020123456A"]) {
    assert.strictEqual(usptoPdfUrl(pn), "", `${pn} must not get a USPTO link`);
    assert.strictEqual(patentUrl(pn), espacenetUrl(pn), `${pn} must fall back to Espacenet`);
  }
});

test("patentUrl encodes the Espacenet number so it survives the query string", () => {
  assert.strictEqual(patentUrl("EP4123456A1"), `${ESPACENET_URL}EP4123456A1`);
});

test("patentUrl falls back to Espacenet for an unparseable number", () => {
  // Still truthy, so the card renders a link; Espacenet's own search is the
  // honest destination when we cannot identify the office.
  assert.strictEqual(patentUrl(""), "");
  assert.strictEqual(patentUrl("junk"), espacenetUrl("junk"));
});

test("every curated US patent link in data/ is USPTO, not Espacenet", () => {
  const files = fs.readdirSync(path.join(ROOT, "data")).filter((f) => f.endsWith(".json"));
  const espacenetUs = [];
  let uspto = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(ROOT, "data", f), "utf8");
    espacenetUs.push(...(text.match(/https:\/\/worldwide\.espacenet\.com\/patent\/search\?q=pn%3DUS[^"\s)]*/g) || []));
    uspto += (text.match(/https:\/\/image-ppubs\.uspto\.gov\/dirsearch-public\/print\/downloadPdf\/\d+/g) || []).length;
  }
  assert.deepStrictEqual(espacenetUs, [], "US numbers must not link to Espacenet — it 403s the user");
  assert.ok(uspto >= 14, `expected the curated US patent links on USPTO, found ${uspto}`);
});

test("the card opens the document, and keeps Espacenet as the EPO record", () => {
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  assert.ok(/p\.documentUrl \|\| p\.espacenetUrl/.test(app), "the heading must prefer the resolvable document link");
  assert.ok(/class="patent-espacenet-link"/.test(app), "the EPO record link must survive");
  const ops = fs.readFileSync(path.join(ROOT, "lib", "epoOps.js"), "utf8");
  assert.ok(/documentUrl: patentUrl\(pn\)/.test(ops), "each normalised patent must carry documentUrl");
});

test("both dictionaries name the USPTO target", () => {
  const { LOCALES } = require("../public/locales.js");
  assert.ok(LOCALES.en["patents.usptoFullText"] != null);
  assert.ok(LOCALES["zh-CN"]["patents.usptoFullText"] != null);
});
