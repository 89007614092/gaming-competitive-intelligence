"use strict";
// Phase 4 — licence gate (lib/licenseGate.js) unit tests.
// The gate turns a content item's `licenseClass` into the concrete rules the
// rest of the app obeys. These tests pin the four classes and the `internal`
// switch so the governance behaviour can never silently regress.
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  applyLicenseGate,
  normalizeAttribution,
  LICENSE_LABELS,
  VALID_CLASSES,
  EXCERPT_MAX_WORDS,
} = require("../lib/licenseGate");

const LONG_TEXT = Array.from({ length: 400 }, (_, i) => `word${i}`).join(" ");

function makeItem(over = {}) {
  return {
    title: "Example Headline",
    url: "https://example.com/article",
    text: LONG_TEXT,
    body: LONG_TEXT,
    licenseClass: "open",
    attribution: {
      source: "example.com",
      title: "Example Headline",
      url: "https://example.com/article",
      retrievedAt: "2026-08-14T00:00:00.000Z",
      licenseClass: "open",
    },
    ...over,
  };
}

test("open class keeps full text and is not gated", () => {
  const out = applyLicenseGate(makeItem(), { internal: true });
  assert.strictEqual(out.gated, false);
  assert.strictEqual(out.text, LONG_TEXT);
  assert.strictEqual(out.body, LONG_TEXT);
  assert.ok(out.attribution && out.attribution.source === "example.com");
});

test("restricted class strips body and keeps only metadata + link + snippet", () => {
  const item = makeItem({
    licenseClass: "restricted",
    url: "https://paywalled.com/a",
    snippet: "A short snippet.",
    attribution: { source: "paywalled.com", url: "https://paywalled.com/a", licenseClass: "restricted" },
  });
  const out = applyLicenseGate(item, { internal: true });
  assert.strictEqual(out.gated, true);
  assert.strictEqual(out.gateReason, "restricted");
  assert.strictEqual(out.text, "");
  assert.strictEqual(out.body, "");
  assert.strictEqual(out.snippet, "A short snippet.");
  assert.strictEqual(out.link, "https://paywalled.com/a");
  assert.ok(out.attribution && out.attribution.licenseClass === "restricted");
});

test("news-fair-use keeps full text when internal", () => {
  const out = applyLicenseGate(makeItem({ licenseClass: "news-fair-use" }), { internal: true });
  assert.strictEqual(out.gated, false);
  assert.strictEqual(out.text.split(/\s+/).length, LONG_TEXT.split(/\s+/).length);
});

test("news-fair-use is capped to a 300-word excerpt when external", () => {
  const out = applyLicenseGate(makeItem({ licenseClass: "news-fair-use" }), { internal: false });
  assert.strictEqual(out.gated, true);
  assert.strictEqual(out.gateReason, "external-fair-use-excerpt");
  // The trailing " …" marker is not a content word, so count content only.
  const contentWords = out.text.split(/\s+/).filter((w) => w !== "…");
  assert.ok(contentWords.length <= EXCERPT_MAX_WORDS, "excerpt content must not exceed the cap");
  assert.ok(/…$/.test(out.text), "excerpt should be visibly truncated");
});

test("api-restricted keeps full text internally and is not gated", () => {
  const out = applyLicenseGate(makeItem({ licenseClass: "api-restricted" }), { internal: true });
  assert.strictEqual(out.gated, false);
  assert.strictEqual(out.text, LONG_TEXT);
});

test("missing/invalid licenseClass defaults to open (safe default)", () => {
  const noClass = applyLicenseGate(makeItem({ licenseClass: undefined }), { internal: true });
  assert.strictEqual(noClass.gated, false);
  const badClass = applyLicenseGate(makeItem({ licenseClass: "not-a-real-class" }), { internal: true });
  assert.strictEqual(badClass.gated, false);
});

test("does not mutate the input item", () => {
  const item = makeItem({ licenseClass: "restricted" });
  const before = JSON.stringify(item);
  applyLicenseGate(item, { internal: true });
  assert.strictEqual(JSON.stringify(item), before, "applyLicenseGate must be pure");
});

test("normalizeAttribution derives a host from the url when no attribution object", () => {
  const a = normalizeAttribution({ url: "https://deriv.example.org/x", title: "T", retrievedAt: "2026-08-14T00:00:00.000Z" });
  assert.strictEqual(a.source, "deriv.example.org");
  assert.strictEqual(a.title, "T");
  assert.strictEqual(a.licenseClass, "open");
});

test("exports the canonical licence labels and class list", () => {
  assert.deepStrictEqual(Object.keys(LICENSE_LABELS), VALID_CLASSES);
  assert.deepStrictEqual(VALID_CLASSES, ["open", "news-fair-use", "api-restricted", "restricted"]);
  assert.strictEqual(EXCERPT_MAX_WORDS, 300);
});
