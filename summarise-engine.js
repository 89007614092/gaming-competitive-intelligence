const fs = require("fs");
const path = require("path");

// Open-source model served over an OpenAI-compatible chat-completions API
// (Groq by default; OpenRouter or any compatible host via OPEN_MODEL_BASE_URL).
// Running the model in-process (Transformers.js + onnxruntime) exceeded Render's
// free-tier RAM and caused cold-start "warming up" failures, so we call a hosted
// open-weight model instead. The Render instance stays tiny and the same
// inline-citation prompt runs on a far larger model than could ever fit locally.
// Default to the 8B "instant" model: on Groq's free tier it carries a 500K
// tokens/day cap (vs 100K for llama-3.3-70b), which is what this app's
// background enrichment + Q&A workload needs. Override with OPEN_MODEL_NAME.
const DEFAULT_MODEL = process.env.OPEN_MODEL_NAME || "llama-3.1-8b-instant";
const OPEN_MODEL_API_KEY = process.env.OPEN_MODEL_API_KEY || "";
const OPEN_MODEL_BASE_URL = (process.env.OPEN_MODEL_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/+$/, "");
// Dedicated credentials/queue for the background "Suggested Updates" scan so it
// can never starve interactive Q&A. Falls back to the primary key when no
// separate scan key is configured — you still get queue + cooldown isolation;
// supply a DISTINCT OPEN_MODEL_API_KEY_SCAN (e.g. a second free-tier account, or
// an upgraded paid plan's second key) for independent daily-quota isolation.
const OPEN_MODEL_API_KEY_SCAN = process.env.OPEN_MODEL_API_KEY_SCAN || OPEN_MODEL_API_KEY;
const OPEN_MODEL_BASE_URL_SCAN = (process.env.OPEN_MODEL_BASE_URL_SCAN || OPEN_MODEL_BASE_URL).replace(/\/+$/, "");
// Per-lane model name for the scan lane. Lets the scan run on a different host's
// model id (e.g. an OpenRouter slug like meta-llama/llama-3.3-70b-instruct) than
// the Q&A lane's Groq slug. Falls back to DEFAULT_MODEL when unset.
const OPEN_MODEL_NAME_SCAN = process.env.OPEN_MODEL_NAME_SCAN || DEFAULT_MODEL;
// Per-lane readiness. SUMMARY_DISABLE_MODEL gates the Q&A (user-facing) lane;
// SUMMARY_DISABLE_SCAN gates ONLY the background scan lane.
const QA_MODEL_DISABLED = process.env.SUMMARY_DISABLE_MODEL === "1" || !OPEN_MODEL_API_KEY;
const SCAN_MODEL_DISABLED = process.env.SUMMARY_DISABLE_SCAN === "1" || !OPEN_MODEL_API_KEY_SCAN;
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
// Two independent serialisation lanes so the background scan never blocks
// interactive Q&A (and vice-versa). Each lane has its own queue + cooldown.
let qaQueue = Promise.resolve();
let scanQueue = Promise.resolve();
// Epoch-ms timestamps until which a given lane's model calls are paused.
let qaRateLimitedUntil = 0;
let scanRateLimitedUntil = 0;

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
//   OPEN_MODEL_API_KEY   (required) API key for the Q&A (user-facing) lane
//   OPEN_MODEL_BASE_URL  default https://api.groq.com/openai/v1
//                        (OpenRouter: https://openrouter.ai/api/v1)
//   OPEN_MODEL_NAME      default llama-3.3-70b-versatile
//                        (OpenRouter examples: meta-llama/llama-3.3-70b-instruct,
//                         qwen/qwen2.5-72b-instruct, mistralai/mixtral-8x7b-instruct)
//   OPEN_MODEL_API_KEY_SCAN  optional 2nd key for the background scan lane
//                            (default: same as OPEN_MODEL_API_KEY)
//   OPEN_MODEL_BASE_URL_SCAN  optional base URL for the scan lane
//                            (default: same as OPEN_MODEL_BASE_URL)
//   SUMMARY_DISABLE_MODEL=1  disables the Q&A model entirely (extractive-only)
//   SUMMARY_DISABLE_SCAN=1   disables ONLY the background scan model

