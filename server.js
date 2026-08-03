const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { execFile } = require("child_process");

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

// GET /api/news — free DuckDuckGo news search across competitors
// Falls back to pre-generated cache when Python/search is unavailable
let newsCache = null;
try {
  newsCache = JSON.parse(fs.readFileSync(path.join(__dirname, "data", "news-cache.json"), "utf8"));
} catch (_) { /* no cache file yet */ }

app.get("/api/news", async (req, res) => {
  try {
    // Use 8 random keywords each time for variety, always with 2026
    const shuffled = [...COMPETITOR_KEYWORDS].sort(() => Math.random() - 0.5);
    const queries = shuffled.slice(0, 8).map((kw) => `${kw} 2026`);

    const results = await Promise.allSettled(
      queries.map(async (q) => {
        const items = await ddgSearch(q, 3);
        return { keyword: q, results: items };
      })
    );

    // Collect, filter excluded domains, and deduplicate by URL
    const seen = new Set();
    const articles = [];
    for (const r of results) {
      if (r.status === "fulfilled" && r.value.results) {
        for (const item of r.value.results) {
          if (!item.url || seen.has(item.url)) continue;

          // Skip excluded domains (Wikipedia, etc.)
          const urlLower = item.url.toLowerCase();
          const isExcluded = NEWS_EXCLUDED_DOMAINS.some(domain =>
            urlLower.includes(domain)
          );
          if (isExcluded) continue;

          // Skip articles with titles that look like encyclopedia entries
          const title = (item.title || "").toLowerCase();
          const isWikiStyle = /^[a-z\s]+—?\s*wikipedia/i.test(title) ||
            /wikipedia,?\s+(the|la|die|il|el)\s+free\s+encyclopedia/i.test(item.title || "");
          if (isWikiStyle) continue;

          seen.add(item.url);
          articles.push({
            ...item,
            competitorKeyword: r.value.keyword.replace(/ 2026$/, ""),
          });
        }
      }
    }

    // Sort by recency/heuristic: prefer articles with longer descriptions (more substantive)
    articles.sort((a, b) => (b.description || "").length - (a.description || "").length);

    const finalArticles = articles.slice(0, 30);

    // Update cache with fresh results
    if (finalArticles.length > 0) {
      newsCache = {
        generatedAt: new Date().toISOString(),
        source: "Live DuckDuckGo search",
        count: finalArticles.length,
        articles: finalArticles
      };
    }

    res.json({
      success: true,
      count: finalArticles.length,
      articles: finalArticles,
      searchedAt: new Date().toISOString(),
      live: true,
    });
  } catch (err) {
    // Fall back to cache if available
    if (newsCache && newsCache.articles?.length) {
      return res.json({
        success: true,
        count: newsCache.articles.length,
        articles: newsCache.articles,
        searchedAt: newsCache.generatedAt,
        live: false,
        cached: true,
      });
    }
    res.status(500).json({ error: err.message });
  }
});

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

    let result = { ...knowledgeCache };

    if (category && knowledgeCache.categories[category]) {
      result = {
        sourceDocuments: knowledgeCache.sourceDocuments,
        categories: {
          [category]: knowledgeCache.categories[category],
        },
      };
    }

    if (search) {
      const query = search.toLowerCase();
      const filtered = {};
      for (const [key, cat] of Object.entries(knowledgeCache.categories)) {
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
    res.json({ success: true, data: currentUseCasesCache });
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
    res.json({ success: true, data: regulatoryTimelineCache });
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
});
