const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");
const {
  DEFAULT_MODEL,
  buildCorpus,
  retrieveApplicationEvidence,
  generateOpenSourceAnswer,
  runModelChat,
  buildExtractiveAnswer,
  warmUpModel,
  isModelReady,
} = require("./summarise-engine");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const { execSync } = require("child_process");
function resolvePython() {
  const candidates = [
    "/Users/mollybarlow/.workbuddy/binaries/python/envs/default/bin/python3",
    "python3",
    "python",
  ];
  for (const candidate of candidates) {
    try {
      execSync(`"${candidate}" --version`, { stdio: "ignore" });
      return candidate;
    } catch (_) { /* try next */ }
  }
  return null;
}
const PYTHON = resolvePython();
const SEARCH_SCRIPT = path.join(__dirname, "search.py");
const TRANSCRIPT_SCRIPT = path.join(__dirname, "transcript.py");

// ===== Tavily Web Search (API key required) =====
// Replaces the old self-scraped DuckDuckGo search (run via a Python subprocess),
// which got rate-limited / served bot-challenges from Render's shared IP and
// always timed out. Tavily is a proper search API that returns structured
// results reliably from any IP. Requires TAVILY_API_KEY in the environment.

function tavilySearch(query, limit = 10) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      return reject(new Error("Search API key not configured (set TAVILY_API_KEY)"));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: Math.min(Number(limit) || 10, 20),
        search_depth: "basic",
        include_answer: false,
      }),
      signal: controller.signal,
    })
      .then(async (resp) => {
        clearTimeout(timeout);
        if (!resp.ok) {
          const txt = await resp.text().catch(() => "");
          throw new Error(`Search API returned HTTP ${resp.status}: ${txt.slice(0, 160)}`);
        }
        const json = await resp.json();
        const results = Array.isArray(json.results) ? json.results : [];
        resolve(
          results
            .filter(item => item.url && (item.title || item.content))
            .map(item => ({
              title: item.title || item.url,
              url: item.url,
              description: String(item.content || item.title || "").slice(0, 900),
            }))
        );
      })
      .catch((err) => {
        clearTimeout(timeout);
        if (err.name === "AbortError") return reject(new Error("Search timed out"));
        reject(err);
      });
  });
}

// ===== Jina Reader (keyless option for the proposed-changes resolver) =====
// r.jina.ai/<url> returns the article body as clean text; s.jina.ai/<query>
// returns search results already extracted as markdown. Used when
// SEARCH_PROVIDER=jina so the resolver needs NO API key (an optional
// JINA_API_KEY simply lifts anonymous rate limits). Works from any IP,
// bypassing the DDG/GDELT sandbox block.

function activeSearchProvider() {
  return (process.env.SEARCH_PROVIDER || "jina").toLowerCase().trim();
}

function jinaHeaders() {
  const headers = { Accept: "text/markdown,text/plain" };
  if (process.env.JINA_API_KEY) headers["Authorization"] = `Bearer ${process.env.JINA_API_KEY}`;
  return headers;
}

// Resolve a title to the real publisher URL via Jina's search endpoint.
async function jinaSearch(query, limit = 5) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const resp = await fetch(`https://s.jina.ai/${encodeURIComponent(query)}`, {
      headers: jinaHeaders(),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Jina search HTTP ${resp.status}`);
    const md = await resp.text();
    return parseJinaSearch(md, limit);
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Jina search timed out");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// Tolerant parser for Jina's markdown search results. We only strictly need the
// first real publisher URL; the title/content are best-effort.
function parseJinaSearch(md, limit) {
  const blocks = md.split(/^#{1,4}\s+Result\s+\d+/gim).slice(1);
  const out = [];
  for (const block of blocks) {
    if (out.length >= limit) break;
    const urls = [...block.matchAll(/https?:\/\/[^\s)"'\]]+/g)]
      .map((m) => m[0])
      .filter((u) => !/^(https?:\/\/)?(s\.jina\.ai|r\.jina\.ai)/i.test(u));
    const url = urls[0];
    if (!url) continue;
    const titleLine = (block.match(/^\s*#+\s*(?:Result\s+\d+:\s*)?(.+)$/m) || [])[1] || "";
    out.push({
      title: titleLine.trim(),
      url,
      content: block.replace(/https?:\/\/\S+/g, "").replace(/\n+/g, " ").trim().slice(0, 600),
    });
  }
  return out;
}

// Extract the main article body as clean text via Jina's reader endpoint.
async function jinaExtract(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`https://r.jina.ai/${url}`, {
      headers: jinaHeaders(),
      signal: controller.signal,
    });
    if (!resp.ok) throw new Error(`Jina extract HTTP ${resp.status}`);
    return (await resp.text()).replace(/\s+/g, " ").trim();
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Jina extract timed out");
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ===== Website and Video Transcript Extraction — free, no API key needed =====