// Milliseconds from now until a target wall-clock time (hour:minute) in the
// given IANA timezone. Used to compute "wait until the daily cap resets" so we
// land on the correct absolute instant regardless of the host's local TZ.
function msUntilNextWallClockInZone(tz, hour, minute) {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(now);
  const m = Object.fromEntries(parts.map(p => [p.type, p.value]));
  if (m.hour === "24") m.hour = "00"; // some ICU builds emit 24 for midnight
  // Express "now" as a UTC timestamp whose wall-clock equals the tz's wall-clock.
  const nowInZone = Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour, +m.minute, +m.second);
  let next = Date.UTC(+m.year, +m.month - 1, +m.day, hour, minute, 0);
  if (next <= nowInZone) next += 24 * 3600 * 1000; // already past today's reset
  return next - nowInZone;
}

// Given a 429 response, compute how long to pause before retrying. Reads the
// Retry-After header, or (for Groq/OpenRouter free tiers) waits until just after
// midnight PT when the daily token cap resets. Shared by both lanes.
function cooldownFrom429(resp, txt) {
  const retryAfter = parseInt(resp.headers.get("retry-after") || "", 10);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (/per day|TPD|free-models-per-day/i.test(txt || "")) {
    // Free-tier daily caps (Groq tokens/day, OpenRouter free-models-per-day)
    // reset at midnight PT; wait until just after.
    return msUntilNextWallClockInZone("America/Los_Angeles", 0, 5);
  }
  return 60 * 60 * 1000;
}

