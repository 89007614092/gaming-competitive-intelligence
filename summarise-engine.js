const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const DEFAULT_MODEL = process.env.SUMMARY_MODEL || "HuggingFaceTB/SmolLM2-135M-Instruct";
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
let generatorPromise = null;
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
  // so the Summarise corpus stays aligned with the curated, reviewed datasets.

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
    excerpt: relevantExcerpt(item, question, 2),
  }));
}

function relevantExcerpt(item, question, sentenceLimit = 2) {
  const queryWords = new Set(words(question));
  const sentences = item.text.match(/[^.!?]+(?:[.!?]+|$)/g) || [item.text];
  const ranked = sentences
    .map((sentence, index) => ({
      sentence: sentence.trim(),
      score: words(sentence).filter(word => queryWords.has(word)).length * 3
        + (/\b(?:risk|exposure|liability|compliance|copyright|privacy|transparency|moderation|requires?|creates?|faces?|enables?|allows?)\b/i.test(sentence) ? 4 : 0)
        + Math.max(0, 1 - index / 10),
    }))
    .filter(item => item.sentence.length >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, sentenceLimit)
    .map(item => item.sentence.replace(/\.\.+$/g, "."));
  return (ranked.join(" ") || item.text).slice(0, 620);
}

function formatContext(evidence, question) {
  return evidence.map(item =>
    `[${item.id}] ${item.dataset} — ${item.title}${item.section ? ` (${item.section})` : ""}\n${relevantExcerpt(item, question)}`
  ).join("\n\n");
}

function evidenceHighlights(question, evidence, limit = 4) {
  return evidence.slice(0, limit).map(item => `- ${relevantExcerpt(item, question, 1)} [${item.id}]`).join("\n");
}

async function getGenerator() {
  if (process.env.SUMMARY_DISABLE_MODEL === "1") throw new Error("Local model disabled");
  if (!generatorPromise) {
    generatorPromise = (async () => {
      const moduleEntry = require.resolve("@huggingface/transformers");
      const imported = await import(pathToFileURL(moduleEntry).href);
      const transformers = imported.default || imported;
      transformers.env.cacheDir = process.env.TRANSFORMERS_CACHE || path.join(process.cwd(), ".cache", "transformers");
      // In Node.js, force the NATIVE ONNX backend. The wasm backend is unreliable
      // here: it throws cryptic errors ("The string did not match the expected
      // pattern") and is slow on cold starts. onnxruntime-node must be installed
      // (it is a declared dependency) for this to resolve.
      try {
        require.resolve("onnxruntime-node");
        transformers.env.backends.onnx.runtime = "onnxruntime-node";
      } catch {
        console.warn(
          "[summarise] onnxruntime-node not found — falling back to the wasm ONNX " +
          "backend, which is unreliable in Node.js. Install onnxruntime-node to fix."
        );
      }
      return transformers.pipeline("text-generation", DEFAULT_MODEL, { dtype: "q4" });
    })().catch(error => {
      generatorPromise = null;
      throw new Error(`Local summarisation model failed to load: ${error.message}`);
    });
  }
  return generatorPromise;
}

// Pre-load the model in the background (e.g. at server start) so the first user
// request does not pay the cold-start download/initialisation cost. Never throws.
function warmUpModel() {
  if (process.env.SUMMARY_DISABLE_MODEL === "1") return Promise.resolve(false);
  return getGenerator()
    .then(() => true)
    .catch(error => {
      console.warn("[summarise] model warm-up skipped:", error.message);
      return false;
    });
}

function extractGeneratedAnswer(output) {
  const generated = output?.[0]?.generated_text;
  if (Array.isArray(generated)) return generated.at(-1)?.content?.trim() || "";
  if (typeof generated === "string") return generated.trim();
  return "";
}

async function runOpenSourceGeneration(question, evidence) {
  const generator = await getGenerator();
  const context = formatContext(evidence, question);
  const messages = [
    {
      role: "system",
      content: "You are an evidence-focused analyst. Answer only from the supplied evidence. Be concise, note uncertainty, and cite evidence IDs in square brackets such as [A1] or [W1].",
    },
    {
      role: "user",
      content: `Question: ${question}\n\nEvidence:\n${context}\n\nWrite a direct synthesis with a short overview and 3-6 evidence-based bullets. Do not invent facts or citations.`,
    },
  ];
  const output = await generator(messages, {
    max_new_tokens: 280,
    do_sample: false,
    repetition_penalty: 1.08,
  });
  let answer = extractGeneratedAnswer(output);
  if (!answer) throw new Error("The local model returned an empty answer");
  const validCitationIds = new Set(evidence.map(item => item.id));
  answer = answer.replace(/\[([AW]\d+)\]/g, (match, id) => validCitationIds.has(id) ? match : "");
  // Only reject clearly degenerate output (a bare list of citation tags or
  // near-empty text). The previous strict uniqueness/citation-ratio gate was too
  // aggressive for a small 135M model and forced the extractive fallback on every
  // request. When citation coverage is weak we enrich with highlights below
  // instead of discarding the answer.
  if (answer.trim().length < 40) throw new Error("Local model returned a degenerate answer");
  if (/^(?:\s*\[[AW]\d+\]\s*){3,}$/.test(answer.trim())) throw new Error("Local model returned a degenerate answer");
  const citationCount = evidence.filter(item => answer.includes(`[${item.id}]`)).length;
  if (citationCount >= 2) return answer;
  return `${answer}\n\nEvidence highlights:\n${evidenceHighlights(question, evidence)}`;
}

function generateOpenSourceAnswer(question, evidence) {
  const task = generationQueue
    .catch(() => undefined)
    .then(() => runOpenSourceGeneration(question, evidence));
  generationQueue = task.catch(() => undefined);
  return task;
}

function buildExtractiveFallback(question, evidence) {
  const selected = evidence.slice(0, 6).map(item => ({
    sentence: relevantExcerpt(item, question, 1),
    sourceId: item.id,
  })).filter(item => item.sentence.length >= 45);

  if (!selected.length) return "No sufficiently relevant evidence was found in the application data.";
  return `The strongest available evidence indicates:\n\n${selected.map(item => `- ${item.sentence} [${item.sourceId}]`).join("\n")}`;
}

module.exports = {
  DEFAULT_MODEL,
  buildCorpus,
  retrieveApplicationEvidence,
  generateOpenSourceAnswer,
  buildExtractiveFallback,
  warmUpModel,
};