const SCRAPE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function decodeHtmlEntities(str = "") {
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

function stripHtml(str = "") {
  return decodeHtmlEntities(str.replace(/<[^>]*>/g, "")).trim();
}

function validateSourceUrl(input) {
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error("A valid source URL is required");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only HTTP and HTTPS source URLs are supported");
  }
  if (["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname.toLowerCase())) {
    throw new Error("Local network URLs cannot be scraped");
  }
  return parsed.toString();
}

async function fetchTextResource(url, accept = "text/html,application/xhtml+xml,text/plain", timeoutMs = 20000, userAgent = SCRAPE_USER_AGENT) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(validateSourceUrl(url), {
      headers: { "User-Agent": userAgent, Accept: accept },
      redirect: "follow",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
    return {
      text: await response.text(),
      url: response.url,
      contentType: response.headers.get("content-type") || "",
    };
  } catch (error) {
    if (error.name === "AbortError") throw new Error("Source extraction timed out");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractTitle(html) {
  const openGraph = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i.exec(html);
  if (openGraph) return decodeHtmlEntities(openGraph[1]).trim();
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return match ? stripHtml(match[1]).trim() : "";
}

function extractMetaDescription(html) {
  const match = /<meta[^>]+(?:name|property)=["'](?:description|og:description)["'][^>]+content=["']([^"']+)["'][^>]*>/i.exec(html) ||
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["'](?:description|og:description)["'][^>]*>/i.exec(html);
  return match ? decodeHtmlEntities(match[1]).trim() : "";
}

function collectStructuredArticleBodies(html) {
  const bodies = [];
  const scripts = html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>[\s\S]*?<\/script>/gi) || [];
  const visit = value => {
    if (!value) return;
    if (Array.isArray(value)) return value.forEach(visit);
    if (typeof value !== "object") return;
    if (typeof value.articleBody === "string") bodies.push(value.articleBody);
    if (typeof value.transcript === "string") bodies.push(value.transcript);
    Object.values(value).forEach(visit);
  };
  scripts.forEach(script => {
    const jsonText = script.replace(/^<script[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    try { visit(JSON.parse(jsonText)); } catch { /* Ignore malformed embedded metadata. */ }
  });
  return bodies;
}

function extractMainHtml(html) {
  const candidates = [];
  for (const tag of ["article", "main"]) {
    const regex = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi");
    for (const match of html.matchAll(regex)) candidates.push(match[1]);
  }
  const roleMain = /<([a-z0-9]+)\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(roleMain)) candidates.push(match[2]);
  return candidates.sort((a, b) => stripHtml(b).length - stripHtml(a).length)[0] || html;
}

function cleanExtractedLines(text) {
  const boilerplate = /^(accept (all )?cookies|cookie settings|privacy policy|terms of use|sign in|log in|subscribe|newsletter|advertisement|skip to content|share this|related articles?)$/i;
  const seen = new Set();
  return text
    .split(/\n+/)
    .map(line => line.replace(/[ \t]+/g, " ").trim())
    .filter(line => line && !boilerplate.test(line))
    .filter(line => {
      const key = line.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join("\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractText(html) {
  const structuredBodies = collectStructuredArticleBodies(html);
  if (structuredBodies.length) {
    const structured = cleanExtractedLines(decodeHtmlEntities(structuredBodies.sort((a, b) => b.length - a.length)[0]));
    if (structured.length >= 300) return structured.slice(0, 60000);
  }

  let clean = extractMainHtml(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|nav|header|footer|aside|noscript|svg|form|button)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|h[1-6]|li|tr|article|section|blockquote|figure)[^>]*>/gi, "\n");
  clean = cleanExtractedLines(stripHtml(clean));
  if (clean.length < 200) clean = extractMetaDescription(html) || clean;
  return clean.slice(0, 60000);
}

function getYouTubeVideoId(input) {
  try {
    const url = new URL(input);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (["youtube.com", "m.youtube.com"].includes(host)) {
      if (url.pathname === "/watch") return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      if (["shorts", "embed", "live"].includes(parts[0])) return parts[1] || null;
    }
  } catch { return null; }
  return null;
}

function findJsonArrayAfterMarker(text, marker) {
  const markerIndex = text.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = text.indexOf("[", markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth++;
    else if (char === "]") {
      depth--;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

function parseCaptionText(raw, contentType = "") {
  try {
    if (contentType.includes("json") || raw.trim().startsWith("{")) {
      const json = JSON.parse(raw);
      const chunks = [];
      for (const event of json.events || []) {
        const text = (event.segs || []).map(segment => segment.utf8 || "").join("");
        if (text.trim()) chunks.push(text.trim());
      }
      return cleanExtractedLines(chunks.join(" ").replace(/\s+/g, " "));
    }
  } catch { /* Fall through to XML/VTT parsing. */ }

  if (/^WEBVTT/m.test(raw) || /-->/.test(raw)) {
    const lines = raw.split(/\r?\n/).filter(line => {
      const trimmed = line.trim();
      return trimmed && !/^WEBVTT|^NOTE|^\d+$/.test(trimmed) && !/-->/.test(trimmed);
    });
    return cleanExtractedLines(stripHtml(lines.join(" ")).replace(/\s+/g, " "));
  }

  const textParts = [...raw.matchAll(/<(?:text|p)[^>]*>([\s\S]*?)<\/(?:text|p)>/gi)]
    .map(match => stripHtml(match[1]));
  return cleanExtractedLines(textParts.join(" ").replace(/\s+/g, " "));
}

function extractYouTubeTranscriptWithPython(videoId) {
  return new Promise((resolve, reject) => {
    if (!PYTHON) return reject(new Error("Python not available — transcript extraction disabled on this host"));
    execFile(PYTHON, [TRANSCRIPT_SCRIPT, videoId], { timeout: 30000 }, (error, stdout, stderr) => {
      let parsed;
      try { parsed = JSON.parse(stdout || "{}"); } catch { parsed = null; }
      if (error || parsed?.error || !parsed?.data?.text) {
        return reject(new Error(parsed?.error || stderr || error?.message || "Transcript extraction failed"));
      }
      resolve(parsed.data);
    });
  });
}

async function extractYouTubeTranscript(url, videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const page = await fetchTextResource(watchUrl);
  const title = extractTitle(page.text).replace(/\s*-\s*YouTube\s*$/i, "") || `YouTube video ${videoId}`;
  const tracksJson = findJsonArrayAfterMarker(page.text, '"captionTracks":');
  if (tracksJson) {
    try {
      const tracks = JSON.parse(tracksJson);
      const selected = tracks.find(track => /^en(?:-|$)/i.test(track.languageCode || "")) || tracks[0];
      if (selected?.baseUrl) {
        const transcriptUrl = new URL(selected.baseUrl);
        transcriptUrl.searchParams.set("fmt", "json3");
        const transcriptResponse = await fetchTextResource(transcriptUrl.toString(), "application/json,text/xml,text/plain");
        const text = parseCaptionText(transcriptResponse.text, transcriptResponse.contentType);
        if (text.length >= 80) {
          return {
            title,
            text,
            url: page.url,
            originalUrl: url,
            sourceType: "video-transcript",
            extractionMethod: `YouTube ${selected.kind === "asr" ? "automatic captions" : "captions"}`,
            language: selected.languageCode || "unknown",
          };
        }
      }
    } catch { /* Fall back to the dedicated transcript client below. */ }
  }

  try {
    const transcript = await extractYouTubeTranscriptWithPython(videoId);
    return {
      title,
      text: transcript.text,
      url: page.url,
      originalUrl: url,
      sourceType: "video-transcript",
      extractionMethod: `YouTube ${transcript.generated ? "automatic transcript" : "transcript"}`,
      language: transcript.language || "unknown",
    };
  } catch (error) {
    throw new Error(`This YouTube video does not expose an accessible transcript: ${error.message}`);
  }
}

function findHtmlCaptionTrack(html, pageUrl) {
  const tags = html.match(/<track\b[^>]*>/gi) || [];
  for (const tag of tags) {
    if (!/kind=["'](?:captions|subtitles)["']/i.test(tag)) continue;
    const src = /src=["']([^"']+)["']/i.exec(tag)?.[1];
    if (src) return new URL(decodeHtmlEntities(src), pageUrl).toString();
  }
  return null;
}

async function scrapeUrl(url) {
  const sourceUrl = validateSourceUrl(url);
  const youtubeId = getYouTubeVideoId(sourceUrl);
  if (youtubeId) return extractYouTubeTranscript(sourceUrl, youtubeId);

  const page = await fetchTextResource(sourceUrl);
  if (!page.contentType.includes("html") && !page.contentType.includes("text")) {
    throw new Error(`Unsupported source content type: ${page.contentType || "unknown"}`);
  }

  const title = extractTitle(page.text) || new URL(page.url).hostname;
  const captionTrack = findHtmlCaptionTrack(page.text, page.url);
  if (captionTrack) {
    const captionResponse = await fetchTextResource(captionTrack, "text/vtt,text/plain,text/xml,application/json");
    const transcript = parseCaptionText(captionResponse.text, captionResponse.contentType);
    if (transcript.length >= 80) {
      return {
        title,
        text: transcript,
        url: page.url,
        originalUrl: sourceUrl,
        sourceType: "video-transcript",
        extractionMethod: "Embedded caption track",
        language: "unknown",
      };
    }
  }

  const text = extractText(page.text);
  if (text.length < 80) throw new Error("The page did not contain enough readable text to summarise");
  return {
    title,
    text,
    url: page.url,
    originalUrl: sourceUrl,
    sourceType: "webpage",
    extractionMethod: "Main article/page text",
    language: "unknown",
  };
}

const SUMMARY_STOP_WORDS = new Set([
  "about", "after", "again", "against", "also", "among", "and", "are", "because", "been", "before",
  "being", "between", "both", "but", "can", "could", "did", "does", "each", "for", "from", "had",
  "has", "have", "into", "its", "more", "most", "not", "only", "other", "our", "out", "over", "said",
  "such", "than", "that", "the", "their", "there", "these", "they", "this", "through", "under", "very",
  "was", "were", "what", "when", "where", "which", "while", "who", "will", "with", "would", "you", "your"
]);

function splitSentences(text) {
  return (text || "")
    .replace(/\s+/g, " ")
    .match(/[^.!?]+(?:[.!?]+|$)/g)?.map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 45 && sentence.length <= 500) || [];
}

function meaningfulWords(text) {
  return (String(text || "").toLowerCase().match(/[a-z][a-z0-9'-]{1,}/g) || [])
    .filter(word => (word.length >= 3 || ["ai", "ar", "vr", "xr"].includes(word)) && !SUMMARY_STOP_WORDS.has(word));
}

function isNearDuplicate(a, b, threshold = 0.72) {
  const aWords = new Set(meaningfulWords(a));
  const bWords = new Set(meaningfulWords(b));
  const overlap = [...bWords].filter(word => aWords.has(word)).length;
  return overlap / Math.max(Math.min(aWords.size, bWords.size), 1) > threshold;
}

function refineSentence(sentence) {
  const cleaned = String(sentence || "")
    .replace(/\s+/g, " ")
    .replace(/^(?:read more|advertisement|sponsored content)[:\s-]*/i, "")
    .trim();
  if (cleaned.length <= 360) return cleaned;
  const shortened = cleaned.slice(0, 357);
  const boundary = Math.max(shortened.lastIndexOf(";"), shortened.lastIndexOf(","), shortened.lastIndexOf(" "));
  return `${shortened.slice(0, boundary > 250 ? boundary : 357).trim()}...`;
}

function rankSourceEvidence(text, title = "", focusQuery = "", limit = 5) {
  const normalisedTitle = title.toLowerCase().replace(/\s+/g, " ").trim();
  const sentences = splitSentences(text).slice(0, 600).filter((sentence, index) => {
    const lower = sentence.toLowerCase();
    const boilerplateHits = ["share", "learn more", "sign up", "subscribe", "cookie", "all rights reserved"]
      .filter(term => lower.includes(term)).length;
    if (boilerplateHits >= 2) return false;
    if (index < 4 && normalisedTitle.length > 12 && lower.includes(normalisedTitle.slice(0, 70))) return false;
    return true;
  });
  if (!sentences.length) return [];

  const frequencies = new Map();
  meaningfulWords(sentences.join(" ")).forEach(word => frequencies.set(word, (frequencies.get(word) || 0) + 1));
  const titleWords = new Set(meaningfulWords(title));
  const focusWords = new Set(meaningfulWords(focusQuery));
  const statisticPattern = /(?:\b\d+(?:\.\d+)?%|[$£€¥]\s?\d|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s*(?:million|billion|trillion|percent|users|players|downloads|hours|days|months|years)\b)/i;
  const useCasePattern = /\b(?:use case|used to|using|deployed|implemented|enables?|allows?|powers?|automates?|generates?|assists?|npc|character|player|gameplay|development|production|workflow|personalisation|personalization)\b/i;
  const evidencePattern = /\b(?:according to|reported|found|survey|study|research|data|measured|increased|decreased|reduced|grew|launched|released)\b/i;

  const scored = sentences.map((rawSentence, index) => {
    const sentence = refineSentence(rawSentence);
    const words = meaningfulWords(sentence);
    const unique = [...new Set(words)];
    const focusHits = unique.filter(word => focusWords.has(word)).length;
    const frequencyScore = unique.reduce((total, word) => total + Math.min(frequencies.get(word) || 0, 8), 0) / Math.max(unique.length, 1);
    const titleScore = unique.filter(word => titleWords.has(word)).length * 1.4;
    const focusScore = focusHits * 4.5;
    const positionScore = Math.max(0, 1.4 - index / Math.max(sentences.length, 1));
    const lengthScore = sentence.length >= 75 && sentence.length <= 300 ? 1.1 : 0.2;
    const hasStatistic = statisticPattern.test(sentence);
    const hasUseCase = useCasePattern.test(sentence);
    const evidenceScore = evidencePattern.test(sentence) ? 1.5 : 0;
    const priorityScore = (hasStatistic ? 5 : 0) + (hasUseCase ? 3.5 : 0) + evidenceScore;
    return {
      sentence,
      index,
      hasStatistic,
      hasUseCase,
      focusHits,
      score: frequencyScore + titleScore + focusScore + positionScore + lengthScore + priorityScore,
    };
  });

  const ranked = scored.sort((a, b) => b.score - a.score || a.index - b.index);
  const focused = focusWords.size
    ? ranked.filter(item => item.focusHits > 0 || item.hasStatistic || item.hasUseCase)
    : ranked;
  const candidates = focused.length >= Math.min(2, limit) ? focused : ranked;
  const selected = [];
  for (const item of candidates) {
    if (!item.sentence || selected.some(existing => isNearDuplicate(existing.sentence, item.sentence))) continue;
    selected.push(item);
    if (selected.length >= limit) break;
  }
  return selected;
}

function rankSourceSentences(text, title = "", limit = 4, focusQuery = "") {
  return rankSourceEvidence(text, title, focusQuery, limit).map(item => item.sentence);
}

function buildThematicFindings(evidenceItems) {
  const definitions = [
    { title: "Statistics & Market Signals", words: ["percent", "million", "billion", "revenue", "growth", "users", "players", "downloads", "market", "survey", "data"] },
    { title: "Applied Use Cases & Player Impact", words: ["use", "game", "player", "npc", "character", "gameplay", "personalisation", "personalization", "experience", "content"] },
    { title: "Technology & Product Capabilities", words: ["model", "technology", "system", "platform", "engine", "feature", "tool", "software", "ai", "automation"] },
    { title: "Development & Production", words: ["developer", "studio", "development", "production", "workflow", "testing", "design", "asset", "code", "launch"] },
    { title: "Risk, Policy & Governance", words: ["risk", "regulation", "law", "privacy", "safety", "copyright", "compliance", "policy", "security", "liability"] },
  ];
  const themes = definitions.map(definition => ({ ...definition, findings: [] }));
  const other = { title: "Other Relevant Evidence", findings: [] };

  evidenceItems.sort((a, b) => b.score - a.score).forEach(item => {
    const lower = item.text.toLowerCase();
    const scoredThemes = themes.map((theme, index) => {
      let score = theme.words.filter(word => lower.includes(word)).length;
      if (index === 0 && item.hasStatistic) score += 5;
      if (index === 1 && item.hasUseCase) score += 4;
      return { theme, score };
    }).sort((a, b) => b.score - a.score);
    const target = scoredThemes[0]?.score ? scoredThemes[0].theme : other;
    if (target.findings.length < 5 && !target.findings.some(existing => isNearDuplicate(existing, item.citedText))) {
      target.findings.push(item.citedText);
    }
  });

  return [...themes, other]
    .filter(theme => theme.findings.length)
    .map(({ title, findings }) => ({ title, findings }));
}

function buildCohesiveReport(title, extractedSources, failedSources, totalSources) {
  const sourceSummaries = extractedSources.map((source, index) => {
    const searchQuery = String(source.searchQuery || "").trim();
    const evidence = rankSourceEvidence(source.content, source.title, searchQuery, 4);
    return {
      sourceNumber: index + 1,
      title: source.title,
      url: source.url,
      originalUrl: source.originalUrl,
      sourceType: source.sourceType,
      extractionMethod: source.extractionMethod,
      wordCount: source.wordCount,
      searchQuery,
      summarySentences: evidence.map(item => item.sentence),
      summary: evidence.map(item => item.sentence).join(" "),
      statistics: evidence.filter(item => item.hasStatistic).map(item => item.sentence),
      useCases: evidence.filter(item => item.hasUseCase).map(item => item.sentence),
      evidence,
    };
  });

  const allEvidence = sourceSummaries.flatMap(source => source.evidence.map(item => ({
    ...item,
    text: item.sentence,
    sourceNumber: source.sourceNumber,
    citedText: `${item.sentence} [${source.sourceNumber}]`,
  })));

  const keyFindings = [];
  const rankedEvidence = [...allEvidence].sort((a, b) => {
    const aPriority = a.score + (a.hasStatistic ? 4 : 0) + (a.hasUseCase ? 2.5 : 0);
    const bPriority = b.score + (b.hasStatistic ? 4 : 0) + (b.hasUseCase ? 2.5 : 0);
    return bPriority - aPriority;
  });
  for (const item of rankedEvidence) {
    if (keyFindings.some(existing => isNearDuplicate(existing, item.text))) continue;
    keyFindings.push(item.citedText);
    if (keyFindings.length >= 5) break;
  }

  const themes = buildThematicFindings(allEvidence);
  const sourceSections = sourceSummaries.map(source => {
    const focus = source.searchQuery ? `\nSearch focus: ${source.searchQuery}` : "";
    const bullets = source.summarySentences.length
      ? source.summarySentences.map(sentence => `- ${sentence}`).join("\n")
      : "- No relevant summary could be generated.";
    return `### [${source.sourceNumber}] ${source.title}\nSource: ${source.url}${focus}\nType: ${source.sourceType} — ${source.extractionMethod}\n\n${bullets}`;
  });
  const keyFindingText = keyFindings.length ? keyFindings.map(finding => `- ${finding}`).join("\n") : "- No key findings could be generated.";
  const themeText = themes.map(theme => `### ${theme.title}\n${theme.findings.map(finding => `- ${finding}`).join("\n")}`).join("\n\n");
  const failureText = failedSources.length
    ? `\n\n## Sources Not Extracted\n${failedSources.map(source => `- ${source.url}: ${source.error}`).join("\n")}`
    : "";
  const sourceIndex = extractedSources.map((source, index) => `${index + 1}. ${source.title} — ${source.url}`).join("\n");

  return {
    title,
    generatedAt: new Date().toISOString(),
    sourcesScraped: extractedSources.length,
    totalSources,
    keyFindings,
    themes,
    sourceSummaries: sourceSummaries.map(({ evidence, ...summary }) => summary),
    failedSources,
    sources: sourceSummaries.map(source => ({
      number: source.sourceNumber,
      url: source.url,
      originalUrl: source.originalUrl,
      title: source.title,
      sourceType: source.sourceType,
      extractionMethod: source.extractionMethod,
      wordCount: source.wordCount,
      searchQuery: source.searchQuery,
    })),
    fullContent: `# ${title}\n\n## Key Findings\n${keyFindingText}\n\n## Topics\n${themeText || "No topical findings could be generated."}\n\n## Source Summaries\n${sourceSections.join("\n\n---\n\n")}\n\n## Source Index\n${sourceIndex}${failureText}`,
  };
}

// ===== Competitor keywords =====

const COMPETITOR_KEYWORDS = [
  "NetEase AI gaming technology investment acquisition",
  "miHoYo HoYoverse AI technology new game",
  "Sony PlayStation AI gaming technology",
  "Microsoft Xbox AI gaming cloud technology",
  "Epic Games AI Unreal Engine technology",
  "Unity AI game engine technology",
  "Roblox AI gaming platform generative",
  "Electronic Arts AI gaming technology",
  "Ubisoft AI gaming technology Ghostwriter",
  "Take-Two Interactive AI gaming technology",
  "Valve Steam AI gaming technology",
  "ByteDance gaming AI technology",
  "Nintendo AI gaming technology",
  "Krafton PUBG AI technology",
  "Netmarble AI gaming technology",
  "NCSoft AI gaming technology",
  "Nexon AI gaming technology",
  "Sea Limited Garena AI gaming",
  "Kakao Games AI technology",
  "Infold Games AI technology",
  "Google DeepMind Genie world model gaming",
  "Meta AI gaming generative video",
  "Mistral AI gaming technology",
];

// Domains to exclude from news results (encyclopedias, company homepages, etc.)
const NEWS_EXCLUDED_DOMAINS = [
  "wikipedia.org",
  "wikidata.org",
  "britannica.com",
  "crunchbase.com",
  "linkedin.com",
  "bloomberg.com/profile",
];

// ===== API ROUTES =====

// POST /api/search — Tavily web search (requires TAVILY_API_KEY)
app.post("/api/search", async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    const results = await tavilySearch(query, limit);
    res.json({ success: true, data: results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summarise/status — describe the local evidence and model setup.
// The AI model is OPT-IN: the default answer mode is extractive-citation (Q&A).
app.get("/api/summarise/status", (req, res) => {
  try {
    res.json({
      success: true,
      corpusItems: buildCorpus().length,
      model: DEFAULT_MODEL,
      license: "open-weight (hosted)",
      localModel: false,
      modelOptIn: true,
      defaultMode: "extractive-citation",
      modelLoaded: isModelReady(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/summarise/warm — preload the opt-in AI model in the background so the
// first real useModel request is fast. Never blocks the caller.
app.post("/api/summarise/warm", (req, res) => {
  if (process.env.SUMMARY_DISABLE_MODEL === "1") {
    return res.json({ success: true, warming: false, reason: "disabled" });
  }
  warmUpModel();
  res.json({ success: true, warming: true });
});

// POST /api/summarise — answer questions from app data with optional web evidence.
// Default mode is extractive-citation (fast, fully cited, accurate). The hosted
// open-source model is used only when the caller opts in with useModel=true;
// if the model API is unavailable or fails, the response gracefully falls back
// to the detailed extractive answer.
app.post("/api/summarise", async (req, res) => {
  try {
    const question = String(req.body?.question || "").replace(/\s+/g, " ").trim();
    const useInternet = req.body?.useInternet === true;
    const useModel = req.body?.useModel === true;
    if (!question) return res.status(400).json({ error: "Enter a question" });
    if (question.length > 700) return res.status(400).json({ error: "Question must be 700 characters or fewer" });

    const appEvidence = [];
    try {
      appEvidence.push(...retrieveApplicationEvidence(question, 9));
    } catch (err) {
      console.warn("[summarise] evidence retrieval failed:", err.message);
    }
    let webEvidence = [];
    let webSearchError = "";

    if (useInternet) {
      try {
        const webResults = await tavilySearch(`${question} latest evidence official`, 5);
        webEvidence = webResults
          .filter(item => item.url && (item.title || item.description))
          .slice(0, 5)
          .map((item, index) => ({
            id: `W${index + 1}`,
            sourceType: "internet",
            dataset: "Internet search",
            title: item.title || item.url,
            section: "Additional evidence",
            text: String(item.description || item.title || "").slice(0, 900),
            excerpt: String(item.description || item.title || "").slice(0, 360),
            url: item.url,
          }));
      } catch (error) {
        webSearchError = error.message;
      }
    }

    const evidence = [...appEvidence, ...webEvidence];
    let answer;
    let mode;
    let modelError = "";
    let modelTimer;

    if (useModel) {
      // Kick off a background warm-up so subsequent requests are fast; the first
      // opt-in request may still finish loading within the timeout window.
      warmUpModel();
      mode = "local-open-source-model";
      try {
        answer = await Promise.race([
          generateOpenSourceAnswer(question, evidence),
          new Promise((_, reject) => {
            modelTimer = setTimeout(
              () => reject(new Error("Local model is still warming up; an extractive summary was returned. Try again in a moment for an AI synthesis.")),
              70000
            );
          }),
        ]);
      } catch (error) {
        modelError = error.message;
        mode = "extractive-fallback";
        answer = buildExtractiveAnswer(question, evidence);
      } finally {
        clearTimeout(modelTimer);
      }
    } else {
      mode = "extractive-citation";
      answer = buildExtractiveAnswer(question, evidence);
    }

    res.json({
      success: true,
      answer,
      question,
      internetUsed: webEvidence.length > 0,
      webSearchError,
      model: {
        name: DEFAULT_MODEL,
        license: "open-weight (hosted)",
        mode,
        error: modelError,
        optIn: true,
      },
      sources: evidence.map(({ id, sourceType, dataset, title, section, url, text, excerpt }) => ({
        id,
        sourceType,
        dataset,
        title,
        section,
        url,
        excerpt: String(excerpt || text || "").slice(0, 360),
      })),
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news — multi-topic live news search using public RSS feeds.
// Google News RSS works without an API key or Python, making it reliable on Render.
// The bundled JSON cache remains the final fallback if every live feed fails.
const NEWS_TOPICS = [
  {
    label: "AI Technology Trends",
    queries: ["generative AI gaming world models agents video 3D technology"],
  },
  {
    label: "AI Regulation",
    queries: ["EU UK AI regulation big tech compliance enforcement copyright transparency"],
  },
  {
    label: "Current Use Cases",
    queries: ["AI gaming use cases NPC procedural content game development entertainment"],
  },
  {
    label: "Competitor News",
    queries: ["Tencent gaming AI technology news"],
  },
];

const DEFAULT_NEWS_COMPETITOR_IDS = ["netease", "mihoyo", "sony", "microsoft"];
let newsCompetitorCatalog = [];
try {
  const networkData = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "network.json"), "utf8"));
  newsCompetitorCatalog = networkData.competitors || [];
} catch (_) { /* News still works with broad topic searches. */ }

function resolveNewsCompetitors(value = "") {
  const requested = String(value).split(",").map(id => id.trim()).filter(Boolean);
  const ids = requested.length ? requested : DEFAULT_NEWS_COMPETITOR_IDS;
  const allowed = new Map(newsCompetitorCatalog.map(company => [company.id, company]));
  return [...new Set(ids)].map(id => allowed.get(id)).filter(Boolean);
}

let bundledNewsCache = null;
const newsCacheBySelection = new Map();
try {
  bundledNewsCache = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "news-cache.json"), "utf8"));
} catch (_) { /* no cache file yet */ }

function newsCompetitorAliases(company) {
  return company.name
    .split(/\s*\/\s*|\s+x\s+/i)
    .map(alias => alias.replace(/\s*\([^)]*\)\s*/g, " ").trim())
    .filter(alias => alias.length > 2);
}

function newsSelectionKey(competitors) {
  return competitors.map(company => company.id).sort().join(",");
}

function getNewsFallback(competitors) {
  const exact = newsCacheBySelection.get(newsSelectionKey(competitors));
  if (exact?.articles?.length) return exact;
  if (!bundledNewsCache?.articles?.length) return null;

  const aliases = competitors.flatMap(newsCompetitorAliases).map(alias => alias.toLowerCase());
  const articles = bundledNewsCache.articles.filter(article => {
    const text = `${article.title || ""} ${article.description || ""} ${article.competitorKeyword || ""}`.toLowerCase();
    return aliases.some(alias => text.includes(alias));
  });

  if (!articles.length) return null;
  return {
    generatedAt: bundledNewsCache.generatedAt,
    source: bundledNewsCache.source,
    count: articles.length,
    articles,
  };
}

function extractXmlTag(xml, tag) {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml);
  return match ? stripHtml(match[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "";
}

function parseNewsRss(xml, topicLabel, query, limit = 6, candidateCompetitors = []) {
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null && articles.length < limit) {
    const item = match[1];
    const title = extractXmlTag(item, "title");
    const url = extractXmlTag(item, "link");
    const description = extractXmlTag(item, "description");
    const publishedAt = extractXmlTag(item, "pubDate");
    const sourceName = extractXmlTag(item, "source");

    if (!title || !url) continue;
    if (NEWS_EXCLUDED_DOMAINS.some(domain => url.toLowerCase().includes(domain))) continue;

    const articleText = `${title} ${description}`.toLowerCase();
    const matchedCompetitor = candidateCompetitors.find(company =>
      newsCompetitorAliases(company).some(alias => articleText.includes(alias.toLowerCase()))
    );

    articles.push({
      title,
      url,
      description,
      competitorKeyword: matchedCompetitor?.name || topicLabel,
      topicCategory: topicLabel,
      competitorName: matchedCompetitor?.name || null,
      searchQuery: query,
      sourceName,
      publishedAt: publishedAt && !Number.isNaN(Date.parse(publishedAt))
        ? new Date(publishedAt).toISOString()
        : null,
    });
  }

  return articles;
}

async function searchGoogleNewsRss(query, topicLabel, limit = 6, candidateCompetitors = []) {
  const freshnessQuery = `${query} when:60d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(freshnessQuery)}&hl=en-GB&gl=GB&ceid=GB:en`;
  const resource = await fetchTextResource(url, "application/rss+xml,application/xml,text/xml");
  return parseNewsRss(resource.text, topicLabel, query, limit, candidateCompetitors);
}

function buildCompetitorNewsQueries(competitors) {
  const batches = [];
  for (let index = 0; index < competitors.length; index += 5) {
    const batch = competitors.slice(index, index + 5);
    const names = batch.flatMap(newsCompetitorAliases).map(alias => `"${alias}"`).join(" OR ");
    batches.push({
      query: `(${names}) AI gaming technology news`,
      competitors: batch,
    });
  }
  return batches;
}

async function getLiveNewsArticles(selectedCompetitors = []) {
  const topicSearches = NEWS_TOPICS.flatMap(topic =>
    topic.queries.map(query => searchGoogleNewsRss(query, topic.label, 6))
  );
  const competitorSearches = buildCompetitorNewsQueries(selectedCompetitors).map(batch =>
    searchGoogleNewsRss(batch.query, "Competitor News", 8, batch.competitors)
  );
  const searches = [...topicSearches, ...competitorSearches];
  const settled = await Promise.allSettled(searches);
  const seen = new Set();
  const articles = [];

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const article of result.value) {
      // Google News may surface the same story in several queries.
      const key = article.url || article.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      articles.push(article);
    }
  }

  articles.sort((a, b) => {
    const dateA = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const dateB = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return dateB - dateA;
  });

  return articles.slice(0, 40);
}

app.get("/api/news", async (req, res) => {
  res.set("Cache-Control", "no-store, max-age=0");

  try {
    const monitoredCompetitors = resolveNewsCompetitors(req.query.competitors);
    const liveArticles = await getLiveNewsArticles(monitoredCompetitors);

    if (liveArticles.length > 0) {
      const searchedAt = new Date().toISOString();
      newsCacheBySelection.set(newsSelectionKey(monitoredCompetitors), {
        generatedAt: searchedAt,
        source: "Google News RSS",
        count: liveArticles.length,
        articles: liveArticles,
      });

      return res.json({
        success: true,
        count: liveArticles.length,
        articles: liveArticles,
        topics: NEWS_TOPICS.map(topic => topic.label),
        monitoredCompetitors: monitoredCompetitors.map(company => ({ id: company.id, name: company.name })),
        searchedAt,
        live: true,
        cached: false,
      });
    }

    // Promise.allSettled does not throw when all searches fail, so an explicit
    // empty-result fallback is required here (the previous implementation missed it).
    const fallback = getNewsFallback(monitoredCompetitors);
    if (fallback?.articles?.length) {
      return res.json({
        success: true,
        count: fallback.articles.length,
        articles: fallback.articles,
        topics: NEWS_TOPICS.map(topic => topic.label),
        monitoredCompetitors: monitoredCompetitors.map(company => ({ id: company.id, name: company.name })),
        searchedAt: fallback.generatedAt,
        live: false,
        cached: true,
      });
    }

    return res.status(503).json({ error: "No live or cached news articles are available" });
  } catch (err) {
    const monitoredCompetitors = resolveNewsCompetitors(req.query.competitors);
    const fallback = getNewsFallback(monitoredCompetitors);
    if (fallback?.articles?.length) {
      return res.json({
        success: true,
        count: fallback.articles.length,
        articles: fallback.articles,
        topics: NEWS_TOPICS.map(topic => topic.label),
        monitoredCompetitors: monitoredCompetitors.map(company => ({ id: company.id, name: company.name })),
        searchedAt: fallback.generatedAt,
        live: false,
        cached: true,
      });
    }
    return res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// Curated Source Monitor (Scope C, P1–P3) — verify & propose, never auto-apply
// Each source is monitored via domain-scoped Google News RSS (site:<domain>) so
// results stay official/accurate. Fetched items are (1) filtered to English only,
// (2) compared against the EXISTING curated datasets, and (3) surfaced ONLY as
// PROPOSED CHANGES when they would genuinely update / expand / correct existing
// content (or are a clearly new, covered topic). The user reviews and approves
// each one — nothing is written back to the app automatically.
// ============================================================================
const SOURCES_FILE = path.join(__dirname, "data", "sources.json");
const SOURCE_STATE_FILE = path.join(__dirname, "data", "source-state.json");
const PROPOSED_FILE = path.join(__dirname, "data", "proposed-changes.json");

let sourcesCache = null;
let sourceState = loadSourceState();
let proposedChanges = loadProposed();
let sourceScanInFlight = false;

// Cache of resolved real article URLs (Google News redirect -> publisher URL),
// persisted via sourceState.resolvedUrls so we rarely re-query a search engine.
const resolvedUrlMap = new Map();
// Serialize DuckDuckGo URL resolutions so we never hit DDG in parallel (which
// triggers rate limiting), and enforce a small minimum gap between calls.
let ddgResolveChain = Promise.resolve();
let lastDdgResolve = 0;
// Secondary resolver: GDELT DOC API (returns real publisher URLs directly, no
// HTML scraping). It is stricter on rate limits (≈1 req / 5s) so we serialize it
// on its own slower chain, and only reach for it after DuckDuckGo fails.
let gdeltResolveChain = Promise.resolve();
let lastGdeltResolve = 0;
// Rotate User-Agents across resolver requests. A single fixed UA is exactly what
// search engines fingerprint and challenge, so cycling a small pool of realistic
// desktop UAs measurably reduces the DuckDuckGo 202 bot-challenge in production.
const RESOLVER_UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0",
];
let resolverUaIdx = 0;
function nextResolverUa() {
  const ua = RESOLVER_UAS[resolverUaIdx % RESOLVER_UAS.length];
  resolverUaIdx++;
  return ua;
}

function loadSourceRegistry() {
  if (!sourcesCache) {
    try {
      sourcesCache = JSON.parse(fs.readFileSync(SOURCES_FILE, "utf8")).sources || [];
    } catch (_) {
      sourcesCache = [];
    }
  }
  return sourcesCache;
}

function loadSourceState() {
  try {
    const data = JSON.parse(fs.readFileSync(SOURCE_STATE_FILE, "utf8"));
    if (data && typeof data === "object" && data.resolvedUrls) {
      for (const [k, v] of Object.entries(data.resolvedUrls)) resolvedUrlMap.set(k, v);
    }
    return data && typeof data === "object" ? data : { sources: {}, lastFullScan: null };
  } catch (_) {
    return { sources: {}, lastFullScan: null };
  }
}

function saveSourceState() {
  try {
    fs.writeFileSync(SOURCE_STATE_FILE, JSON.stringify(sourceState, null, 2));
  } catch (_) { /* non-fatal */ }
}

function loadProposed() {
  try {
    const data = JSON.parse(fs.readFileSync(PROPOSED_FILE, "utf8"));
    return {
      items: Array.isArray(data.items) ? data.items : [],
      dismissedIds: Array.isArray(data.dismissedIds) ? data.dismissedIds : [],
      integratedIds: Array.isArray(data.integratedIds) ? data.integratedIds : [],
    };
  } catch (_) {
    return { items: [], dismissedIds: [], integratedIds: [] };
  }
}

function saveProposed() {
  try {
    fs.writeFileSync(PROPOSED_FILE, JSON.stringify(proposedChanges, null, 2));
  } catch (_) { /* non-fatal */ }
}

// ---- Text helpers: English filter + keyword/anchor overlap matching ----
const STOPWORDS = new Set(
  "the a an and or of to in for on with by from as at is are was were be been being this that these those it its their his her our your we you they he she new latest update via per into about within across after before between during over under".split(" ")
);
// Specific AI-regulation "anchor" terms. A fetched item only counts as relevant
// (and only matches / qualifies as a proposable "new" item) when it shares one of
// these with an existing record or is itself clearly about AI regulation/policy.
const STRONG_TERMS = [
  "ai act", "eu ai act", "eu ai", "uk ai", "ai regulation", "ai policy",
  "gdpr", "data protection", "ico", "edpb", "ai safety", "ai governance",
  "frontier model", "frontier models", "model evaluation", "foundation model",
  "copyright", "ai risk", "high-risk", "high risk", "ai office", "aisi", "oecd",
  "council of europe", "ai convention", "algorithm", "machine learning",
  "ai compliance", "ai enforcement", "responsible ai", "ai transparency",
];
function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[a-z][a-z0-9'-]{2,}/g) || [])
    .filter(w => !STOPWORDS.has(w));
}
function strongTermsIn(text) {
  const t = String(text || "").toLowerCase();
  const toks = new Set(tokenize(t));
  const found = new Set();
  for (const term of STRONG_TERMS) {
    if (term.includes(" ")) { if (t.includes(term)) found.add(term); }
    else if (toks.has(term)) found.add(term);
  }
  return found;
}
function sharedCount(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n;
}
// Ranges covering non-Latin scripts (CJK, Cyrillic, Greek, Arabic, Hebrew,
// Devanagari, Thai, Kana) used to reject clearly non-English items.
const NON_LATIN = /[㐀-鿿぀-ヿ\u0400-\u04FF\u0370-\u03FF\u0600-\u06FF\u0590-\u05FF\u0900-\u097F\u0E00-\u0E7F]/;
function isLikelyEnglish(text) {
  const t = String(text || "").replace(/<[^>]+>/g, " ");
  const nonLatin = (t.match(NON_LATIN) || []).length;
  if (nonLatin > 6) return false; // a solid block of non-Latin -> not English
  const tokens = t.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return true;
  let latin = 0;
  for (const tk of tokens) {
    if (/^[A-Za-z0-9'’.,:;”’“()\-\/!?]+$/.test(tk)) latin++;
  }
  return latin / tokens.length >= 0.6;
}
function overlap(aSet, bSet) {
  if (!aSet.size || !bSet.size) return { shared: 0, score: 0 };
  let shared = 0;
  for (const t of aSet) if (bSet.has(t)) shared++;
  const score = shared / (aSet.size + bSet.size - shared); // Jaccard
  return { shared, score };
}
function hashId(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return "pc_" + (h >>> 0).toString(36);
}

// Build an index of the EXISTING curated content so we can tell whether a fetched
// item is already covered, expands an entry, or is genuinely new.
function buildExistingIndex() {
  const records = [];
  const push = (dataset, recordId, title, text) => {
    const full = `${title || ""} ${text || ""}`;
    const t = tokenize(full);
    if (!t.length) return;
    records.push({ dataset, recordId, title: title || "", tokens: new Set(t), strong: strongTermsIn(full) });
  };
  try {
    const tl = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "regulatory-timeline.json"), "utf8"));
    (tl.events || []).forEach((e, i) =>
      push("timeline", `timeline:${i}`, e.title, `${e.title} ${e.description || ""} ${e.jurisdiction || ""} ${e.category || ""}`));
  } catch (_) {}
  try {
    const kb = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "knowledge.json"), "utf8"));
    for (const [k, cat] of Object.entries(kb.categories || {})) {
      (cat.subsections || []).forEach((s, i) => push("knowledge", `knowledge:${k}:${i}`, s.title, `${s.title} ${s.content || ""}`));
    }
  } catch (_) {}
  try {
    const uc = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "current-use-cases.json"), "utf8"));
    (uc.patterns || []).forEach((p, i) => push("use-cases", `uc:${i}`, p.title, `${p.title} ${p.content || ""} ${(p.games || []).join(" ")}`));
  } catch (_) {}
  return records;
}

function bestMatch(itemTokens, itemStrong, index) {
  let best = null;
  for (const rec of index) {
    const { shared, score } = overlap(itemTokens, rec.tokens);
    const sharedStrong = rec.strong ? sharedCount(rec.strong, itemStrong) : 0;
    // Match only when there is a strong AI-regulation anchor in common AND at
    // least one other shared term (precise, avoids trivial "ai"-only matches),
    // or a solid general-text overlap.
    const isMatch = (sharedStrong >= 1 && shared >= 1) || (score >= 0.12 && shared >= 2);
    if (!isMatch) continue;
    const rank = (sharedStrong >= 1 ? 1 : 0) + score;
    if (!best || rank > best.rank) best = { ...rec, shared, score, sharedStrong, rank };
  }
  return best;
}

// Decide which Knowledge Base category a proposed item belongs to, based on the
// ARTICLE CONTENT (not just the source's category). This fixes the case where a
// regulator (e.g. AISI) publishes a model-capability assessment that should land
// under "Case Studies", not "Regulations".
const CATEGORY_LABELS = {
  "regulations": "Regulatory Development",
  "case-studies": "Case Study",
  "technology": "Technology",
  "use-cases": "AI Use Case",
  "strategic-insights": "Strategic Insight",
  "competitors": "Competitor Note",
  "tencent-products": "Tencent Product",
  "current-game-ai": "Current Game AI",
};
const NAMED_MODEL = /\b(gpt-?[345]\b|claude|gemini|llama|kimi|qwen|mistral|grok|deepseek|ernie|yi-|phi-|mixtral|o[13]\b|gpt4|gpt5)\b/;

// ---- Proposed-change "why suggested" taxonomy. This is intentionally SEPARATE
// from detectedAction (which describes the integration action: update/deadline/
// correction/new). These buckets answer WHY an update is proposed so the user
// can group/skim them and compare each one against the existing app entry.
const UPDATE_REASON_KEYS = ["information-outdated", "additional-information", "new-case-study", "new-deadline", "new-development"];
const UPDATE_REASON_LABELS = {
  "information-outdated": "Information Outdated",
  "additional-information": "Additional Information",
  "new-case-study": "New Case Study",
  "new-deadline": "New Deadline",
  "new-development": "New Development",
};
// Few-shot anchors so the model's rewrite matches the app's house style (formal,
// neutral, evidential, concrete figures/dates). These facts are illustrative
// only — the model must use the supplied excerpt, never these examples.
const STYLE_EXAMPLES = `Example entries (match the register only, do NOT reuse these facts):
"On 23 July 2026, the European Commission fined Google (Alphabet) €890 million under the Digital Markets Act: €460M for self-preferencing in Search, €430M for anti-steering on Google Play. This signals the enforcement posture organisations should anticipate as AI obligations become operational."
"Unlike the EU's single horizontal AI law, the UK relies on five principles implemented through existing regulators (ICO, Ofcom, CMA, FCA), creating a dual compliance burden for multinationals."`;
function detectKnowledgeCategory(text, sourceCategory) {
  const t = String(text || "").toLowerCase();
  const caseStudy = /\b(assessment|evaluation|preliminary assessment|benchmark|capabilit|cyber capab|red[ -]?team|model card|safety (case|test)|case study|proliferation|frontier model)\b/;
  const regulation = /\b(ai act|eu ai|uk ai|gdpr|data protection|\bico\b|\bedpb\b|legislation|directive|compliance|deadline|enforce|ruling|fine\b|ban\b|prohibit|regulat|policy|guidance|bill\b|\blaw\b)\b/;
  const technology = /\b(architecture|algorithm|training|inference|dataset|technique|framework|tooling|method)\b/;
  if (caseStudy.test(t) || NAMED_MODEL.test(t)) return "case-studies";
  if (regulation.test(t)) return "regulations";
  if (sourceCategory === "use-case") return "use-cases";
  if (technology.test(t)) return "technology";
  // Default for regulator/academic "new" items that read like an assessment or
  // research note rather than a law.
  return "case-studies";
}

// Google News RSS <link> values are redirect URLs that loop back to the Google
// News SPA server-side (they never reach the publisher). Resolve the real article
// URL by searching DuckDuckGo for the title on the source's own domain and
// decoding the `uddg` redirect param. Serialized + paced via ddgResolveChain so
// we never hammer DDG in parallel (which triggers rate limiting). Cached so we
// rarely re-query. Best-effort: returns null on any failure. Falls back to the
// GDELT DOC API if DuckDuckGo can't resolve the URL.
async function resolveGoogleNewsUrl(googleUrl, title, domain) {
  if (resolvedUrlMap.has(googleUrl)) return resolvedUrlMap.get(googleUrl);
  const cacheAndReturn = (real) => {
    if (!real) return null;
    resolvedUrlMap.set(googleUrl, real);
    if (!sourceState.resolvedUrls) sourceState.resolvedUrls = {};
    sourceState.resolvedUrls[googleUrl] = real;
    return real;
  };
  // 0) Jina Reader (keyless) — tried first when SEARCH_PROVIDER=jina. Resolves
  //    the title to the real publisher URL via Jina's search endpoint, which
  //    works from any IP (no DDG/GDELT bot-challenge). Falls back to DDG/GDELT
  //    if Jina is unavailable or rate-limited.
  if (activeSearchProvider() === "jina") {
    try {
      const hit = (await jinaSearch(`${title}${domain ? ` site:${domain}` : ""}`, 5))[0];
      if (hit && hit.url) return cacheAndReturn(hit.url);
    } catch (e) {
      console.warn("[resolve] Jina failed, falling back to DDG/GDELT:", e.message);
    }
  }
  // One DuckDuckGo attempt, serialized + paced + rotating UA. Returns the decoded
  // publisher URL or null. We try a few query variants (most specific first) to
  // maximise the chance of a hit despite DDG's occasional challenge page.
  const tryDdg = (queryTitle) => {
    const task = ddgResolveChain.then(async () => {
      const minGap = 700;
      const wait = lastDdgResolve + minGap - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastDdgResolve = Date.now();
      if (!queryTitle) return null;
      const site = domain ? ` site:${domain}` : "";
      const q = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(`${queryTitle}${site}`)}`;
      try {
        const res = await fetchTextResource(q, "text/html,application/xhtml+xml,text/plain", 6000, nextResolverUa());
        const uddg = (res.text.match(/uddg=([^&"'\s]+)/) || [])[1];
        if (!uddg) return null;
        const real = decodeURIComponent(uddg);
        return /^https?:\/\//i.test(real) ? real : null;
      } catch {
        return null;
      }
    });
    // Reassign so the next call (title-only fallback) chains AFTER this one,
    // keeping DDG strictly serialised.
    ddgResolveChain = task.catch(() => null);
    return task;
  };
  // 1) DuckDuckGo (primary): title + site, then title alone (broader).
  const ddgUrl = (await tryDdg(title)) || (await tryDdg(String(title).replace(/\s*[–—-]\s*[^–—-]+$/, "").trim() || title));
  if (ddgUrl) return cacheAndReturn(ddgUrl);
  // 2) GDELT DOC API (secondary): real publisher URLs directly. Reached only when
  //    DDG fails, so rarely exercised — but it gives the scan a second (third)
  //    chance to fetch a real preview in production.
  const gdeltUrl = await resolveViaGdelt(title, domain);
  return cacheAndReturn(gdeltUrl);
}

// Resolve an article to its real publisher URL via the GDELT DOC API. GDELT
// needs a slower pace (≈1 req / 5s) and a well-formed query, so we serialise it
// on its own chain. We only accept a result whose domain actually matches the
// source, so we never inject an unrelated article. Returns null on any failure.
async function resolveViaGdelt(title, domain) {
  if (!title || !domain) return null;
  // Try an exact quoted phrase first, then a looser keyword query, so a partial
  // title still has a chance of matching the article in GDELT's index.
  const queries = [];
  const clean = String(title).replace(/\s*[–—-]\s*[^–—-]+$/, "").trim() || title;
  queries.push(`domain:${domain} "${clean}"`);
  const kw = clean.split(/\s+/).filter(w => w.length > 3).slice(0, 6).join(" ");
  if (kw && kw !== clean) queries.push(`domain:${domain} ${kw}`);
  const task = gdeltResolveChain.then(async () => {
    const dm = domain.replace(/^www\./i, "");
    for (const q of queries) {
      const minGap = 5500;
      const wait = lastGdeltResolve + minGap - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      lastGdeltResolve = Date.now();
      const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(q)}&mode=ArtList&maxrecords=10&format=json&sortby=datedesc`;
      try {
        const res = await fetchTextResource(url, "application/json,text/plain", 6000, nextResolverUa());
        const j = JSON.parse(res.text);
        const arts = j.articles || [];
        const match = arts.find(a => a.domain && a.domain.replace(/^www\./i, "").includes(dm)) || arts[0];
        if (!match || !/^https?:\/\//i.test(match.url)) continue;
        // Guard against an aggregator that GDELT mislabels with our domain.
        try {
          const host = new URL(match.url).hostname.replace(/^www\./i, "");
          if (!host.includes(dm)) continue;
        } catch { continue; }
        return match.url;
      } catch {
        continue;
      }
    }
    return null;
  });
  gdeltResolveChain = task.catch(() => null);
  return task;
}

// Build a short lead excerpt to PREVIEW the text a proposed change would add.
// Strategy (reliable + low-cost first, network only when needed):
//   1. If the RSS description already summarises the article (substantive content
//      beyond the headline + publisher name), use it directly — no fetch, no rate
//      limits. We explicitly reject "Title - Publisher" packaging, which Google
//      News often returns instead of a summary.
//   2. Otherwise (thin snippet) try to fetch the real article. Google News RSS
//      links can't be followed to the publisher server-side, so resolve the real
//      URL via DuckDuckGo/GDELT (serialized + cached) and extract the body.
// Returns null if nothing usable — the caller then falls back to the headline.
async function fetchArticlePreview(item, { timeoutMs = 12000, maxChars = 720, domain } = {}) {
  if (!item) return null;
  const snippetText = stripHtml(item.snippet || item.description || "").replace(/\s+/g, " ").trim();
  const titleText = String(item.title || "").toLowerCase();
  // A snippet is only usable if it carries real information BEYOND the headline
  // and publisher name. Google News frequently returns just "Title - Publisher",
  // which is NOT a summary — in that case we must fetch the article body instead.
  const publisher = String(item.publisher || item.sourceName || "").toLowerCase();
  const extra = snippetText.toLowerCase()
    .replace(titleText, "")
    .replace(publisher, "")
    .replace(/[–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const snippetIsThin = snippetText.length < 120 || extra.length < 40;

  if (!snippetIsThin) {
    const sentences = snippetText.match(/[^.!?]+[.!?]+/g) || [snippetText];
    let lead = sentences.slice(0, 3).join(" ").trim();
    if (lead.length > maxChars) lead = lead.slice(0, maxChars).trim().replace(/[,;]\s*$/, "") + "…";
    return lead;
  }

  if (!item.url) return null;
  let articleUrl = item.url;
  if (/news\.google\.com/i.test(articleUrl)) {
    const real = await resolveGoogleNewsUrl(item.url, item.title, domain);
    if (!real) return null;
    articleUrl = real;
  }
  try {
    let body;
    if (activeSearchProvider() === "jina") {
      body = await jinaExtract(articleUrl, timeoutMs);
    } else {
      const resource = await fetchTextResource(articleUrl, "text/html,application/xhtml+xml,text/plain", timeoutMs);
      body = extractText(resource.text).replace(/\s+/g, " ").trim();
    }
    if (body.length < 140) return null;
    const sentences = body.match(/[^.!?]+[.!?]+/g) || [body];
    let lead = sentences.slice(0, 4).join(" ").trim();
    if (lead.length > maxChars) lead = lead.slice(0, maxChars).trim().replace(/[,;]\s*$/, "") + "…";
    return lead;
  } catch {
    return null;
  }
}

// Run an async mapper over items with bounded concurrency (so a slow article
// fetch doesn't serialize the whole scan).
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// P3 — auto-draft the suggested edit shown in the review panel (pre-filled). The
// draft now embeds a real preview of the source text when available, so the
// proposed change reads like the curated entries already on the app.
function draftEdit(item, action, publisher, label, preview) {
  const cite = ` [Source: ${publisher}, ${label}]`;
  const info = (preview || stripHtml(item.snippet || item.description || "")).trim();
  const body = info ? `${info} ` : "";
  if (action === "deadline") return `New compliance deadline announced: ${item.title}. ${body}${cite}`;
  if (action === "correction") return `This position appears to have changed — ${item.title}. ${body}${cite}`;
  return `Latest (${label}): ${body}${cite}`;
}
function draftNewRecord(item, publisher, label, categoryKey, preview) {
  const cite = `Source: ${publisher} (${label}).`;
  const body = (preview || stripHtml(item.snippet || item.description || "")).trim();
  const catLabel = CATEGORY_LABELS[categoryKey] || "Knowledge Entry";
  if (!body) return `Add as new ${catLabel} — "${item.title}". ${cite}`;
  return `Add as new ${catLabel} — "${item.title}".\n\n${body}\n\n${cite} Verify details against the official source before relying on this entry.`;
}

// Strip ```json ... ``` fences the model sometimes wraps around JSON output.
function stripFences(s) {
  const t = String(s || "").trim();
  if (t.startsWith("```")) return t.replace(/^```[a-zA-Z]*\n?/, "").replace(/```$/, "").trim();
  return t;
}

// Look up the curated content of an existing matched record so the model can
// frame a rewrite as a DELTA against what the app already says.
function existingRecordContent(matched) {
  if (!matched || !matched.dataset) return "";
  try {
    if (matched.dataset === "timeline") {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "regulatory-timeline.json"), "utf8"));
      const ev = (data.events || []).find(e => e.title === matched.title);
      return ev ? ev.description || "" : "";
    }
    if (matched.dataset === "use-cases") {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "current-use-cases.json"), "utf8"));
      const p = (data.patterns || []).find(p => p.title === matched.title);
      return p ? p.content || "" : "";
    }
    if (matched.dataset === "knowledge") {
      const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "knowledge.json"), "utf8"));
      for (const cat of Object.values(data.categories || {})) {
        const sub = (cat.subsections || []).find(s => s.title === matched.title);
        if (sub) return sub.content || "";
      }
    }
  } catch { /* best effort */ }
  return "";
}

// Deterministic fallback when the model is unavailable: map the already-known
// detectedAction / target category onto a "why suggested" bucket.
function heuristicReason(prop) {
  if (prop.detectedAction === "deadline") return { updateCategory: "new-deadline", updateReason: "Adds a new compliance deadline." };
  if (prop.detectedAction === "correction") return { updateCategory: "information-outdated", updateReason: "Appears to correct or supersede an existing position." };
  if (prop.detectedAction === "update") return { updateCategory: "additional-information", updateReason: "Adds detail to an existing entry." };
  // detectedAction === "new"
  if (prop.targetCategory === "case-studies") return { updateCategory: "new-case-study", updateReason: "New assessment or case study from a regulator/academic source." };
  return { updateCategory: "new-development", updateReason: "New AI regulation or policy development." };
}

// Combined enrichment: ask the model to (a) classify why this is suggested and
// (b) rewrite the raw source excerpt into the app's house style. For updates we
// pass the existing entry so the rewrite reads as a delta. Returns null on any
// failure so the caller falls back to heuristicReason + the raw excerpt.
async function enrichWithModel(prop, excerpt) {
  const text = (excerpt || stripHtml(prop.snippet || prop.description || "")).trim();
  if (!text) return null;
  const existing = prop.matchedRecord
    ? `EXISTING APP ENTRY (title: ${prop.matchedRecord.title}):\n${existingRecordContent(prop.matchedRecord).slice(0, 700) || "(content unavailable)"}\n\n`
    : "";
  const system = `You rewrite AI-regulation/policy news into the house style of a curated competitive-intelligence knowledge base. House style: formal, neutral, third-person, factual; state concrete figures, dates and regulation/article references; 2-3 sentences; no promotional or journalistic language; never invent facts not in the source. ${STYLE_EXAMPLES}`;
  const user = `Classify why this update is proposed and rewrite the source excerpt into ONE knowledge-base entry in house style.${existing}
NEW SOURCE (${prop.publisher || "unknown"}): ${prop.title}
${text}

Return ONLY valid JSON:
{
  "updateCategory": one of "information-outdated" | "additional-information" | "new-case-study" | "new-deadline" | "new-development",
  "updateReason": one short sentence (max 20 words) explaining why this is suggested,
  "styledSummary": the rewritten entry in house style (max 600 chars). Do NOT add a citation line — the app appends the source.
}`;
  const raw = await runModelChat(system, user, { maxTokens: 700, temperature: 0.2, json: true });
  if (!raw) return null;
  try {
    const obj = JSON.parse(stripFences(raw));
    if (!obj || typeof obj.styledSummary !== "string" || !obj.styledSummary.trim()) return null;
    return {
      updateCategory: UPDATE_REASON_KEYS.includes(obj.updateCategory) ? obj.updateCategory : (prop.detectedAction === "deadline" ? "new-deadline" : "new-development"),
      updateReason: String(obj.updateReason || "").slice(0, 240),
      styledSummary: obj.styledSummary.slice(0, 600).trim(),
    };
  } catch {
    return null;
  }
}

// Classify a fetched item: English-only, compared to existing content, and either
// dropped (duplicate/non-English) or returned as a proposed change.
function classifyItem(source, item, index) {
  const text = `${item.title} ${item.description || ""}`;
  if (!isLikelyEnglish(text)) return null; // (a) drop non-English
  const itemTokens = new Set(tokenize(text));
  if (itemTokens.size < 2) return null;
  const itemStrong = strongTermsIn(text);

  const publisher = item.sourceName || source.name;
  const base = {
    id: hashId(item.url || item.title),
    source: source.id,
    sourceDomain: source.domain,
    publisher,
    title: item.title,
    url: item.url,
    snippet: stripHtml(item.description || ""),
    publishedAt: item.publishedAt,
    publishedLabel: item.publishedAt ? formatLabel(item.publishedAt) : "Recent",
    category: source.category,
    createdAt: new Date().toISOString(),
    status: "pending",
  };

  const matched = bestMatch(itemTokens, itemStrong, index);
  if (matched) {
    let action = "update";
    const lc = text.toLowerCase();
    if (/\b(deadline|due|compliance date|effective|enters? into force|by \d{4}|from \d{4})\b/.test(lc) && /\d{4}/.test(lc)) action = "deadline";
    else if (/\b(ruling|decision|judg|court|fine|ban|prohibit|overturn|supersede|repeal|amend|enforce)\b/.test(lc)) action = "correction";
    base.detectedAction = action;
    base.matchConfidence = Number((matched.rank).toFixed(2));
    base.matchedRecord = { dataset: matched.dataset, recordId: matched.recordId, title: matched.title };
    // Target follows the matched record unless this is a deadline (timeline).
    base.targetDataset = action === "deadline" ? "timeline" : matched.dataset;
    base.targetCategory = matched.dataset === "knowledge" ? null : null;
    base.suggestedEdit = draftEdit(item, action, publisher, base.publishedLabel);
    return base;
  }

  // No matching existing record. Surfacing a brand-new topic is noisy, so only
  // propose it when it is clearly about AI regulation/policy AND comes from an
  // official regulator / legislation / academic source. Competitor & industry
  // "news" with no existing anchor is dropped entirely.
  if (itemStrong.size >= 1 && (source.category === "regulation" || source.category === "academic")) {
    base.detectedAction = "new";
    base.matchConfidence = 0;
    base.matchedRecord = null;
    // Classify the target category from the article content (not the source
    // category) so a regulator's model assessment lands under Case Studies.
    base.targetCategory = detectKnowledgeCategory(text, source.category);
    base.targetDataset = source.category === "use-case" ? "use-cases" : "knowledge";
    base.suggestedEdit = draftNewRecord(item, publisher, base.publishedLabel, base.targetCategory);
    return base;
  }

  return null; // drop: noise / not relevant to existing curated content
}

// Apply an approved proposal to the real curated dataset (user-gated write).
function integrateProposal(prop, edit, target, targetCategoryKey) {
  const fileMap = { timeline: "regulatory-timeline.json", knowledge: "knowledge.json", "use-cases": "current-use-cases.json" };
  const file = fileMap[target];
  if (!file) throw new Error("Unknown target dataset: " + target);
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "data", file), "utf8"));
  const publisher = prop.publisher;
  const url = prop.url;

  if (prop.matchedRecord && prop.matchedRecord.dataset === target) {
    if (target === "timeline") {
      const ev = (data.events || []).find(e => e.title === prop.matchedRecord.title);
      if (ev) ev.description = `${ev.description || ""}\n\n${edit}`.trim();
    } else if (target === "knowledge") {
      for (const cat of Object.values(data.categories || {})) {
        const sub = (cat.subsections || []).find(s => s.title === prop.matchedRecord.title);
        if (sub) { sub.content = `${sub.content || ""}\n\n${edit}`.trim(); break; }
      }
    } else if (target === "use-cases") {
      const p = (data.patterns || []).find(p => p.title === prop.matchedRecord.title);
      if (p) p.content = `${p.content || ""}\n\n${edit}`.trim();
    }
  } else {
    if (target === "timeline") {
      data.events = data.events || [];
      data.events.unshift({
        date: (prop.publishedAt || "").slice(0, 10) || new Date().toISOString().slice(0, 10),
        label: prop.publishedLabel || "Recent",
        title: prop.title,
        jurisdiction: sourceRegistryJurisdiction(prop) || "EU/UK",
        category: "Proposed Update",
        description: edit,
        impact: `Proposed from ${publisher}. Verify via the official link before relying on it.`,
        link: url,
        linkLabel: publisher,
      });
    } else if (target === "knowledge") {
      const key = targetCategoryKey || prop.targetCategory || "regulations";
      if (!data.categories[key]) data.categories[key] = { label: key, icon: "🟢", subsections: [] };
      data.categories[key].subsections = data.categories[key].subsections || [];
      data.categories[key].subsections.unshift({ title: prop.title, content: edit, sources: [{ label: publisher, url }] });
    } else if (target === "use-cases") {
      data.patterns = data.patterns || [];
      data.patterns.unshift({ title: prop.title, content: edit, games: [] });
    }
  }

  fs.writeFileSync(path.join(__dirname, "data", file), JSON.stringify(data, null, 2));
  if (target === "timeline") regulatoryTimelineCache = null;
  if (target === "knowledge") knowledgeCache = null;
  if (target === "use-cases") currentUseCasesCache = null;
}
function sourceRegistryJurisdiction(prop) {
  const s = (loadSourceRegistry() || []).find(x => x.id === prop.source);
  return s ? (s.jurisdiction || "EU/UK") : "EU/UK";
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function formatLabel(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "Recent";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

async function fetchSourceItems(source) {
  const freshness = source.freshness || "7d";
  const query = `site:${source.domain} ${source.terms} when:${freshness}`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-GB&gl=GB&ceid=GB:en`;
  const resource = await fetchTextResource(url, "application/rss+xml,application/xml,text/xml");
  return parseNewsRss(resource.text, source.name, query, source.limit || 5, []);
}

async function runSourceScan({ force = false } = {}) {
  if (sourceScanInFlight) return { skipped: true, reason: "scan already in flight" };
  sourceScanInFlight = true;
  const startedAt = Date.now();

  try {
    const sources = loadSourceRegistry();
    const now = Date.now();
    const due = sources.filter(s =>
      force ||
      !sourceState.sources[s.id] ||
      !sourceState.sources[s.id].lastScanAt ||
      (now - sourceState.sources[s.id].lastScanAt) >= (s.ttlMinutes || 15) * 60000
    );

    const index = buildExistingIndex();
    const knownIds = new Set((proposedChanges.items || []).map(i => i.id));
    const pendingKeys = new Set(
      (proposedChanges.items || [])
        .filter(i => i.status === "pending")
        .map(i => `${i.matchedRecord ? i.matchedRecord.title : ""}|${i.detectedAction}|${i.url}`)
    );
    const existing = proposedChanges.items || [];
    const newProps = []; // proposals created in THIS scan that still need enrichment
    let scanned = 0, considered = 0, proposed = 0;
    const counts = { update: 0, deadline: 0, correction: 0, new: 0 };

    for (const source of due) {
      try {
        const items = await fetchSourceItems(source);
        const state = sourceState.sources[source.id] || { seen: [] };
        const seen = new Set(state.seen || []);
        for (const item of items) {
          if (!item.url || seen.has(item.url)) continue;
          seen.add(item.url);
          considered++;
          const prop = classifyItem(source, item, index);
          if (!prop) continue;                       // dropped: non-English or duplicate
          if (knownIds.has(prop.id)) continue;        // already proposed/acted on
          const dedupeKey = `${prop.matchedRecord ? prop.matchedRecord.title : ""}|${prop.detectedAction}|${prop.url}`;
          if (pendingKeys.has(dedupeKey)) continue;   // avoid re-proposing same record change
          existing.push(prop);
          newProps.push(prop);
          knownIds.add(prop.id);
          pendingKeys.add(dedupeKey);
          proposed++;
          counts[prop.detectedAction] = (counts[prop.detectedAction] || 0) + 1;
        }
        sourceState.sources[source.id] = {
          lastScanAt: now,
          name: source.name,
          seen: [...seen].slice(-300),
        };
        scanned++;
      } catch (_) {
        // Skip a failing source; continue with the rest.
      }
    }

    // Enrich each new proposal with a real preview of the source article so the
    // review panel shows the actual text that would be added (and so the target
    // category can be refined from the full article text, not just the headline).
    // Bounded concurrency + short timeout keep the background scan responsive.
    //
    // SELF-HEALING: also re-enrich EXISTING pending proposals that still have no
    // preview. Previously a failed resolver fetch left a proposal stuck with
    // "No extractable summary" forever, because later scans skipped it. Now we
    // retry those on each scan (capped + cooldown-guarded) so previews fill in
    // over time as the resolver succeeds, instead of being permanently blank.
    const toEnrich = [...newProps];
    const newIds = new Set(newProps.map(p => p.id));
    const RETRY_CAP = 20;
    const RETRY_COOLDOWN_MS = 20 * 60 * 1000; // at most one retry / 20 min per proposal
    let retryAdded = 0;
    for (const prop of existing) {
      if (retryAdded >= RETRY_CAP) break;
      if (newIds.has(prop.id)) continue; // already covered by the newProps pass
      if (prop.status !== "pending") continue;
      const hasPreview = prop.preview && prop.preview.length;
      const hasReason = prop.updateCategory && UPDATE_REASON_LABELS[prop.updateCategory];
      // Skip only when fully enriched (preview + model reason). Otherwise it may
      // still need a resolver fetch or the model categorisation/summary pass.
      if (hasPreview && hasReason) continue;
      if (prop.lastPreviewAttempt) {
        const since = Date.now() - new Date(prop.lastPreviewAttempt).getTime();
        if (since < RETRY_COOLDOWN_MS) continue;
      }
      toEnrich.push(prop);
      retryAdded++;
    }

    if (toEnrich.length) {
      await mapWithConcurrency(toEnrich, 2, async (prop) => {
        let preview = null;
        try { preview = await fetchArticlePreview(prop, { domain: prop.sourceDomain }); } catch { /* best effort */ }
        // Record the attempt even on failure so the cooldown guards against
        // re-hammering a URL that the resolver can't currently resolve.
        prop.lastPreviewAttempt = new Date().toISOString();
        if (preview) {
          prop.preview = preview;
          if (prop.detectedAction === "new") {
            prop.targetCategory = detectKnowledgeCategory(`${prop.title} ${preview}`, prop.category);
          }
        }
        // Combined enrichment: model-based "why suggested" category + reason +
        // a house-style rewrite of the source excerpt. Falls back to the
        // deterministic heuristic when the model is unavailable or errors.
        const baseText = preview || stripHtml(prop.snippet || prop.description || "");
        let enriched = null;
        if (baseText) {
          try { enriched = await enrichWithModel(prop, baseText); } catch { /* best effort */ }
        }
        if (!enriched) {
          // Don't clobber a previously enriched proposal if the model just
          // hiccuped — keep its existing styled summary / reason.
          if (prop.styledSummary || prop.updateCategory) return;
          enriched = heuristicReason(prop);
        }
        prop.updateCategory = enriched.updateCategory;
        prop.updateReason = enriched.updateReason;
        prop.styledSummary = enriched.styledSummary || null;
        const styled = enriched.styledSummary || baseText;
        prop.suggestedEdit = prop.detectedAction === "new"
          ? draftNewRecord(prop, prop.publisher, prop.publishedLabel, prop.targetCategory, styled)
          : draftEdit(prop, prop.detectedAction, prop.publisher, prop.publishedLabel, styled);
      });
    }

    proposedChanges.items = existing.slice(-300);
    sourceState.lastFullScan = new Date().toISOString();
    saveSourceState();
    saveProposed();

    return {
      scanned,
      due: due.length,
      considered,
      proposed,
      counts,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    sourceScanInFlight = false;
  }
}
// Status for the client: how many PROPOSED changes are waiting for review.
app.get("/api/regulatory-status", (req, res) => {
  const pending = (proposedChanges.items || []).filter(i => i.status === "pending");
  const counts = { update: 0, deadline: 0, correction: 0, new: 0 };
  pending.forEach(i => { counts[i.detectedAction] = (counts[i.detectedAction] || 0) + 1; });
  res.json({
    success: true,
    monitoring: true,
    lastScanAt: sourceState.lastFullScan,
    pendingCount: pending.length,
    counts,
  });
});

// Trigger a crawl of the allowlist. The scan can now take a while (it fetches
// each proposed article to build a real preview), so we run it in the background
// and return immediately. The client polls /api/proposed-changes separately.
app.post("/api/source-scan", (req, res) => {
  const force = !!(req.body && req.body.force);
  if (sourceScanInFlight) {
    return res.json({ success: true, started: false, reason: "scan already in flight" });
  }
  runSourceScan({ force })
    .then(result => console.log("[source-scan] completed:", JSON.stringify(result)))
    .catch(err => console.warn("[source-scan] failed:", err.message));
  res.json({ success: true, started: true });
});

// List pending proposed changes for the review panel.
app.get("/api/proposed-changes", (req, res) => {
  const items = (proposedChanges.items || [])
    .filter(i => i.status === "pending")
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, pending: items, pendingCount: items.length });
});

// Integrate an approved proposal into the curated dataset (user-gated write).
app.post("/api/proposed-changes/:id/integrate", (req, res) => {
  try {
    const id = req.params.id;
    const prop = (proposedChanges.items || []).find(i => i.id === id);
    if (!prop) return res.status(404).json({ error: "Proposal not found" });
    const edit = (req.body && req.body.edit) ? String(req.body.edit) : (prop.suggestedEdit || prop.title);
    const target =
      (req.body && req.body.targetDataset) ||
      (prop.matchedRecord && prop.matchedRecord.dataset) ||
      (prop.category === "use-case" ? "use-cases" : prop.category === "academic" ? "knowledge" : "timeline");
    const targetCategoryKey = req.body && req.body.targetCategoryKey;
    integrateProposal(prop, edit, target, targetCategoryKey);
    prop.status = "integrated";
    (proposedChanges.integratedIds = proposedChanges.integratedIds || []).push(id);
    saveProposed();
    res.json({ success: true, target });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Dismiss a proposal so it stops showing and isn't re-proposed.
app.post("/api/proposed-changes/:id/dismiss", (req, res) => {
  const id = req.params.id;
  const prop = (proposedChanges.items || []).find(i => i.id === id);
  if (!prop) return res.status(404).json({ error: "Proposal not found" });
  prop.status = "dismissed";
  (proposedChanges.dismissedIds = proposedChanges.dismissedIds || []).push(id);
  saveProposed();
  res.json({ success: true });
});

// Server-side scheduler: scan sources whose TTL has elapsed. The single-flight
// lock prevents overlapping scans. Render's free tier sleeps when idle, so pair
// this with the keep-alive cron in .github/workflows to stay live 24/7.
const SOURCE_SCAN_TICK_MS = 5 * 60 * 1000;
setInterval(() => { runSourceScan({ force: false }).catch(() => {}); }, SOURCE_SCAN_TICK_MS);
setTimeout(() => { runSourceScan({ force: false }).catch(() => {}); }, 30000);

// POST /api/scrape — extract readable website text or a public video transcript
app.post("/api/scrape", async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: "URL is required" });

    const result = await scrapeUrl(url);
    const wordCount = result.text.split(/\s+/).filter(Boolean).length;
    const summarySentences = rankSourceSentences(result.text, result.title, 4);
    res.json({
      success: true,
      data: {
        metadata: {
          title: result.title,
          url: result.url,
          originalUrl: result.originalUrl || url,
          sourceType: result.sourceType,
          extractionMethod: result.extractionMethod,
          language: result.language,
          wordCount,
          characterCount: result.text.length,
        },
        summary: summarySentences.join(" "),
        content: result.text,
        markdown: result.text,
      },
    });
  } catch (err) {
    res.status(422).json({ error: err.message });
  }
});

// POST /api/report — extract all sources and generate a cohesive, traceable report
app.post("/api/report", async (req, res) => {
  try {
    const { urls = [], sources: suppliedSources = [], title = "Competitive Intelligence Report" } = req.body;
    const requestedSources = suppliedSources.length
      ? suppliedSources
      : urls.map(url => ({ url }));
    if (!requestedSources.length) {
      return res.status(400).json({ error: "At least one source URL is required" });
    }

    const limitedSources = requestedSources.slice(0, 8);
    const extractionResults = await Promise.allSettled(limitedSources.map(async source => {
      const sourceUrl = validateSourceUrl(source.url);
      if (typeof source.content === "string" && source.content.trim().length >= 80) {
        const content = source.content.trim().slice(0, 40000);
        return {
          url: source.finalUrl || sourceUrl,
          originalUrl: sourceUrl,
          title: source.title || sourceUrl,
          content,
          sourceType: source.sourceType || "webpage",
          extractionMethod: source.extractionMethod || "Previously extracted content",
          wordCount: content.split(/\s+/).filter(Boolean).length,
          searchQuery: source.searchQuery || "",
        };
      }

      const result = await scrapeUrl(sourceUrl);
      const content = result.text.slice(0, 40000);
      return {
        url: result.url,
        originalUrl: result.originalUrl || sourceUrl,
        title: result.title || source.title || sourceUrl,
        content,
        sourceType: result.sourceType,
        extractionMethod: result.extractionMethod,
        wordCount: content.split(/\s+/).filter(Boolean).length,
        searchQuery: source.searchQuery || "",
      };
    }));

    const extractedSources = [];
    const failedSources = [];
    extractionResults.forEach((result, index) => {
      if (result.status === "fulfilled") extractedSources.push(result.value);
      else failedSources.push({
        url: limitedSources[index].url,
        title: limitedSources[index].title || limitedSources[index].url,
        searchQuery: limitedSources[index].searchQuery || "",
        error: result.reason?.message || "Extraction failed",
      });
    });

    if (!extractedSources.length) {
      return res.status(422).json({
        error: "None of the supplied sources could be extracted",
        failedSources,
      });
    }

    const report = buildCohesiveReport(title, extractedSources, failedSources, requestedSources.length);
    res.json({ success: true, report });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/status
app.get("/api/status", (req, res) => {
  res.json({
    mode: "Tavily web search (API key required)",
    searchProvider: "Tavily",
    scrapeProvider: "Readable web text + public video captions",
  });
});

// GET /api/knowledge — serve the structured knowledge base
let knowledgeCache = null;
app.get("/api/knowledge", (req, res) => {
  try {
    const { category, search } = req.query;

    if (!knowledgeCache) {
      knowledgeCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "knowledge.json"), "utf8")
      );
    }

    // Curated base only — live/auto-sourced items are NOT injected here; they
    // surface via the proposed-changes review queue instead.
    const categories = {};
    for (const [key, cat] of Object.entries(knowledgeCache.categories)) {
      categories[key] = { ...cat, subsections: [...(cat.subsections || [])] };
    }

    let result;
    if (category && categories[category]) {
      result = {
        sourceDocuments: knowledgeCache.sourceDocuments,
        categories: { [category]: categories[category] },
      };
    } else {
      result = { sourceDocuments: knowledgeCache.sourceDocuments, categories };
    }

    if (search) {
      const query = search.toLowerCase();
      const filtered = {};
      for (const [key, cat] of Object.entries(result.categories)) {
        const matchingSubsections = cat.subsections.filter(
          (s) =>
            s.title.toLowerCase().includes(query) ||
            s.content.toLowerCase().includes(query)
        );
        if (matchingSubsections.length > 0) {
          filtered[key] = { ...cat, subsections: matchingSubsections };
        }
      }
      result = {
        sourceDocuments: knowledgeCache.sourceDocuments,
        categories: filtered,
      };
    }

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/network — serve competitor network data
let networkCache = null;
app.get("/api/network", (req, res) => {
  try {
    if (!networkCache) {
      networkCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "network.json"), "utf8")
      );
    }
    res.json({ success: true, data: networkCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tencent-products — Tencent's AI/gaming product portfolio
let tencentProductsCache = null;
app.get("/api/tencent-products", (req, res) => {
  try {
    if (!tencentProductsCache) {
      tencentProductsCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "tencent-products.json"), "utf8")
      );
    }
    res.json({ success: true, data: tencentProductsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/current-use-cases — consolidated game-by-game AI implementations
let currentUseCasesCache = null;
app.get("/api/current-use-cases", (req, res) => {
  try {
    if (!currentUseCasesCache) {
      currentUseCasesCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "current-use-cases.json"), "utf8")
      );
    }
    // Curated base only — live/auto-sourced items surface via the review queue.
    const data = {
      ...currentUseCasesCache,
      patterns: [...(currentUseCasesCache.patterns || [])],
    };
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/gaming-trends — AI gaming trends (9 LLM use cases expanded)
let gamingTrendsCache = null;
app.get("/api/gaming-trends", (req, res) => {
  try {
    if (!gamingTrendsCache) {
      gamingTrendsCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "gaming-trends.json"), "utf8")
      );
    }
    res.json({ success: true, data: gamingTrendsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/gaming-trends/search — live DuckDuckGo search for a trend
app.post("/api/gaming-trends/search", async (req, res) => {
  try {
    const { keywords, limit = 5 } = req.body;
    if (!keywords) return res.status(400).json({ error: "Search keywords required" });

    const results = await tavilySearch(keywords, limit);
    res.json({ success: true, data: results, keywords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/regulatory-timeline — EU & UK AI regulatory deadlines
let regulatoryTimelineCache = null;
app.get("/api/regulatory-timeline", (req, res) => {
  try {
    if (!regulatoryTimelineCache) {
      regulatoryTimelineCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "regulatory-timeline.json"), "utf8")
      );
    }
    // Curated base only — live/auto-sourced items surface via the review queue.
    const data = {
      ...regulatoryTimelineCache,
      events: [...(regulatoryTimelineCache.events || [])],
    };
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/regulatory-scan — search for new AI regulatory developments
app.post("/api/regulatory-scan", async (req, res) => {
  try {
    const scanQueries = [
      "EU AI Act 2026 2027 new regulation deadline compliance",
      "UK AI regulation 2026 2027 new bill law policy",
      "AI Act high-risk systems enforcement 2026 2027",
      "EU digital regulation AI gaming 2026",
    ];

    const results = await Promise.allSettled(
      scanQueries.map(async (q) => {
        try {
          const items = await tavilySearch(q, 3);
          return { query: q, results: items };
        } catch (_) { return { query: q, results: [] }; }
      })
    );

    // Collect all results and filter for regulatory relevance
    const seen = new Set();
    const developments = [];

    const regulatoryTerms = [
      "AI Act", "regulation", "compliance", "deadline", "law", "legislation",
      "directive", "enforcement", "prohibited", "high-risk", "GPAI", "DMA",
      "liability", "governance", "regulatory", "fine", "sanction", "ICO",
      "European Commission", "parliament", "council", "data protection",
      "copyright", "transparency", "watermark", "digital"
    ];

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of r.value.results || []) {
        if (!item.url || seen.has(item.url)) continue;
        const text = ((item.title || "") + " " + (item.description || "")).toLowerCase();
        const matchCount = regulatoryTerms.filter(t => text.includes(t.toLowerCase())).length;
        if (matchCount < 2) continue; // Must match at least 2 regulatory terms

        seen.add(item.url);
        developments.push({
          title: item.title,
          url: item.url,
          description: item.description,
          source: "Web search",
          foundAt: new Date().toISOString(),
        });
      }
    }

    res.json({
      success: true,
      count: developments.length,
      developments: developments.slice(0, 15),
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/knowledge-scan — search for new AI/gaming regulatory knowledge
app.post("/api/knowledge-scan", async (req, res) => {
  try {
    const scanQueries = [
      "AI gaming regulation compliance 2026",
      "generative AI game development law EU UK 2026",
      "AI copyright gaming industry 2026",
      "world models AI regulation 2026",
    ];

    const results = await Promise.allSettled(
      scanQueries.map(async (q) => {
        try {
          const items = await tavilySearch(q, 3);
          return { query: q, results: items };
        } catch (_) { return { query: q, results: [] }; }
      })
    );

    const seen = new Set();
    const items = [];

    for (const r of results) {
      if (r.status !== "fulfilled") continue;
      for (const item of r.value.results || []) {
        if (!item.url || seen.has(item.url)) continue;
        seen.add(item.url);
        items.push({
          title: item.title,
          url: item.url,
          description: item.description,
          source: "Web search",
          foundAt: new Date().toISOString(),
        });
      }
    }

    res.json({
      success: true,
      count: items.length,
      items: items.slice(0, 10),
      scannedAt: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/risks — cross-referenced risk analysis
let risksCache = null;
app.get("/api/risks", (req, res) => {
  try {
    if (!risksCache) {
      risksCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "risks.json"), "utf8")
      );
    }
    res.json({ success: true, data: risksCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/company-locations — UK & EU company and regulator locations
let companyLocationsCache = null;
app.get("/api/company-locations", (req, res) => {
  try {
    if (!companyLocationsCache) {
      companyLocationsCache = JSON.parse(
        fs.readFileSync(path.join(__dirname, "data", "company-locations.json"), "utf8")
      );
    }
    res.json({ success: true, data: companyLocationsCache });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Insights Tool`);
  console.log(`  Server running at http://localhost:${PORT}`);
  console.log(`  Python: ${PYTHON ? `${PYTHON} — video transcripts enabled` : "NOT FOUND — video transcripts disabled"}`);
  console.log(`  Search: Tavily web search (requires TAVILY_API_KEY)\n`);
  // The local AI model is opt-in (default answer mode is extractive-citation),
  // so we do NOT preload it at startup. It is warmed in the background the first
  // time the user enables the "Use AI model" toggle.
});