async function runApiModelGeneration(question, evidence) {
  if (QA_MODEL_DISABLED) {
    throw new Error(
      process.env.SUMMARY_DISABLE_MODEL === "1"
        ? "Local model disabled"
        : "Model API key not configured (set OPEN_MODEL_API_KEY)"
    );
  }
  if (Date.now() < qaRateLimitedUntil) {
    throw new Error("Q&A model is rate-limited; please try again later");
  }
  const context = formatContext(evidence, question);
  const messages = [
    {
      role: "system",
      content: "You are a senior evidence-focused research analyst for a gaming competitive-intelligence knowledge base. You are given a question and a block of evidence. The evidence may contain two kinds of items:\n- Application-sourced items with IDs like [A1], [A2] … (curated knowledge-base entries).\n- Web-sourced items with IDs like [W1], [W2] … (retrieved from the internet; present only when web search is enabled).\n\nGround every claim in the supplied evidence and cite it inline. You MAY draw reasoned inferences and practical implications FROM that evidence — connecting the dots is analysis, not invention — but you must NEVER introduce facts, figures, dates, events, or sources that are not present in the evidence. When you state an inference that goes beyond a single literal excerpt, mark it as derived from its citations (e.g. \"Taken together, this implies… [A3][A1]\").\n\nWhen the evidence on some part of the question is weak or partial, say so plainly and use appropriately calibrated language (e.g. \"There is thin evidence to suggest…\", \"Some evidence may suggest…\"), citing the source where one exists. When there is no evidence for a part of the question, state that plainly and do not invent facts to fill the gap. Conversely, when the evidence is strong and consistent, state your conclusions confidently and cite them.\n\nUse the web items to CORROBORATE, add recency/context to, or fill gaps in the application evidence. When you rely on a web item, cite it with its [W#] ID exactly as you would an application item, and keep application-sourced and web-sourced claims clearly distinguishable in your wording (e.g. \"Per the patch notes [A3]…\" vs \"Recent reporting [W2] suggests…\"). If no web items are present, rely solely on the application evidence.\n\nFormat your answer in Markdown using EXACTLY these three delimited sections, in this order, with no extra prose before or after:\n\n## Detailed Answer\nA detailed, comprehensive answer built as a clear chain of reasoning, not a flat list of facts. For each substantive point:\n- State the claim.\n- Cite the supporting evidence INLINE with its exact ID in square brackets (e.g. [A1] or [W2]), placed immediately after the claim it supports.\n- Show the reasoning: connect the cited evidence to the claim with explicit logic (e.g. \"Because [A3] shows X and [A1] shows Y, this implies Z\"). Do not present conclusions as bare assertions.\nUse well-structured paragraphs and Markdown bullet lists where useful. Do NOT add a separate list of evidence at the end. Always finish this section with a complete concluding sentence — never leave a sentence unfinished.\n\n## Key Points\nA Markdown bullet list (- ) of the 3–7 most important takeaways, each cited inline with its supporting [A#]/[W#] ID. Each bullet should capture a conclusion the reader would act on or remember, not just a fact.\n\n## Conclusion\nA 3–5 sentence wrap-up that:\n1. States the overall answer in one or two sentences.\n2. Gives 1–3 actionable recommendations or decisions a reader could act on, each grounded in and citing the evidence (e.g. \"Given [A3] and [W2], studios should…\").\n3. States any open caveats or evidence gaps.\nEnd with a complete sentence.\n\nBefore finalising, verify: (a) every conclusion traces to a cited claim, (b) at least one actionable implication is stated, (c) no unsupported facts were introduced.\n\nUse Markdown only (headings with ##, bullet lists with - ). Do NOT use HTML tags.",
    },
    {
      role: "user",
      content: `Question: ${question}\n\nEvidence:\n${context}\n\nWrite the detailed, inline-cited answer now.`,
    },
  ];

  // Retry-after-aware Q&A resilience: a short Groq/OpenRouter throttle (a 429
  // carrying a small Retry-After) must NOT silently downgrade the answer to the
  // extractive fallback. We wait out the brief throttle and retry inside this
  // same request, so the user still gets a cited model synthesis. A long or
  // daily-cap 429 (or exhausted retries) still pauses the lane and falls back to
  // extractive exactly as before. Keep QA_RETRY_AFTER_CAP_MS small: the
  // /api/summarise race budget in server.js is 70s, so firstFetch + sleeps +
  // secondFetch must stay under it — real short throttles are only a few seconds.
  const qaRetryMax = Math.max(0, Number(process.env.QA_RETRY_429_MAX || 2));
  const qaRetryCapMs = Math.max(1000, Number(process.env.QA_RETRY_AFTER_CAP_MS || 20000));
  for (let attempt = 0; attempt <= qaRetryMax; attempt++) {
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
          max_tokens: 1800,
          temperature: 0,
        }),
        signal: controller.signal,
      });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("retry-after") || "", 10);
      const isShortThrottle = Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter * 1000 <= qaRetryCapMs;
      if (isShortThrottle && attempt < qaRetryMax) {
        // Brief throttle: wait it out and retry within this request instead of
        // forcing the extractive fallback. Costs no extra quota beyond the wait.
        console.warn(`[model:qa] 429 short throttle (Retry-After ${retryAfter}s) — retrying in ${retryAfter}s (attempt ${attempt + 1}/${qaRetryMax})`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      const cooldownMs = cooldownFrom429(resp, txt);
      qaRateLimitedUntil = Date.now() + cooldownMs;
      console.warn(`[model:qa] rate limited (HTTP 429) — Q&A calls paused for ${Math.round(cooldownMs / 60000)}m until ${new Date(qaRateLimitedUntil).toISOString()}`);
    }
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
}

// Serialise model calls so we never open two concurrent API requests at once
// (keeps the host's rate limits happy and response ordering sane).
function generateOpenSourceAnswer(question, evidence) {
  const task = qaQueue
    .catch(() => undefined)
    .then(() => runApiModelGeneration(question, evidence));
  qaQueue = task.catch(() => undefined);
  return task;
}

