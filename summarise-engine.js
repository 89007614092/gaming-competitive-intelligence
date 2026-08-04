const fs = require("fs");
const path = require("path");

// Open-source model served over an OpenAI-compatible chat-completions API
// (Groq by default; OpenRouter or any compatible host via OPEN_MODEL_BASE_URL).
// Running the model in-process (Transformers.js + onnxruntime) exceeded Render's
// free-tier RAM and caused cold-start "warming up" failures, so we call a hosted
// open-weight model instead. The Render instance stays tiny and the same
// inline-citation prompt runs on a far larger model than could ever fit locally.
const DEFAULT_MODEL = process.env.OPEN_MODEL_NAME || "llama-3.3-70b-versatile";
const OPEN_MODEL_API_KEY = process.env.OPEN_MODEL_API_KEY || "";
const OPEN_MODEL_BASE_URL = (process.env.OPEN_MODEL_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
const MODEL_DISABLED = process.env.SUMMARY_DISABLE_MODEL === "1" || !OPEN_MODEL_API_KEY;
const DATA_DIR = path.join(__dirname, "data");
const STOP_WORDS = new Set([
  "about", "after", "again", "also", "and", "are", "because", "been", "before", "being", "between",
  "both", "but", "can", "could", "does", "each", "for", "from", "had", "has", "have", "how", "into",
  "its", "more", "most", "not", "only", "other", "our", "out", "over", "should", "such", "than", "that",
  "the", "their", "there", "these", "they", "this", "through", "under", "very", "was", "were", "what",
  "when", "where", "which", "while", "who", "will", "with", "would", "you", "your", "summarise", "summarize",
  "information", "application", "app"
]);
const OMIT_KEYS = new Set([
  "id", "icon", "color", "bg", "lat", "lon", "file", "url", "link", "sources", "source", "sourceNote"
]);

let corpusCache = null;
let generationQueue = Promise.resolve();

function readJson(fileName) {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, fileName), "utf8"));
}

function collectText(value, depth = 0) {
  if (value === null || value === undefined || depth > 4) return "";
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map(item => collectText(item, depth + 1)).filter(Boolean).join("; ");
  if (typeof value === "object") {
    return Object.entries(value)
      .filter(([key]) => !OMIT_KEYS.has(key))
      .map(([, item]) => collectText(item, depth + 1))
      .filter(Boolean)
      .join(". ");
  }
  return "";
}

function firstSourceUrl(item = {}) {
  if (typeof item.url === "string") return item.url;
  if (typeof item.link === "string") return item.link;
  if (Array.isArray(item.sources)) {
    const source = item.sources.find(entry => typeof entry === "string" || entry?.url);
    return typeof source === "string" ? source : source?.url || "";
  }
  return "";
}

function addChunk(chunks, dataset, title, item, section = "", url = "") {
  const text = collectText(item).replace(/\s+/g, " ").trim();
  if (!text || text.length < 25) return;
  chunks.push({
    dataset,
    title: String(title || section || dataset),
    section: String(section || ""),
    text: text.slice(0, 2400),
    url: url || firstSourceUrl(item),
  });
}

