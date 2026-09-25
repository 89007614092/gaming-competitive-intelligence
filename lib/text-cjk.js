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

// Bracket variants around a citation id, folded to plain [..].
//
// TARGETED on purpose: 【】 is ordinary Chinese punctuation (【重要】, 【结论】), so
// folding every pair to [] would mangle prose. Only a pair whose content is a
// citation id is folded. Covers 【】 ［］ 〖〗 and （） ().
const CJK_ID_BRACKETS_RE = /[\u3010\uFF3B\u3016]\s*([AWST]\d+)\s*[\u3011\uFF3D\u3017]/g;
const PAREN_ID_RE = /[\uFF08(]\s*([AWST]\d+)\s*[\uFF09)]/g;

function foldBrackets(text) {
  return String(text || "")
    .replace(CJK_ID_BRACKETS_RE, "[$1]")
    .replace(PAREN_ID_RE, "[$1]");
}

// Bracket a BARE id ("...风险A1...") — but only when the id is one we actually
// issued. Safe precisely because the caller passes the known id set, so prose
// like "A1 芯片" is left alone unless A1 is real evidence for this question.
function bracketKnownIds(text, validIds) {
  const known = validIds instanceof Set ? validIds : new Set(validIds || []);
  if (!known.size) return String(text || "");
  return String(text || "").replace(
    /(?<![\[\u3010\uFF3B\u3016\uFF08(])([AWST]\d+)(?![\]\u3011\uFF3D\u3017\uFF09)])/g,
    (match, id) => (known.has(id) ? `[${id}]` : match)
  );
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

// --- Bigram distinctiveness -------------------------------------------------
// True IDF needs a background corpus, and the curated one is English (379
// chunks, ~5 containing any Han), so every Chinese bigram would score df=0 and
// all weights would come out equal — a silent no-op. Until the translated KB is
// indexed, distinctiveness is approximated by CHARACTER RARITY, which is what
// actually matters: "腾讯" is made of rare characters and identifies the
// subject, while "人工"/"智能" are built from the most common ones and appear
// everywhere.
//
// Swappable: replace bigramWeight() with a corpus-driven IDF once a Chinese
// background corpus exists; nothing else needs to change.
const COMMON_HAN = new Set((
  "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也" +
  "能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现" +
  "实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表" +
  "间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解建月公无系军很" +
  "情者最立代想已并提直题程展五果料象员位入常文总次品式活设及管特件长求老基资边流路级少图" +
  "山统接知较将组见计手角期根指联住失八针干装智哪战研场市企业务部门管理问题"
).split(""));

// 1.0 = highly distinctive, 0.25 = built entirely from common characters.
function bigramWeight(bigram) {
  const chars = Array.from(String(bigram || ""));
  if (chars.length !== 2) return 0;
  const common = chars.filter(c => COMMON_HAN.has(c)).length;
  if (common === 2) return 0.25;
  if (common === 1) return 0.6;
  return 1;
}

// Models habitually bracket only the FIRST id of a run — "[A1]A7", "[S2]S3",
// "[T2]S1". Every subsequent id is then plain text: it renders as inert text
// instead of a chip, and the "not cited" badge counts it as never referenced.
// This brackets the rest of the run so they all resolve.
function bracketCitationRuns(text) {
  let out = String(text || "");
  let prev;
  do {
    prev = out;
    out = out.replace(/(\[[AWST]\d+\])\s*([AWST]\d+)(?!\])/g, "$1[$2]");
  } while (out !== prev);
  return out;
}

// Full pipeline: fold full-width brackets, then bracket any run of bare ids.
function normaliseCitations(text) {
  return bracketCitationRuns(foldBrackets(text));
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
  bigramWeight,
  bracketCitationRuns,
  bracketKnownIds,
  normaliseCitations,
  COMMON_HAN,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof globalThis !== "undefined") globalThis.TEXT_CJK = api;