// Generic chat-completions call used by the background scan (proposed-changes
// styling + categorisation) AND (optionally) any future Q&A path. Returns the
// model text, or null when the model is disabled/fails — callers degrade
// gracefully. Routed through a LANE-specific queue (qa | scan) so the two
// workloads never block each other, and each lane tracks its own rate-limit
// cooldown. Pass lane: "scan" from the background enrichment path.
async function runModelChat(systemPrompt, userPrompt, { maxTokens = 600, temperature = 0.2, json = false, timeoutMs = 60000, lane = "qa" } = {}) {
  const isScan = lane === "scan";
  const apiKey = isScan ? OPEN_MODEL_API_KEY_SCAN : OPEN_MODEL_API_KEY;
  const baseUrl = isScan ? OPEN_MODEL_BASE_URL_SCAN : OPEN_MODEL_BASE_URL;
  const modelName = isScan ? OPEN_MODEL_NAME_SCAN : DEFAULT_MODEL;
  const queue = isScan ? scanQueue : qaQueue;
  const disabled = isScan ? SCAN_MODEL_DISABLED : QA_MODEL_DISABLED;
  if (disabled) return null;
  const messages = [
    { role: "system", content: json ? `${systemPrompt}\nRespond with ONLY valid JSON, no prose, no markdown code fences.` : systemPrompt },
    { role: "user", content: userPrompt },
  ];
  const task = queue
    .catch(() => undefined)
    .then(async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: modelName, messages, max_tokens: maxTokens, temperature }),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          if (resp.status === 429) {
            const cooldownMs = cooldownFrom429(resp, txt);
            if (isScan) scanRateLimitedUntil = Date.now() + cooldownMs;
            else qaRateLimitedUntil = Date.now() + cooldownMs;
            const until = isScan ? scanRateLimitedUntil : qaRateLimitedUntil;
            console.warn(`[model:${lane}] rate limited (HTTP 429) — ${lane} calls paused for ${Math.round(cooldownMs / 60000)}m until ${new Date(until).toISOString()}`);
            return { rateLimited: true };
          }
          console.error(`[model:${lane}] chat completion HTTP ${resp.status}: ${txt.slice(0, 200)}`);
          return null;
        }
        const j = await resp.json().catch(() => null);
        return j?.choices?.[0]?.message?.content?.trim() || null;
      } catch (err) {
        console.error(`[model:${lane}] chat completion request failed: ${err && err.message ? err.message : err}`);
        return null;
      } finally {
        clearTimeout(timeout);
      }
    });
  if (isScan) scanQueue = task.catch(() => undefined);
  else qaQueue = task.catch(() => undefined);
  return task;
}

// Pre-load hook. For an API-backed model there is nothing to preload, so this
// simply reports whether the model is configured. Never throws.
function warmUpModel() {
  if (QA_MODEL_DISABLED) return Promise.resolve(false);
  return Promise.resolve(true);
}

// True once the user-facing (Q&A) model API key is configured.
function isModelReady() {
  return !QA_MODEL_DISABLED;
}

// True once the background scan model is configured (may use a separate key).
function isScanModelReady() {
  return !SCAN_MODEL_DISABLED;
}

// Per-lane rate-limit tracking so callers can avoid re-hammering the API and
// burning the daily token quota. Set when a lane's call sees HTTP 429.
function getQaRateLimitedUntil() { return qaRateLimitedUntil; }
function isQaRateLimited() { return Date.now() < qaRateLimitedUntil; }
function getScanRateLimitedUntil() { return scanRateLimitedUntil; }
function isScanRateLimited() { return Date.now() < scanRateLimitedUntil; }

function truncate(text, n) {
  const t = String(text || "").trim();
  return t.length > n ? `${t.slice(0, n - 1).trim()}…` : t;
}

// Local, dependency-free relevance scorer used by the extractive Key Points
// section. Ranks a sentence by overlap with the question plus a small
// risk/action keyword boost (mirroring the scoring inside relevantExcerpt), so
// the model-free fallback can surface the most on-topic sentences. Short
// takeaways are gently preferred to keep Key Points punchy.
function scoreSentence(sentence, questionWords) {
  const matched = words(sentence).filter(word => questionWords.has(word)).length * 3;
  const riskBoost = /\b(?:risk|exposure|liability|compliance|copyright|privacy|transparency|moderation|requires?|creates?|faces?|enables?|allows?)\b/i.test(sentence) ? 4 : 0;
  const lengthPenalty = sentence.length > 240 ? 2 : 0;
  return matched + riskBoost - lengthPenalty;
}