function buildCorpus() {
  if (corpusCache) return corpusCache;
  const chunks = [];

  const knowledge = readJson("knowledge.json");
  Object.entries(knowledge.categories || {}).forEach(([key, category]) => {
    (category.subsections || []).forEach(item =>
      addChunk(chunks, "Knowledge Base", item.title, item, category.label || key)
    );
  });

  const network = readJson("network.json");
  addChunk(chunks, "Competitor Web", network.center?.name, network.center, "Center company");
  (network.competitors || []).forEach(item => addChunk(chunks, "Competitor Web", item.name, item, "Competitor"));

  const products = readJson("tencent-products.json");
  (products.products || []).forEach(item => addChunk(chunks, "Tencent Products", item.name, item, "Product"));

  const trends = readJson("gaming-trends.json");
  (trends.trends || []).forEach(item => addChunk(chunks, "AI Gaming Trends", item.title, item, item.category));
  (trends.ecosystemContext?.sections || []).forEach(item => addChunk(chunks, "AI Gaming Trends", item.title, item, "Ecosystem context"));
  (trends.patentLandscape?.companies || []).forEach(item => addChunk(chunks, "AI Gaming Trends", item.company || item.title, item, "Patent landscape"));
  (trends.currentUseEvidence?.sections || []).forEach(item => addChunk(chunks, "AI Gaming Trends", item.title, item, "Current-use evidence"));

  const useCases = readJson("current-use-cases.json");
  (useCases.patterns || []).forEach(item => addChunk(chunks, "AI Use Cases", item.title, item, "Cross-game pattern"));
  (useCases.games || []).forEach(item => addChunk(chunks, "AI Use Cases", item.game, item, item.developer || "Game"));

  const timeline = readJson("regulatory-timeline.json");
  (timeline.events || []).forEach(item => addChunk(chunks, "AI Regulatory Timeline", item.title, item, `${item.label || item.date} · ${item.jurisdiction || ""}`));

  const risks = readJson("risks.json");
  Object.entries(risks.categories || {}).forEach(([key, category]) => {
    addChunk(chunks, "AI Use Risks", category.title || category.label || key, category, "Risk category");
    (category.risks || []).forEach(item => addChunk(chunks, "AI Use Risks", item.title, item, category.title || category.label || key));
  });
  Object.values(risks.companyRiskSummaries || {}).forEach(item =>
    addChunk(chunks, "AI Use Risks", item.company || item.name, item, "Company risk summary")
  );

  const locations = readJson("company-locations.json");
  (locations.companies || []).forEach(item => addChunk(chunks, "Company Map", item.name, item, `${item.city}, ${item.country}`));

  const news = readJson("news-cache.json");
  (news.articles || []).forEach(item => addChunk(chunks, "News", item.title, item, item.competitorKeyword, item.url));

  // NOTE: live/auto-sourced findings are intentionally NOT injected here. They
  // reach the app only through the proposed-changes review queue (user-approved),
  // so the Q&A corpus stays aligned with the curated, reviewed datasets.

  corpusCache = chunks;
  return corpusCache;
}

