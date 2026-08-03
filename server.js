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
  buildExtractiveFallback,
  warmUpModel,
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

// ===== DuckDuckGo Search via Python duckduckgo_search library =====
// Free, no API key, no sign-in, no token limits.
// When Python is unavailable, falls back to cached news data.

function ddgSearch(query, limit = 10) {
  return new Promise((resolve, reject) => {
    if (!PYTHON) return reject(new Error("Python not available — search disabled on this host"));
    execFile(
      PYTHON,
      [SEARCH_SCRIPT, query, String(limit)],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) {
          if (err.killed) return reject(new Error("Search timed out"));
          return reject(new Error(stderr || err.message));
        }
        try {
          const result = JSON.parse(stdout);
          if (result.error) return reject(new Error(result.error));
          resolve(result.data || []);
        } catch (e) {
          reject(new Error("Failed to parse search results"));
        }
      }
    );
  });
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

async function fetchTextResource(url, accept = "text/html,application/xhtml+xml,text/plain") {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(validateSourceUrl(url), {
      headers: { "User-Agent": SCRAPE_USER_AGENT, Accept: accept },
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

// POST /api/search — free DuckDuckGo search
app.post("/api/search", async (req, res) => {
  try {
    const { query, limit = 10 } = req.body;
    if (!query) return res.status(400).json({ error: "Query is required" });

    const results = await ddgSearch(query, limit);
    res.json({ success: true, data: results, total: results.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/summarise/status — describe the local evidence and model setup
app.get("/api/summarise/status", (req, res) => {
  try {
    res.json({
      success: true,
      corpusItems: buildCorpus().length,
      model: DEFAULT_MODEL,
      license: "Apache-2.0",
      localModel: true,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/summarise — answer questions from app data with optional web evidence
app.post("/api/summarise", async (req, res) => {
  try {
    const question = String(req.body?.question || "").replace(/\s+/g, " ").trim();
    const useInternet = req.body?.useInternet === true;
    if (!question) return res.status(400).json({ error: "Enter a question to summarise" });
    if (question.length > 700) return res.status(400).json({ error: "Question must be 700 characters or fewer" });

    const appEvidence = [];
    try {
      appEvidence.push(...retrieveApplicationEvidence(question, 7));
    } catch (err) {
      console.warn("[summarise] evidence retrieval failed:", err.message);
    }
    let webEvidence = [];
    let webSearchError = "";

    if (useInternet) {
      try {
        const webResults = await ddgSearch(`${question} latest evidence official`, 5);
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
    let mode = "local-open-source-model";
    let modelError = "";
    let modelTimer;
    try {
      answer = await Promise.race([
        generateOpenSourceAnswer(question, evidence),
        new Promise((_, reject) => {
          modelTimer = setTimeout(() => reject(new Error("Local model initialization timed out; retry after the model finishes warming")), 70000);
        }),
      ]);
    } catch (error) {
      modelError = error.message;
      mode = "extractive-fallback";
      answer = buildExtractiveFallback(question, evidence);
    } finally {
      clearTimeout(modelTimer);
    }

    res.json({
      success: true,
      answer,
      question,
      internetUsed: webEvidence.length > 0,
      webSearchError,
      model: {
        name: DEFAULT_MODEL,
        license: "Apache-2.0",
        mode,
        error: modelError,
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
    return JSON.parse(fs.readFileSync(SOURCE_STATE_FILE, "utf8"));
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

// P3 — auto-draft the suggested edit shown in the review panel (pre-filled).
function draftEdit(source, item, action, matched, publisher, label) {
  const cite = ` [Source: ${publisher}, ${label}]`;
  const clean = stripHtml(item.description || "");
  if (action === "deadline") return `New compliance deadline announced: ${item.title}.${cite}`;
  if (action === "correction") return `This position appears to have changed — ${item.title}. ${clean}${cite}`;
  return `Latest (${label}): ${clean}${cite}`;
}
function draftNewRecord(source, item, publisher, label) {
  const cite = `Source: ${publisher} (${label}).`;
  const clean = stripHtml(item.description || "");
  if (source.category === "use-case") return `Add as a new AI use-case pattern — "${item.title}". ${clean} ${cite}`;
  if (source.category === "academic") return `Add as new research note — "${item.title}". ${clean} ${cite}`;
  return `Add as new regulatory development — "${item.title}". ${clean} ${cite}`;
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
    base.suggestedEdit = draftEdit(source, item, action, matched, publisher, base.publishedLabel);
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
    base.suggestedEdit = draftNewRecord(source, item, publisher, base.publishedLabel);
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
      const key = targetCategoryKey || "regulations";
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

// Trigger a crawl of the allowlist (server does the work; single-flight locked).
app.post("/api/source-scan", async (req, res) => {
  try {
    const force = !!(req.body && req.body.force);
    const result = await runSourceScan({ force });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    mode: "DuckDuckGo (free, no API key needed)",
    searchProvider: "DuckDuckGo Lite",
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

    const results = await ddgSearch(keywords, limit);
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
          const items = await ddgSearch(q, 3);
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
          const items = await ddgSearch(q, 3);
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
  console.log(`  Python: ${PYTHON ? `${PYTHON} — search & transcripts enabled` : "NOT FOUND — search & transcripts disabled"}`);
  console.log(`  Search: DuckDuckGo (free, no API key)\n`);
  // Warm up the local summarisation model in the background so the first user
  // request does not pay the cold-start download/initialisation cost (which
  // previously triggered a 70s timeout -> extractive fallback).
  warmUpModel().then(ready => {
    if (ready) console.log("  Summarise: local model ready");
  });
});