// Generic comparison/relation verbs that are weak topical signals on their own
// (a page can contain "compare" yet be about something else entirely).
const GENERIC_WEAK_TERMS = new Set([
  "compare", "comparison", "versus", "difference", "similar", "related",
  "mean", "meaning", "definition",
]);
// Short domain-core terms that still count as substantive signals for this app.
const DOMAIN_CORE_TERMS = new Set([
  "ai", "eu", "uk", "vr", "npc", "npcs", "gpt", "llm", "api",
]);

// Relevance-filter raw web-search hits against the question so noisy or
// off-topic results never reach the answer. Matching is token-based (so
// "compared" doesn't falsely match "compare"), and a result is only kept if it
// contains at least one *substantive* query term — i.e. not just the generic
// verb "compare". An extra penalty drops definition/dictionary pages (e.g.
// "compare" in the question matched Dictionary.com) unless the question is
// literally asking for a definition. Returns only on-topic results; callers get
// a clean, empty web set rather than junk when nothing clears the bar.
function webResultRelevance(question, results, limit = 5) {
  const queryWords = [...new Set(words(question))];
  const querySet = new Set(queryWords);
  const substantive = queryWords.filter(
    w => (w.length >= 4 && !GENERIC_WEAK_TERMS.has(w)) || DOMAIN_CORE_TERMS.has(w)
  );
  const questionLower = String(question || "").toLowerCase();
  const wantsDefinition = /\b(define|definition|meaning of|what (is|does|are) .* mean)\b/.test(questionLower);

  return (results || [])
    .map(item => {
      const titleWords = new Set(words(item.title || ""));
      const textWords = new Set(words(item.description || item.content || item.text || ""));
      // Must contain at least one substantive query term, otherwise it is
      // almost certainly off-topic (e.g. a dictionary entry for "compare").
      const hasSubstantive = substantive.some(w => titleWords.has(w) || textWords.has(w));
      if (!hasSubstantive) return { ...item, _score: -1 };

      let score = 0;
      for (const w of querySet) {
        if (titleWords.has(w)) score += 5;
        let count = 0;
        for (const t of textWords) if (t === w) count += 1;
        score += Math.min(count, 4);
      }
      const blob = `${item.title || ""} ${item.description || item.content || item.text || ""}`;
      if (!wantsDefinition && /definition|meaning|synonym|dictionary|merriam|cambridge|oxford|collins|transitive verb|intransitive verb/i.test(blob)) {
        score -= 10;
      }
      return { ...item, _score: score };
    })
    .filter(r => r._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

// Build a structured, Markdown 3-part answer (Detailed Answer / Key Points /
// Conclusion) directly from the retrieved evidence, with every claim tagged by
// its source ID inline. It mirrors the Markdown structure the AI model path
// emits, so the same renderer and "Answer style" selector work with no model
// loaded. Nothing is synthesised or invented:
//   - Detailed Answer  = the retrieved evidence, grouped and cited (app A* vs
//     web W* kept distinguishable), exactly as the AI prompt frames the two.
//   - Key Points       = the most question-relevant extracted sentences, chosen
//     by a local scorer (real extractive summarisation, no API).
//   - Conclusion       = a metadata-driven coverage note (counts, source types,
//     recency) that uses the same calibrated thin/no-evidence phrasing.
function buildExtractiveAnswer(question, evidence) {
  const usable = evidence.filter(item => (item.excerpt || item.text || "").length >= 40);
  if (!usable.length) {
    return "## Conclusion\nNo sufficiently relevant evidence was found in the application data for that question. Try rephrasing, or enable internet search for broader coverage.";
  }

  const appItems = usable.filter(item => item.sourceType !== "internet");
  const webItems = usable.filter(item => item.sourceType === "internet");
  const questionWords = new Set(words(question));

  // --- Detailed Answer: grouped, cited evidence (app vs web) ---
  const detailedLines = [
    `Here is what the curated evidence shows for "${truncate(question, 160)}":`,
  ];
  if (appItems.length) {
    detailedLines.push("\n**Application evidence**");
    for (const item of appItems) {
      const excerpt = relevantExcerpt(item, question, 3, 900, item.title);
      if (!excerpt) continue;
      const label = item.section ? `${item.title} (${item.section})` : item.title;
      detailedLines.push(`- **${label}** — ${excerpt} [${item.id}]`);
    }
  }
  if (webItems.length) {
    detailedLines.push("\n**Web context**");
    for (const item of webItems) {
      const excerpt = relevantExcerpt(item, question, 3, 900, item.title);
      if (!excerpt) continue;
      detailedLines.push(`- **${item.title}** — ${excerpt} [${item.id}]`);
    }
  }

  // --- Key Points: top-K question-relevant extracted sentences ---
  const candidates = [];
  for (const item of usable) {
    const excerpt = relevantExcerpt(item, question, 3, 900, item.title);
    if (!excerpt) continue;
    const sentences = excerpt.match(/[^.!?]+(?:[.!?]+|$)/g) || [excerpt];
    for (const raw of sentences) {
      const s = raw.trim();
      if (s.length < 40 || s.length > 300) continue;
      candidates.push({ sentence: s, score: scoreSentence(s, questionWords), id: item.id });
    }
  }
  const seenSentences = new Set();
  const rankedKeyPoints = candidates
    .sort((a, b) => b.score - a.score)
    .filter(kp => {
      const key = kp.sentence.toLowerCase().replace(/\s+/g, " ").trim();
      if (seenSentences.has(key)) return false;
      seenSentences.add(key);
      return true;
    })
    .slice(0, 5);

  const keyPointLines = [];
  if (rankedKeyPoints.length) {
    for (const kp of rankedKeyPoints) {
      keyPointLines.push(`- ${kp.sentence.replace(/\.$/, "")} [${kp.id}]`);
    }
  } else {
    // Fallback: list the most relevant retrieved items directly.
    for (const item of usable.slice(0, 5)) {
      const excerpt = relevantExcerpt(item, question, 1, 240, item.title);
      keyPointLines.push(`- **${item.title}** — ${excerpt} [${item.id}]`);
    }
  }

  // --- Conclusion: metadata-driven coverage note (no fabrication) ---
  const appCount = appItems.length;
  const webCount = webItems.length;
  const total = usable.length;
  const lowerQuestion = question.toLowerCase();
  const wantsRecency = /\b(latest|recent|current|new|deadline|when|2024|2025|2026)\b/.test(lowerQuestion);
  const conclusionLines = [];
  if (total < 3) {
    conclusionLines.push(`Evidence on this topic is limited — only ${total} relevant record${total === 1 ? "" : "s"} were found. Try rephrasing the question or enabling internet search for broader coverage.`);
  } else {
    let lead = `Based on ${appCount} curated application record${appCount === 1 ? "" : "s"}`;
    if (webCount) lead += ` and ${webCount} web source${webCount === 1 ? "" : "s"}`;
    lead += `, the evidence above covers the main aspects of "${truncate(question, 120)}".`;
    conclusionLines.push(lead);
  }
  if (wantsRecency && !webCount) {
    conclusionLines.push("This answer draws only on curated application data and may not reflect the very latest developments — enable internet search for the most recent context.");
  }

  return [
    "## Detailed Answer",
    detailedLines.join("\n").trim(),
    "",
    "## Key Points",
    keyPointLines.join("\n"),
    "",
    "## Conclusion",
    conclusionLines.join(" "),
  ].join("\n").trim();
}

module.exports = {
  DEFAULT_MODEL,
  OPEN_MODEL_NAME_SCAN,
  buildCorpus,
  retrieveApplicationEvidence,
  generateOpenSourceAnswer,
  runModelChat,
  buildExtractiveAnswer,
  webResultRelevance,
  warmUpModel,
  isModelReady,
  isScanModelReady,
  isQaRateLimited,
  getQaRateLimitedUntil,
  isScanRateLimited,
  getScanRateLimitedUntil,
};