function words(text) {
  return (String(text || "").toLowerCase().match(/[a-z][a-z0-9'-]{1,}/g) || [])
    .filter(word => !STOP_WORDS.has(word) && (word.length > 2 || ["ai", "eu", "uk", "vr"].includes(word)));
}

function retrieveApplicationEvidence(question, limit = 7) {
  const queryWords = [...new Set(words(question))];
  const queryPhrase = String(question || "").toLowerCase().trim();
  const corpus = buildCorpus();

  const scored = corpus.map(chunk => {
    const title = chunk.title.toLowerCase();
    const section = chunk.section.toLowerCase();
    const text = chunk.text.toLowerCase();
    let score = queryPhrase.length > 10 && `${title} ${text}`.includes(queryPhrase) ? 20 : 0;
    for (const word of queryWords) {
      if (title.includes(word)) score += 6;
      if (section.includes(word)) score += 3;
      const matches = text.split(word).length - 1;
      score += Math.min(matches, 5);
    }
    const lowerQuestion = question.toLowerCase();
    if (/latest|recent|current|deadline|when/.test(lowerQuestion) && chunk.dataset === "AI Regulatory Timeline") score += 2;
    if (/risk|compliance|regulat|law|liability/.test(lowerQuestion) && chunk.dataset === "AI Use Risks") score += 5;
    if (/trend|future|emerging|technology/.test(lowerQuestion) && chunk.dataset === "AI Gaming Trends") score += 10;
    if (/use case|used|application|game example/.test(lowerQuestion) && chunk.dataset === "AI Use Cases") score += 7;
    if (/competitor|compare|company|companies/.test(lowerQuestion) && chunk.dataset === "Competitor Web") score += 5;
    if (!/latest|recent|news/.test(lowerQuestion) && chunk.dataset === "News") score -= 4;
    return { ...chunk, score };
  }).sort((a, b) => b.score - a.score);

  let selected = scored.filter(item => item.score > 0).slice(0, limit);
  if (!selected.length) {
    const seenDatasets = new Set();
    selected = scored.filter(item => {
      if (seenDatasets.has(item.dataset)) return false;
      seenDatasets.add(item.dataset);
      return true;
    }).slice(0, limit);
  }

  return selected.map((item, index) => ({
    ...item,
    id: `A${index + 1}`,
    sourceType: "application",
    excerpt: relevantExcerpt(item, question, 2, 620, item.title),
  }));
}

function relevantExcerpt(item, question, sentenceLimit = 2, maxChars = 620, title = "") {
  const queryWords = new Set(words(question));
  const norm = s => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const tnorm = norm(title);
  const sentences = item.text.match(/[^.!?]+(?:[.!?]+|$)/g) || [item.text];
  const ranked = sentences
    .map((sentence, index) => ({
      sentence: sentence.trim(),
      score: words(sentence).filter(word => queryWords.has(word)).length * 3
        + (/\b(?:risk|exposure|liability|compliance|copyright|privacy|transparency|moderation|requires?|creates?|faces?|enables?|allows?)\b/i.test(sentence) ? 4 : 0)
        + Math.max(0, 1 - index / 10),
    }))
    .filter(item => item.sentence.length >= 35)
    // Skip sentences that just restate the source title (they read as noise once
    // the title is already shown as the claim's label).
    .filter(item => {
      if (!tnorm) return true;
      const sn = norm(item.sentence);
      return !(sn.startsWith(tnorm) || tnorm.startsWith(sn)) || Math.abs(sn.length - tnorm.length) > 14;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, sentenceLimit)
    .map(item => item.sentence.replace(/\.\.+$/g, "."));
  return (ranked.join(" ") || item.text).slice(0, maxChars);
}

function formatContext(evidence, question) {
  return evidence.map(item =>
    `[${item.id}] ${item.dataset} — ${item.title}${item.section ? ` (${item.section})` : ""}\n${relevantExcerpt(item, question, 2, 620, item.title)}`
  ).join("\n\n");
}

function evidenceHighlights(question, evidence, limit = 4) {
  return evidence.slice(0, limit).map(item => `- ${relevantExcerpt(item, question, 1, 620, item.title)} [${item.id}]`).join("\n");
}

// ===== Open-source model via API (Groq / OpenRouter / any OpenAI-compatible) =====
// The model is NOT loaded in-process (that exceeded Render's free-tier RAM and
// caused cold-start "warming up" failures). Instead we call a hosted open-weight
// model over its OpenAI-compatible chat-completions endpoint. This keeps the
// Render instance tiny and lets the same inline-citation prompt run on a far
// larger model than could ever fit locally.
//
// Configure via env vars:
//   OPEN_MODEL_API_KEY   (required) API key for the model host
//   OPEN_MODEL_BASE_URL  default https://api.groq.com/openai/v1
//                        (OpenRouter: https://openrouter.ai/api/v1)
//   OPEN_MODEL_NAME      default llama-3.3-70b-versatile
//                        (OpenRouter examples: meta-llama/llama-3.3-70b-instruct,
//                         qwen/qwen2.5-72b-instruct, mistralai/mixtral-8x7b-instruct)
//   SUMMARY_DISABLE_MODEL=1  disables the AI model entirely (extractive-only)

async function runApiModelGeneration(question, evidence) {
  if (MODEL_DISABLED) {
    throw new Error(
      process.env.SUMMARY_DISABLE_MODEL === "1"
        ? "Local model disabled"
        : "Model API key not configured (set OPEN_MODEL_API_KEY)"
    );
  }
  const context = formatContext(evidence, question);
  const messages = [
    {
      role: "system",
      content: "You are an evidence-focused research analyst. Answer ONLY from the supplied evidence. Write a detailed, comprehensive answer in well-structured paragraphs (and bullet points where useful). Cite the evidence INLINE using the exact IDs in square brackets, e.g. [A1] or [W2], placing each citation right after the claim it supports. Do NOT add a separate list of evidence at the end. If the evidence is thin or silent on part of the question, say so plainly rather than inventing facts.",
    },
    {
      role: "user",
      content: `Question: ${question}\n\nEvidence:\n${context}\n\nWrite the detailed, inline-cited answer now.`,
    },
  ];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch(`${OPEN_MODEL_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPEN_MODEL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        messages,
        max_tokens: 720,
        temperature: 0,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`Model API returned HTTP ${resp.status}: ${txt.slice(0, 200)}`);
    }
    const json = await resp.json();
    let answer = json?.choices?.[0]?.message?.content?.trim() || "";
    if (!answer) throw new Error("The model returned an empty answer");
    const validCitationIds = new Set(evidence.map(item => item.id));
    answer = answer.replace(/\[([AW]\d+)\]/g, (match, id) => (validCitationIds.has(id) ? match : ""));
    if (answer.trim().length < 80) throw new Error("Model returned a degenerate answer");
    if (/^(?:\s*\[[AW]\d+\]\s*){3,}$/.test(answer.trim())) throw new Error("Model returned a degenerate answer");
    const citationCount = evidence.filter(item => answer.includes(`[${item.id}]`)).length;
    // Require genuine inline citation coverage; otherwise fall back to the
    // detailed extractive answer so the user always gets a comprehensive,
    // inline-cited response rather than a model answer with no sources.
    if (citationCount >= 2) return answer;
    return buildExtractiveAnswer(question, evidence);
  } finally {
    clearTimeout(timeout);
  }
}

// Serialise model calls so we never open two concurrent API requests at once
// (keeps the host's rate limits happy and response ordering sane).
function generateOpenSourceAnswer(question, evidence) {
  const task = generationQueue
    .catch(() => undefined)
    .then(() => runApiModelGeneration(question, evidence));
  generationQueue = task.catch(() => undefined);
  return task;
}

// Generic chat-completions call used by background enrichment (proposed-changes
// styling + categorisation). Returns the model text, or null when the model is
// disabled or the request fails — callers must degrade gracefully. Routed
// through the shared generationQueue so we never open two concurrent API
// requests at once (keeps host rate limits happy).
async function runModelChat(systemPrompt, userPrompt, { maxTokens = 600, temperature = 0.2, json = false } = {}) {
  if (MODEL_DISABLED) return null;
  const messages = [
    { role: "system", content: json ? `${systemPrompt}\nRespond with ONLY valid JSON, no prose, no markdown code fences.` : systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const task = generationQueue
    .catch(() => undefined)
    .then(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 60000);
      try {
        const resp = await fetch(`${OPEN_MODEL_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${OPEN_MODEL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEFAULT_MODEL, messages, max_tokens: maxTokens, temperature }),
          signal: controller.signal,
        });
        if (!resp.ok) return null;
        const j = await resp.json().catch(() => null);
        return j?.choices?.[0]?.message?.content?.trim() || null;
      } catch {
        return null;
      } finally {
        clearTimeout(timeout);
      }
    });
  generationQueue = task.catch(() => undefined);
  return task;
}

