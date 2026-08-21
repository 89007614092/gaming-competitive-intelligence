"use strict";

// PR #2 — web evidence cost controls: pure helpers.
//   localEvidenceCovers: B1 skip-when-KB-covers decision.
//   citedWebIds: B2 which [W#] the model actually cited (so only those get a
//                full-text fetch).

const test = require("node:test");
const assert = require("node:assert");
const { localEvidenceCovers, citedWebIds } = require("../server");

test("localEvidenceCovers — covers when local evidence matches the question", () => {
  const local = [{ title: "AI procurement guidance", text: "Gaming studios must document AI procurement under new guidance." }];
  assert.strictEqual(localEvidenceCovers("What is the guidance on AI procurement for gaming studios?", local), true);
});

test("localEvidenceCovers — does NOT cover when a recency term is present", () => {
  const local = [{ title: "AI procurement guidance", text: "Gaming studios must document AI procurement under new guidance." }];
  assert.strictEqual(localEvidenceCovers("What is the latest guidance on AI procurement?", local), false);
});

test("localEvidenceCovers — does NOT cover when the question is off-topic", () => {
  const local = [{ title: "AI procurement guidance", text: "Gaming studios must document AI procurement under new guidance." }];
  assert.strictEqual(localEvidenceCovers("How do quantum computers affect weather forecasting?", local), false);
});

test("localEvidenceCovers — does NOT cover when the question is too short", () => {
  const local = [{ title: "AI procurement guidance", text: "Gaming studios must document AI procurement under new guidance." }];
  assert.strictEqual(localEvidenceCovers("gaming", local), false);
});

test("citedWebIds — returns only web ids that were cited and exist in webEvidence", () => {
  const webEvidence = [{ id: "W1" }, { id: "W2" }, { id: "W3" }];
  const answer = "Per [W1] and [W3]; non-web refs [A1] and [T2] are ignored.";
  assert.deepStrictEqual(citedWebIds(answer, webEvidence), ["W1", "W3"]);
});

test("citedWebIds — empty when nothing was cited", () => {
  const webEvidence = [{ id: "W1" }, { id: "W2" }];
  assert.deepStrictEqual(citedWebIds("No web sources were used in this answer.", webEvidence), []);
});
