"use strict";

// ===========================================================================
// CJK-aware text primitives — ONE place for the assumptions that broke six
// separate times when answers came back in Chinese.
//
// The bugs, all the same class (the pipeline assumed English punctuation and
// metrics):
//   .!? sentence splitting        -> a Chinese passage was one run-on sentence
//   40-character sentence floor   -> ordinary Chinese sentences discarded
//   contiguous-phrase matching    -> Chinese web sources scored zero
//   [A1] bracket matching         -> 【A1】 citations counted as none
//
// Every one was fixed piecemeal and in a different file. This module exists so
// there is a single implementation: anything touching free text uses these
// helpers instead of re-deriving its own regex.
//
// Loaded two ways from one file: `require()` on the server, and as a classic
// script (<script src="/text-cjk.js">) in the browser, which sets
// window.TEXT_CJK.
// ===========================================================================

// Han runs: CJK Unified Ideographs Ext A + the main block, plus compatibility
// ideographs. Written as escapes so the file stays ASCII-safe.
const HAN_RUN_RE = /[㐀-鿿豈-﫿]+/g;

// Contiguous Han runs. NOTE: matching these whole is almost never what you want
// — see cjkBigrams below.
function cjkRuns(text) {
  return String(text || "").match(HAN_RUN_RE) || [];
}

// Sliding two-character pairs from each Han run. This is the standard approach
// for unsegmented text: "腾讯的游戏战略" yields 腾讯/讯的/的游/游戏/…, so a
// document that phrases the idea differently still matches on the meaningful
// pairs. Whole runs only match near-duplicate text.
function cjkBigrams(text) {
  const out = new Set();
  for (const run of cjkRuns(text)) {
    if (run.length < 2) continue;
    for (let i = 0; i < run.length - 1; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

// Full-width bracket variants back to ASCII. Chinese models routinely write
// 【A1】 or ［A1］ where the pipeline expects [A1].
function foldBrackets(text) {
  return String(text || "")
    .replace(/[【［〖【]/g, "[")
    .replace(/[】］〗】]/g, "]");
}

// Sentence terminators in BOTH scripts. Splitting on [.!?] alone silently turns
// a Chinese passage into a single sentence.
const SENTENCE_SPLIT_RE = /[^.!?。！？]+(?:[.!?。！？]+|$)/g;

// Split into sentences, preserving each sentence's own terminator (so Chinese
// output keeps 。 rather than being rewritten).
function splitSentences(text) {
  const s = String(text || "");
  return s.match(SENTENCE_SPLIT_RE) || [s];
}

// Minimum length for a sentence worth quoting, by script. 40 characters was an
// English figure (roughly seven words); ordinary Chinese sentences run 10-20.
function minSentenceLen(text) {
  return cjkRuns(text).length ? 10 : 40;
}

const api = {
  HAN_RUN_RE,
  SENTENCE_SPLIT_RE,
  cjkRuns,
  cjkBigrams,
  foldBrackets,
  splitSentences,
  minSentenceLen,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.TEXT_CJK = api;