// Pre-load hook. For an API-backed model there is nothing to preload, so this
// simply reports whether the model is configured. Never throws.
function warmUpModel() {
  if (MODEL_DISABLED) return Promise.resolve(false);
  return Promise.resolve(true);
}

// True once the model API key is configured (the "opt-in" AI model is available).
function isModelReady() {
  return !MODEL_DISABLED;
}

function truncate(text, n) {
  const t = String(text || "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trim()}…` : t;
}

// Build a detailed, comprehensive answer assembled directly from the retrieved
// evidence, with each claim tagged by its source ID inline (e.g. [A3]). Evidence
// is grouped by dataset so the response reads as a structured briefing rather
// than a flat bullet list, and every claim carries its citation in-line.
function buildExtractiveAnswer(question, evidence) {
  const usable = evidence.filter(item => (item.excerpt || item.text || "").length >= 40);
  if (!usable.length) {
    return "No sufficiently relevant evidence was found in the application data for that question. Try rephrasing, or enable internet search for broader coverage.";
  }

  const groups = [];
  const byDataset = new Map();
  for (const item of usable) {
    if (!byDataset.has(item.dataset)) {
      const arr = [];
      byDataset.set(item.dataset, arr);
      groups.push({ dataset: item.dataset, items: arr });
    }
    byDataset.get(item.dataset).push(item);
  }

  const blocks = [
    `Here is a detailed answer to "${truncate(question, 160)}", drawn from the application's curated evidence:`,
  ];

  for (const group of groups) {
    blocks.push(`\n■ ${group.dataset}`);
    for (const item of group.items) {
      const excerpt = relevantExcerpt(item, question, 3, 900, item.title);
      if (!excerpt) continue;
      const label = item.section ? `${item.title} (${item.section})` : item.title;
      blocks.push(`**${label}** — ${excerpt} [${item.id}]`);
    }
  }

  blocks.push(
    `\nEach claim above is tagged with its source ID (e.g. [${usable[0].id}]); the Sources list below expands every citation with a link to the original.`
  );
  return blocks.join("\n").trim();
}

module.exports = {
  DEFAULT_MODEL,
  buildCorpus,
  retrieveApplicationEvidence,
  generateOpenSourceAnswer,
  runModelChat,
  buildExtractiveAnswer,
  warmUpModel,
  isModelReady,
};
