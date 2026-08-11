// ============================================================
// Gaming Competitive Intelligence — Frontend App
// ============================================================

const API_BASE = "/api";

// Wraps fetch for the state-changing endpoints. Sends the optional admin key
// (from localStorage) in the X-Admin-Key header. If the server answers 401
// (ADMIN_API_KEY is set there), prompts once for the key, remembers it, and
// retries. When auth is disabled server-side this is a no-op (empty header).
async function authedFetch(url, init = {}) {
  const key = (typeof localStorage !== "undefined" && localStorage.getItem("adminKey")) || "";
  init.headers = Object.assign({ "Content-Type": "application/json", "X-Admin-Key": key }, init.headers || {});
  let res = await fetch(url, init);
  if (res.status === 401) {
    const entered = window.prompt("This server requires an admin key. Enter it to continue:");
    if (entered) {
      localStorage.setItem("adminKey", entered);
      init.headers["X-Admin-Key"] = entered;
      res = await fetch(url, init);
    }
  }
  return res;
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Only allow http/https hrefs. Anything else (javascript:, data:, etc.) collapses
// to "#" so a crafted source URL cannot execute script when rendered as a link.
function safeHref(url) {
  const u = String(url || "");
  return /^https?:\/\//i.test(u) ? u : "#";
}

let reportUrls = [];
let currentScrapedSource = null;
let savedReports = JSON.parse(localStorage.getItem("savedReports") || "[]");

// ===== Init =====
document.addEventListener("DOMContentLoaded", () => {
  restoreTabOrder();
  setupNavigation();
  setupSettings();
  checkApiStatus();
  loadKnowledgeBase();
  setupSubTabs();
  setupNewsFavorites();
  setupNewsCompetitors();
  setupSearchReportsWorkspace();
  setupQA();
  setupTabDragDrop();
  setupSourceMonitor();
  setupReviewPanel();
});

// ===== Navigation =====
function setupNavigation() {
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".nav-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const viewId = btn.dataset.view;
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      document.getElementById(viewId).classList.add("active");

      // Reset sub-tabs for the newly activated view
      resetSubTabForView(viewId);

      if (viewId === "news-view") loadNews();
      if (viewId === "search-view" && searchReportsMode === "reports") renderSavedReports();
      if (viewId === "knowledge-base") loadKnowledgeBase();
      if (viewId === "spider-web") loadSpiderWeb();
      if (viewId === "tencent-products") loadTencentProducts();
      if (viewId === "gaming-trends") loadGamingTrends();
      if (viewId === "current-use-cases") loadCurrentUseCases();
      if (viewId === "regulatory-timeline") loadRegulatoryTimeline();
      if (viewId === "risks") loadRisks();
      if (viewId === "company-map") loadCompanyMap();
    });
  });

  // Refresh news button
  document.getElementById("refreshNewsBtn").addEventListener("click", () => {
    loadNews(true);
  });

  // Search button
  document.getElementById("searchBtn").addEventListener("click", doSearch);
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  document.getElementById("scrapeDirectSource").addEventListener("click", () => {
    const url = document.getElementById("directSourceUrl").value.trim();
    if (!url) return showToast("Paste a source URL first");
    scrapeUrl(url);
  });
  document.getElementById("addDirectSourceToReport").addEventListener("click", () => {
    const url = document.getElementById("directSourceUrl").value.trim();
    if (!url) return showToast("Paste a source URL first");
    addUrlToReport(url, url);
  });
  document.getElementById("reportAddSourceBtn").addEventListener("click", () => {
    const input = document.getElementById("reportSourceUrl");
    const url = input.value.trim();
    if (!url) return showToast("Paste a source URL first");
    if (addUrlToReport(url, url)) input.value = "";
  });

  // Close scrape panel
  document.getElementById("closeScrape").addEventListener("click", () => {
    document.getElementById("scrapeSection").style.display = "none";
  });

  // Add to report
  document.getElementById("addToReport").addEventListener("click", addCurrentToReport);

  // Generate report
  document.getElementById("generateReportBtn").addEventListener("click", generateReport);

  // Toggle full content
  document.getElementById("toggleFullContent").addEventListener("click", toggleFullContent);
}

// ===== Search & Reports Workspace =====
let searchReportsMode = "search";

function setupSearchReportsWorkspace() {
  document.querySelectorAll("[data-workspace-mode]").forEach(button => {
    button.addEventListener("click", () => switchSearchReportsWorkspace(button.dataset.workspaceMode));
  });
  updateReportDraftCount();
}

function switchSearchReportsWorkspace(mode) {
  searchReportsMode = mode === "reports" ? "reports" : "search";

  document.querySelectorAll("[data-workspace-mode]").forEach(button => {
    const active = button.dataset.workspaceMode === searchReportsMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-workspace-panel]").forEach(panel => {
    panel.classList.toggle("active", panel.dataset.workspacePanel === searchReportsMode);
  });

  if (searchReportsMode === "reports") {
    renderUrlList();
    renderSavedReports();
    renderSavedArticlesForReport();
  }
}

function updateReportDraftCount() {
  const count = document.getElementById("reportDraftCount");
  if (count) count.textContent = reportUrls.length;
}

// ===== Smart Summary =====
function setupQA() {
  const input = document.getElementById("summaryQuestion");
  const submit = document.getElementById("summarySubmitBtn");
  if (!input || !submit) return;

  submit.addEventListener("click", runSummary);
  input.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      runSummary();
    }
  });

  const printBtn = document.getElementById("summaryPrintBtn");
  if (printBtn) printBtn.addEventListener("click", () => window.print());

  const styleSelect = document.getElementById("summaryStyle");
  if (styleSelect) styleSelect.addEventListener("change", renderAnswerByStyle);

  document.querySelectorAll(".summary-suggestion").forEach(button => {
    button.addEventListener("click", () => {
      input.value = button.textContent.trim();
      input.focus();
    });
  });

  // The AI model now runs on EVERY answer. The single "Includes Internet
  // Sources" checkbox (id summaryUseModel) is the only Q&A control and gates
  // optional web evidence.
  const footerText = document.getElementById("aiTransparencyText");

  fetch(`${API_BASE}/summarise/status`)
    .then(response => response.json())
    .then(data => {
      if (!data.success) return;
      const qaModel = String(data.model || "an AI model").split("/").pop();
      const scanModel = String(data.scanModel || "an AI model").split("/").pop();
      if (footerText) {
        footerText.textContent =
          `This feature uses ${qaModel} for answering your questions and ${scanModel} for generating suggested updates in the background. ` +
          `Be aware responses are AI generated to an extent, and so the accuracy of information cannot be assured.`;
      }
    })
    .catch(() => { /* best-effort; static fallback disclaimer text remains visible */ });
}

async function runSummary() {
  const input = document.getElementById("summaryQuestion");
  const button = document.getElementById("summarySubmitBtn");
  const result = document.getElementById("summaryResult");
  const answer = document.getElementById("summaryAnswer");
  const question = input.value.trim();
  if (!question) {
    showToast("Enter a question.");
    input.focus();
    return;
  }

  // The AI model runs on every answer; the single "Includes Internet Sources"
  // checkbox (id summaryUseModel) is the only optional control.
  const useModel = true;
  const useInternet = document.getElementById("summaryUseModel")?.checked === true;

  button.disabled = true;
  button.textContent = "Asking...";
  result.style.display = "block";
  document.getElementById("summaryResultQuestion").textContent = question;
  document.getElementById("summaryResultMeta").textContent = "Retrieving application evidence...";
  answer.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading the AI model and synthesising evidence...</p></div>`;
  document.getElementById("summaryEvidence").innerHTML = "";
  document.getElementById("summaryWarning").style.display = "none";
  document.getElementById("summaryTierNotice").style.display = "none";
  result.scrollIntoView({ behavior: "smooth", block: "start" });

  try {
    const response = await fetch(`${API_BASE}/summarise`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question,
        useInternet,
        useModel,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || "Answer generation failed");

    lastAnswerText = data.answer || "";
    lastAnswerSources = data.sources || [];
    renderAnswerByStyle();
    const sourceCount = data.sources?.length || 0;
    const internetLabel = data.internetUsed ? " · internet evidence included" : "";
    const modeText =
      data.model?.mode === "extractive-citation" ? "extractive · cited"
      : data.model?.mode === "local-open-source-model" ? "AI model"
      : "extractive (model fallback)";
    document.getElementById("summaryResultMeta").textContent = `${sourceCount} sources · ${modeText}${internetLabel} · ${new Date(data.generatedAt).toLocaleTimeString()}`;

    // When the answer was NOT produced by the AI model (the default
    // extractive-citation mode, or the model falling back to extractive),
    // surface a clear notice so readers don't mistake a citation summary for
    // an AI synthesis. The meta line already says "extractive · cited", but
    // this makes the distinction unmistakable.
    const tierNotice = document.getElementById("summaryTierNotice");
    if (data.model?.mode === "local-open-source-model") {
      tierNotice.style.display = "none";
    } else {
      tierNotice.textContent = "AI analysis unavailable - knowledge base summary only.";
      tierNotice.style.display = "block";
    }

    const warning = document.getElementById("summaryWarning");
    const warnings = [];
    // Only warn about the model when the user actually opted in and it fell back
    // (the default extractive mode is not an error condition).
    if (useModel && data.model?.mode === "extractive-fallback") warnings.push("The AI model was unavailable or still warming up, so an extractive evidence summary was returned.");
    if (data.webSearchError) warnings.push(`Internet search was unavailable: ${data.webSearchError}`);
    if (data.internetDropped) warnings.push("Internet search was skipped — web evidence needs the AI model, which is currently unavailable. Add a model API key to include web results.");
    if (warnings.length) {
      warning.textContent = warnings.join(" ");
      warning.style.display = "block";
    }

    renderSummaryEvidence(data.sources || []);
  } catch (error) {
    answer.textContent = `Unable to generate an answer: ${error.message}`;
    document.getElementById("summaryResultMeta").textContent = "Answer failed";
  } finally {
    button.disabled = false;
    button.textContent = "Ask";
  }
}

// Parse a Markdown answer into sections and render it to HTML.
// Supports: "## " headings -> <h4.ans-section>, "- "/"* " bullets -> <ul><li>,
// **bold**, and [A#]/[W#] inline citation chips/links. Legacy "■ " headings and
// citation behaviour are preserved. Unknown headings become "other" sections.
function parseAnswer(text, sources) {
  const sourceMap = new Map((sources || []).map(s => [s.id, s]));
  const renderInline = (line) => {
    let html = escapeHtml(line);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\[([AW]\d+)\]/g, (m, id) => {
      const src = sourceMap.get(id);
      const cls = "ans-cite" + (src?.sourceType === "internet" ? " ans-cite-web" : "");
      const inner = escapeHtml(id);
      if (src && /^https?:\/\//i.test(src.url || "")) {
        return `<a class="${cls}" href="${escapeHtml(src.url)}" target="_blank" rel="noopener" title="${escapeHtml(src.title || "")}">${inner}</a>`;
      }
      return `<span class="${cls}" title="${escapeHtml(src?.title || "")}">${inner}</span>`;
    });
    return html;
  };

  const renderBlocks = (lines) => {
    const out = [];
    let para = [];
    let list = [];
    const flushPara = () => {
      if (para.length) { out.push(`<p>${para.map(l => renderInline(l)).join(" ")}</p>`); para = []; }
    };
    const flushList = () => {
      if (list.length) { out.push(`<ul>${list.map(l => `<li>${renderInline(l)}</li>`).join("")}</ul>`); list = []; }
    };
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) { flushPara(); flushList(); continue; }
      const bullet = line.match(/^[-*]\s+(.*)$/);
      if (bullet) { flushPara(); list.push(bullet[1]); continue; }
      flushList(); para.push(line);
    }
    flushPara(); flushList();
    return out.join("");
  };

  const SECTION_IDS = { "detailed answer": "detailed", "key points": "keyPoints", "conclusion": "conclusion" };
  const classify = (title) => SECTION_IDS[title.trim().toLowerCase()] || "other";

  const lines = String(text || "").split("\n");
  const sections = [];
  let cur = null;
  const pushCur = () => { if (cur) sections.push(cur); };
  const startCur = (title, id) => { pushCur(); cur = { title, id, lines: [] }; };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const h = line.match(/^##\s+(.*)$/);
    if (h) { startCur(h[1].trim(), classify(h[1])); continue; }
    const legacy = line.match(/^■\s+(.*)$/);
    if (legacy) { startCur(legacy[1].trim(), "other"); continue; }
    if (!cur) startCur("", "detailed");
    cur.lines.push(line);
  }
  pushCur();

  const renderSection = (sec) => {
    let out = "";
    if (sec.title) out += `<h4 class="ans-section">${renderInline(sec.title)}</h4>`;
    out += renderBlocks(sec.lines);
    return out;
  };
  const fullHtml = sections.map(renderSection).join("");
  return { sections, fullHtml, renderSection };
}

function renderAnswerWithCitations(text, sources) {
  return parseAnswer(text, sources).fullHtml;
}

function sectionsForStyle(sections, style) {
  const get = (id) => sections.find(s => s.id === id);
  switch (style) {
    case "detailed":   return [get("detailed"), get("conclusion")].filter(Boolean);
    case "bullets":    return [get("keyPoints")].filter(Boolean);
    case "conclusion": return [get("conclusion")].filter(Boolean);
    case "full":
    default:           return sections;
  }
}

let lastAnswerText = "";
let lastAnswerSources = [];

function renderAnswerByStyle() {
  const answer = document.getElementById("summaryAnswer");
  if (!answer) return;
  const style = (document.getElementById("summaryStyle")?.value) || "full";
  const parsed = parseAnswer(lastAnswerText, lastAnswerSources);
  const chosen = sectionsForStyle(parsed.sections, style);
  answer.innerHTML = chosen.length ? chosen.map(parsed.renderSection).join("") : parsed.fullHtml;
}

function renderSummaryEvidence(sources) {
  const container = document.getElementById("summaryEvidence");
  if (!sources.length) {
    container.innerHTML = '<p class="hint">No evidence sources were returned.</p>';
    return;
  }

  container.innerHTML = sources.map(source => {
    const validUrl = /^https?:\/\//i.test(source.url || "");
    const title = escapeHtml(source.title || source.dataset || "Evidence source");
    const titleMarkup = validUrl
      ? `<a href="${escapeHtml(source.url)}" target="_blank" rel="noopener">${title}</a>`
      : `<strong>${title}</strong>`;
    return `
      <article class="summary-evidence-card">
        <div class="summary-evidence-card-header">
          <span class="summary-evidence-id">${escapeHtml(source.id)}</span>
          <span class="summary-evidence-kind">${source.sourceType === "internet" ? "Internet" : escapeHtml(source.dataset || "Application")}</span>
        </div>
        ${titleMarkup}
        <p>${escapeHtml(source.excerpt || "")}</p>
      </article>`;
  }).join("");
}

// ===== Drag-and-Drop Tab Reordering =====
const TAB_ORDER_KEY = "tabOrder";
const DEFAULT_TAB_ORDER = [
  "knowledge-base", "news-view", "search-view", "summarise-view",
  "spider-web", "tencent-products", "gaming-trends",
  "current-use-cases", "regulatory-timeline", "risks", "company-map"
];

function getTabOrder() {
  const stored = localStorage.getItem(TAB_ORDER_KEY);
  if (stored) {
    try {
      const saved = JSON.parse(stored).filter(viewId => DEFAULT_TAB_ORDER.includes(viewId));
      return [...saved, ...DEFAULT_TAB_ORDER.filter(viewId => !saved.includes(viewId))];
    } catch (_) { /* use defaults */ }
  }
  return [...DEFAULT_TAB_ORDER];
}

function saveTabOrder(order) {
  localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order));
}

function restoreTabOrder() {
  const order = getTabOrder();
  const nav = document.getElementById("tabNav");
  if (!nav) return;
  const buttons = nav.querySelectorAll(".nav-btn");
  const btnMap = {};
  buttons.forEach(b => { btnMap[b.dataset.view] = b; });
  // Re-append in saved order (buttons already in DOM will be moved)
  order.forEach(viewId => {
    if (btnMap[viewId]) nav.appendChild(btnMap[viewId]);
  });
}

function getCurrentTabOrder() {
  const nav = document.getElementById("tabNav");
  if (!nav) return [];
  return [...nav.querySelectorAll(".nav-btn")].map(b => b.dataset.view);
}

function setupTabDragDrop() {
  const nav = document.getElementById("tabNav");
  if (!nav) return;

  let draggedEl = null;

  nav.addEventListener("dragstart", (e) => {
    const btn = e.target.closest(".nav-btn");
    if (!btn) return;
    draggedEl = btn;
    btn.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", btn.dataset.view);
  });

  nav.addEventListener("dragend", (e) => {
    const btn = e.target.closest(".nav-btn");
    if (btn) btn.classList.remove("dragging");
    // Remove all drag-over highlights
    nav.querySelectorAll(".nav-btn.drag-over").forEach(b => b.classList.remove("drag-over"));
    draggedEl = null;
    saveTabOrder(getCurrentTabOrder());
  });

  nav.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const btn = e.target.closest(".nav-btn");
    if (!btn || btn === draggedEl) return;
    // Remove previous highlights
    nav.querySelectorAll(".nav-btn.drag-over").forEach(b => b.classList.remove("drag-over"));
    btn.classList.add("drag-over");
  });

  nav.addEventListener("dragleave", (e) => {
    const btn = e.target.closest(".nav-btn");
    if (btn) btn.classList.remove("drag-over");
  });

  nav.addEventListener("drop", (e) => {
    e.preventDefault();
    const targetBtn = e.target.closest(".nav-btn");
    if (!targetBtn || !draggedEl || targetBtn === draggedEl) return;
    targetBtn.classList.remove("drag-over");

    // Insert dragged element before or after target based on position
    const rect = targetBtn.getBoundingClientRect();
    const midY = rect.top + rect.height / 2;
    if (e.clientY < midY) {
      nav.insertBefore(draggedEl, targetBtn);
    } else {
      nav.insertBefore(draggedEl, targetBtn.nextSibling);
    }
    saveTabOrder(getCurrentTabOrder());
  });
}

// ===== Sub-Tab Navigation =====
function setupSubTabs() {
  document.querySelectorAll(".sub-tab-bar").forEach((bar) => {
    bar.querySelectorAll(".sub-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        // Update active state within this bar
        bar.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        // Scroll to target section
        const targetId = btn.dataset.target;
        const target = document.getElementById(targetId);
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      });
    });
  });
}

function resetSubTabForView(viewId) {
  // Activate the first sub-tab in the view's bar
  const bar = document.querySelector(`.sub-tab-bar[data-view="${viewId}"]`);
  if (!bar) return;
  bar.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
  const firstBtn = bar.querySelector(".sub-tab-btn");
  if (firstBtn) firstBtn.classList.add("active");
  if (viewId === "news-view") setNewsViewMode("recent");
}

// ===== Settings Modal =====
function setupSettings() {
  const modal = document.getElementById("settingsModal");

  document.getElementById("settingsBtn").addEventListener("click", () => {
    modal.style.display = "flex";
  });

  document.getElementById("closeSettings").addEventListener("click", () => {
    modal.style.display = "none";
  });

  // Click outside to close
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.style.display = "none";
  });
}

// ===== API Status =====
async function checkApiStatus() {
  try {
    const res = await fetch(`${API_BASE}/status`);
    const data = await res.json();
    const dot = document.querySelector(".status-dot");
    const label = document.querySelector(".status-label");

    dot.classList.add("connected");
    dot.classList.remove("disconnected");
    label.textContent = data.mode || "DuckDuckGo";
  } catch (err) {
    document.querySelector(".status-dot").classList.add("disconnected");
    document.querySelector(".status-dot").classList.remove("connected");
    document.querySelector(".status-label").textContent = "Server Offline";
  }
}

// ===== News Competitor Selection =====
const NEWS_COMPETITORS_KEY = "selectedNewsCompetitors";
const DEFAULT_NEWS_COMPETITORS = ["netease", "mihoyo", "sony", "microsoft"];
let newsCompetitorCatalog = [];
let selectedNewsCompetitorIds = loadSelectedNewsCompetitors();
let pendingNewsCompetitorIds = new Set(selectedNewsCompetitorIds);
// Server-persisted custom competitors (shared, survives browser clears). The
// per-user *selection* still lives in localStorage; only the definitions move
// to the server so they aren't localStorage-only.
let serverCustomCompetitors = [];

function loadSelectedNewsCompetitors() {
  try {
    const saved = JSON.parse(localStorage.getItem(NEWS_COMPETITORS_KEY) || "null");
    return Array.isArray(saved) && saved.length ? saved : [...DEFAULT_NEWS_COMPETITORS];
  } catch (_) {
    return [...DEFAULT_NEWS_COMPETITORS];
  }
}

async function setupNewsCompetitors() {
  document.getElementById("addCompetitorsBtn")?.addEventListener("click", openCompetitorModal);
  document.getElementById("closeCompetitorModal")?.addEventListener("click", closeCompetitorModal);
  document.getElementById("cancelCompetitorSelection")?.addEventListener("click", closeCompetitorModal);
  document.getElementById("applyCompetitorSelection")?.addEventListener("click", applyCompetitorSelection);
  document.getElementById("addCustomCompetitorBtn")?.addEventListener("click", addCustomCompetitor);
  document.getElementById("customCompetitorInput")?.addEventListener("keydown", event => {
    if (event.key === "Enter") { event.preventDefault(); addCustomCompetitor(); }
  });
  document.getElementById("selectAllCompetitors")?.addEventListener("click", () => {
    const validIds = new Set(newsCompetitorCatalog.map(company => company.id));
    const custom = [...pendingNewsCompetitorIds].filter(id => !validIds.has(id));
    pendingNewsCompetitorIds = new Set([...newsCompetitorCatalog.map(company => company.id), ...custom]);
    renderCompetitorPicker(document.getElementById("competitorPickerSearch")?.value || "");
  });
  document.getElementById("clearAllCompetitors")?.addEventListener("click", () => {
    pendingNewsCompetitorIds.clear();
    renderCompetitorPicker(document.getElementById("competitorPickerSearch")?.value || "");
  });
  document.getElementById("competitorPickerSearch")?.addEventListener("input", event => {
    renderCompetitorPicker(event.target.value);
  });
  document.getElementById("competitorModal")?.addEventListener("click", event => {
    if (event.target.id === "competitorModal") closeCompetitorModal();
  });

  updateCompetitorMonitorCard();
  try {
    const response = await fetch(`${API_BASE}/network`);
    const result = await response.json();
    if (!response.ok || !result.success || !result.data?.competitors) {
      throw new Error(result.error || "Competitor list is unavailable");
    }
    newsCompetitorCatalog = result.data.competitors;
    // Keep catalog ids; preserve any user-added custom ids (absent from the
    // catalog by design) so they are not silently dropped on every load.
    if (!selectedNewsCompetitorIds.length) selectedNewsCompetitorIds = [...DEFAULT_NEWS_COMPETITORS];
    pendingNewsCompetitorIds = new Set(selectedNewsCompetitorIds);
    localStorage.setItem(NEWS_COMPETITORS_KEY, JSON.stringify(selectedNewsCompetitorIds));
    updateCompetitorMonitorCard();
  } catch (_) {
    // The defaults remain usable even if the network list cannot be loaded.
  }
}

function getSelectedNewsCompetitors() {
  const catalogIds = new Set(newsCompetitorCatalog.map(company => company.id));
  return selectedNewsCompetitorIds.map(id => {
    const company = newsCompetitorCatalog.find(item => item.id === id);
    if (company) return { id: company.id, name: company.name, custom: false };
    // Id not in the catalog => a user-added custom competitor; keep it labelled.
    return { id, name: id.replace(/-/g, " ").replace(/\b\w/g, char => char.toUpperCase()), custom: true };
  });
}

function updateCompetitorMonitorCard() {
  const selected = getSelectedNewsCompetitors();
  const count = document.getElementById("competitorCount");
  const hoverList = document.getElementById("competitorHoverList");
  if (count) count.textContent = selected.length;
  if (hoverList) {
    hoverList.innerHTML = selected.length
      ? `<strong>Currently monitored</strong>${selected.map(company => escapeHtml(company.name) + (company.custom ? ' <span class="custom-badge">custom</span>' : "")).join("<br>")}`
      : "<strong>No competitors selected</strong>Use Add Competitors to build a focused list.";
  }
}

async function openCompetitorModal() {
  pendingNewsCompetitorIds = new Set(selectedNewsCompetitorIds);
  const search = document.getElementById("competitorPickerSearch");
  if (search) search.value = "";
  await fetchServerCustomCompetitors();
  renderCompetitorPicker();
  document.getElementById("competitorModal").style.display = "flex";
}

function closeCompetitorModal() {
  document.getElementById("competitorModal").style.display = "none";
}

function renderCompetitorPicker(searchQuery = "") {
  const container = document.getElementById("competitorPickerList");
  const query = searchQuery.trim().toLowerCase();
  const catalogIds = new Set(newsCompetitorCatalog.map(company => company.id));
  const companies = newsCompetitorCatalog.filter(company => !query || company.name.toLowerCase().includes(query));

  // Customs = the server-persisted list, plus any custom id already in the
  // pending selection that the server doesn't know about yet (e.g. right after
  // a cold start wiped the disk). Both render under "Your custom competitors".
  const pendingOnlyIds = [...pendingNewsCompetitorIds]
    .filter(id => !catalogIds.has(id) && !serverCustomCompetitors.some(c => c.id === id));
  const customEntries = [
    ...serverCustomCompetitors,
    ...pendingOnlyIds.map(id => ({ id, name: id, custom: true })),
  ].filter(c => !query || c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (!newsCompetitorCatalog.length) {
    container.innerHTML = '<div class="empty-state"><p>Competitor list is unavailable. Please try again.</p></div>';
    updateCompetitorSelectionSummary();
    return;
  }

  const parts = [];
  if (customEntries.length) {
    parts.push('<div class="picker-group-label">Your custom competitors (saved on server)</div>');
    customEntries.forEach(entry => {
      parts.push(`
      <div class="competitor-picker-option custom">
        <label>
          <input type="checkbox" value="${escapeHtml(entry.id)}" ${pendingNewsCompetitorIds.has(entry.id) ? "checked" : ""}>
          <span>${escapeHtml(entry.name)}</span>
        </label>
        <button type="button" class="custom-remove" data-remove-id="${escapeHtml(entry.id)}" aria-label="Remove custom competitor">&times;</button>
      </div>`);
    });
  }
  if (companies.length) {
    if (customEntries.length) parts.push('<div class="picker-group-label">From the catalog</div>');
    companies.forEach(company => {
      parts.push(`
      <label class="competitor-picker-option">
        <input type="checkbox" value="${escapeHtml(company.id)}" ${pendingNewsCompetitorIds.has(company.id) ? "checked" : ""}>
        <span>${escapeHtml(company.name)}</span>
      </label>`);
    });
  }

  container.innerHTML = parts.length
    ? parts.join("")
    : '<div class="empty-state"><p>No competitors match that search.</p></div>';

  container.querySelectorAll('input[type="checkbox"]').forEach(input => {
    input.addEventListener("change", () => {
      if (input.checked) pendingNewsCompetitorIds.add(input.value);
      else pendingNewsCompetitorIds.delete(input.value);
      updateCompetitorSelectionSummary();
    });
  });
  container.querySelectorAll('.custom-remove').forEach(btn => {
    btn.addEventListener("click", () => removeCustomCompetitor(btn.dataset.removeId));
  });
  updateCompetitorSelectionSummary();
}

async function fetchServerCustomCompetitors() {
  try {
    const res = await fetch(`${API_BASE}/news/custom-competitors`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await res.json();
    serverCustomCompetitors = Array.isArray(data.customCompetitors) ? data.customCompetitors : [];
  } catch (_) { /* keep whichever list we already had */ }
}

async function removeCustomCompetitor(id) {
  try {
    await fetch(`${API_BASE}/news/custom-competitors/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (_) { /* fall through to local cleanup regardless */ }
  pendingNewsCompetitorIds.delete(id);
  serverCustomCompetitors = serverCustomCompetitors.filter(c => c.id !== id);
  renderCompetitorPicker(document.getElementById("competitorPickerSearch")?.value || "");
}

async function addCustomCompetitor() {
  const input = document.getElementById("customCompetitorInput");
  if (!input) return;
  const name = input.value.trim().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  if (!name) return;
  if (name.length > 40) { showToast("Keep competitor names under 40 characters."); return; }
  input.value = "";
  // Server is the source of truth: it dedupes against the catalog and persists
  // the custom definition so it survives across devices and browser clears.
  try {
    const res = await fetch(`${API_BASE}/news/custom-competitors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) { showToast("Could not add that competitor."); return; }
    const data = await res.json();
    const competitor = data.competitor;
    if (!competitor) { showToast("Could not add that competitor."); return; }
    pendingNewsCompetitorIds.add(competitor.id);
    if (Array.isArray(data.customCompetitors)) serverCustomCompetitors = data.customCompetitors;
    else await fetchServerCustomCompetitors();
    renderCompetitorPicker(document.getElementById("competitorPickerSearch")?.value || "");
    showToast(data.custom ? `Saved custom competitor: ${competitor.name}` : `Added ${competitor.name}`);
  } catch (_) {
    showToast("Could not add that competitor.");
  }
}

function updateCompetitorSelectionSummary() {
  const summary = document.getElementById("competitorSelectionSummary");
  if (summary) summary.textContent = `${pendingNewsCompetitorIds.size} selected`;
}

function applyCompetitorSelection() {
  if (!pendingNewsCompetitorIds.size) {
    showToast("Select at least one competitor to monitor.");
    return;
  }
  selectedNewsCompetitorIds = [...pendingNewsCompetitorIds];
  localStorage.setItem(NEWS_COMPETITORS_KEY, JSON.stringify(selectedNewsCompetitorIds));
  updateCompetitorMonitorCard();
  closeCompetitorModal();
  loadNews(true);
}

// ===== Load News =====
async function loadNews(forceRefresh = false) {
  const feed = document.getElementById("newsFeed");
  feed.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Scanning competitor news...</p></div>';

  try {
    const params = new URLSearchParams({ competitors: selectedNewsCompetitorIds.join(",") });
    if (forceRefresh) params.set("refresh", Date.now().toString());
    const res = await fetch(`${API_BASE}/news?${params.toString()}`, { cache: "no-store" });
    const data = await res.json();

    if (!data.success) {
      feed.innerHTML = `<div class="empty-state"><div class="empty-icon">&#x26A0;</div><p>${data.error || "Failed to fetch news"}</p></div>`;
      return;
    }

    document.getElementById("articleCount").textContent = data.count;

    const updatedEl = document.getElementById("lastUpdated");
    if (data.cached) {
      updatedEl.innerHTML = '<span style="color:#d97706;">&#x26A0; Cached results</span> &mdash; ' +
        new Date(data.searchedAt).toLocaleString();
    } else {
      updatedEl.textContent = "Last updated: " + new Date(data.searchedAt).toLocaleTimeString();
    }

    // Article tags include both broad news topics and focused competitor searches.
    const competitors = new Set();
    data.articles?.forEach((a) => {
      if (a.competitorKeyword) competitors.add(a.competitorKeyword);
    });
    updateCompetitorMonitorCard();

    if (!data.articles?.length) {
      feed.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x1F4ED;</div><p>No articles found. Try refreshing or check the Search tab for custom queries.</p></div>';
      return;
    }

    // Build filter tags
    const filterDiv = document.getElementById("filterTags");
    filterDiv.innerHTML = "";
    const allTag = document.createElement("span");
    allTag.className = "filter-tag active";
    allTag.textContent = "All";
    allTag.addEventListener("click", () => filterNews(null, allTag));
    filterDiv.appendChild(allTag);

    competitors.forEach((kw) => {
      const tag = document.createElement("span");
      tag.className = "filter-tag";
      tag.textContent = kw.replace(/ Tencent 2026/i, "").replace(/ gaming technology/i, "");
      tag.addEventListener("click", () => filterNews(kw, tag));
      filterDiv.appendChild(tag);
    });

    allArticles = data.articles;
    if (newsViewMode === "saved") {
      renderSavedArticles();
    } else {
      renderNewsCards(allArticles, null);
    }
  } catch (err) {
    feed.innerHTML = `<div class="empty-state"><div class="empty-icon">&#x26A0;</div><p>Error: ${err.message}</p></div>`;
  }
}

const SAVED_ARTICLES_KEY = "savedNewsArticles";
let currentFilter = null;
let allArticles = [];
let newsViewMode = "recent";
let savedNewsArticles = loadSavedNewsArticles();

function loadSavedNewsArticles() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_ARTICLES_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch (_) {
    return [];
  }
}

function saveNewsArticles() {
  localStorage.setItem(SAVED_ARTICLES_KEY, JSON.stringify(savedNewsArticles));
  updateSavedArticleCount();
  renderSavedArticlesForReport();
}

function newsArticleKey(article) {
  return article?.url || `${article?.title || ""}|${article?.publishedAt || ""}`;
}

function isNewsArticleSaved(article) {
  const key = newsArticleKey(article);
  return savedNewsArticles.some(saved => newsArticleKey(saved) === key);
}

function setupNewsFavorites() {
  updateSavedArticleCount();

  document.querySelectorAll('[data-news-mode]').forEach(button => {
    button.addEventListener("click", () => {
      setNewsViewMode(button.dataset.newsMode);
    });
  });

  document.getElementById("newsFeed")?.addEventListener("click", event => {
    const button = event.target.closest(".news-favorite-btn");
    if (!button) return;
    event.preventDefault();
    event.stopPropagation();

    const key = decodeURIComponent(button.dataset.articleKey || "");
    const article = [...allArticles, ...savedNewsArticles]
      .find(item => newsArticleKey(item) === key);
    if (article) toggleNewsFavorite(article);
  });
}

function setNewsViewMode(mode) {
  newsViewMode = mode === "saved" ? "saved" : "recent";
  const title = document.getElementById("newsSectionTitle");
  const filters = document.getElementById("filterTags");

  if (title) title.textContent = newsViewMode === "saved" ? "Saved Articles" : "Recent News & Updates";
  if (filters) filters.style.display = newsViewMode === "saved" ? "none" : "flex";

  if (newsViewMode === "saved") {
    renderSavedArticles();
  } else {
    renderNewsCards(allArticles, currentFilter);
  }
}

function toggleNewsFavorite(article) {
  const key = newsArticleKey(article);
  const existingIndex = savedNewsArticles.findIndex(saved => newsArticleKey(saved) === key);

  if (existingIndex >= 0) {
    savedNewsArticles.splice(existingIndex, 1);
  } else {
    savedNewsArticles.unshift({ ...article, savedAt: new Date().toISOString() });
  }

  saveNewsArticles();
  showToast(existingIndex >= 0 ? "Article removed from saved items." : "Article saved for later.");
  if (newsViewMode === "saved") {
    renderSavedArticles();
  } else {
    renderNewsCards(allArticles, currentFilter);
  }
}

function updateSavedArticleCount() {
  const count = document.getElementById("savedArticleCount");
  if (count) count.textContent = savedNewsArticles.length;
}

function renderSavedArticles() {
  renderNewsCards(savedNewsArticles, null, true);
}

// ===== Saved Articles -> Report bridge =====
// Lists the user's starred articles inside the Reports workspace so they can be
// pulled into the current report draft without leaving the tab.
function renderSavedArticlesForReport() {
  const container = document.getElementById("savedArticlesForReport");
  if (!container) return;
  if (!savedNewsArticles.length) {
    container.innerHTML = '<p class="hint">No saved articles yet. Star articles in Recent News &amp; Updates to add them here.</p>';
    return;
  }
  container.innerHTML = savedNewsArticles.map(article => {
    const url = article.url || "";
    let norm = null;
    try { norm = new URL(url).toString(); } catch (_) { norm = null; }
    const inReport = norm && reportUrls.some(s => s.url === norm);
    const disabled = !norm || inReport;
    const safeUrl = norm || "#";
    const sourceBits = [];
    if (article.sourceName) {
      sourceBits.push(article.sourceName);
    } else if (norm) {
      try { sourceBits.push(new URL(url).hostname.replace(/^www\./i, "")); } catch (_) { /* no host */ }
    }
    if (article.publishedAt) {
      sourceBits.push(new Date(article.publishedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }));
    }
    const sourceLine = sourceBits.filter(Boolean).join(" · ");
    const label = inReport ? "Added" : (norm ? "Add" : "No URL");
    return `
      <div class="url-item report-source-item saved-article-item">
        <div class="report-source-info">
          <strong><a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">${escapeHtml(article.title || "Untitled")}</a></strong>
          ${sourceLine ? `<span class="saved-article-meta">${escapeHtml(sourceLine)}</span>` : ""}
        </div>
        <button class="btn btn-sm saved-article-add" type="button" data-url="${escapeHtml(url)}" ${disabled ? "disabled" : ""}>${label}</button>
      </div>`;
  }).join("");

  container.querySelectorAll(".saved-article-add:not([disabled])").forEach(btn => {
    btn.addEventListener("click", () => {
      const article = savedNewsArticles.find(a => (a.url || "") === btn.dataset.url);
      if (article) addSavedArticleToReport(article);
    });
  });
}

function addSavedArticleToReport(article) {
  const url = article.url || "";
  if (!/^https?:\/\//i.test(url)) {
    showToast("This saved article has no valid URL to add");
    return;
  }
  // Add the saved article as a REAL source to be scraped live when the report
  // is generated. Previously these were seeded with just the RSS snippet
  // (sourceType: news-snippet); now they go through the same live extraction as
  // any pasted URL — the server resolves news.google.com redirect URLs to the
  // publisher and pulls the full article body. Passing no extracted content lets
  // addUrlToReport mark it "Pending extraction" so the user knows it will be
  // fetched on generation.
  if (addUrlToReport(url, article.title || url)) {
    renderSavedArticlesForReport();
  }
}

function renderNewsCards(articles, filter, savedView = false) {
  currentFilter = savedView ? null : filter;

  const feed = document.getElementById("newsFeed");

  const filtered = filter
    ? articles.filter((a) => a.competitorKeyword === filter)
    : articles;

  if (!filtered.length) {
    feed.innerHTML = savedView
      ? '<div class="empty-state"><div class="empty-icon">&#9734;</div><p>No saved articles yet.</p><p>Star an article in Recent News &amp; Updates to keep it here for later.</p></div>'
      : '<div class="empty-state"><p>No articles match this filter</p></div>';
    return;
  }

  feed.innerHTML = filtered
    .map((a, i) => {
      const safeUrl = /^https?:\/\//i.test(a.url || "") ? a.url : "#";
      const sourceBits = [];
      if (a.sourceName) {
        sourceBits.push(a.sourceName);
      } else if (safeUrl !== "#") {
        // Fall back to the article's host, not the full URL (the title is the
        // link already, so repeating the raw URL wastes space on the card).
        try { sourceBits.push(new URL(a.url).hostname.replace(/^www\./i, "")); } catch (_) { /* no host */ }
      }
      if (a.publishedAt) {
        sourceBits.push(new Date(a.publishedAt).toLocaleDateString(undefined, {
          year: "numeric", month: "short", day: "numeric"
        }));
      }
      const sourceLine = sourceBits.filter(Boolean).join(" · ");
      const saved = isNewsArticleSaved(a);
      const articleKey = encodeURIComponent(newsArticleKey(a));

      return `
    <div class="news-card${saved ? " is-saved" : ""}" data-index="${i}">
      <div class="news-card-header">
        <div class="news-title">
          <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">${escapeHtml(a.title || "Untitled")}</a>
        </div>
        <div class="news-card-actions">
          <button class="news-favorite-btn${saved ? " active" : ""}" data-article-key="${escapeHtml(articleKey)}" aria-label="${saved ? "Remove from saved articles" : "Save article for later"}" title="${saved ? "Remove from saved articles" : "Save article for later"}">${saved ? "&#9733;" : "&#9734;"}</button>
        </div>
      </div>
      <div class="news-tag-row">
        <span class="news-tag">${escapeHtml((a.competitorKeyword || "News").replace(/ Tencent 2026/i, ""))}</span>
      </div>
      <p class="news-source">${escapeHtml(sourceLine)}</p>
      <p class="news-description">${escapeHtml(trimDescription(a.subhead || a.description))}</p>
    </div>`;
    })
    .join("");

  if (!savedView) setupNewsSubheadEnrichment(feed, filtered);
}

// Trims an article snippet to a short "hook" (first part) on a word boundary so
// narrow news cards stay at-a-glance without vertical scrolling. CSS line-clamp
// handles the final visual truncation; this caps the DOM size.
// Lazy subhead enrichment: as news cards (including the top 6, which sit in
// the initial viewport) scroll into view, fetch a real subhead/strapline for
// any card that doesn't already have one. The server no longer blocks the
// /api/news response on enrichment, so every card is filled in on demand here.
// Updates the article object + the card's text so re-renders keep the result.
// Only recent (non-saved) cards are enriched.
let newsSubheadObserver = null;
function setupNewsSubheadEnrichment(feedEl, articles) {
  if (!("IntersectionObserver" in window)) return;
  if (newsSubheadObserver) newsSubheadObserver.disconnect();
  newsSubheadObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const card = entry.target;
      newsSubheadObserver.unobserve(card);
      const a = articles[Number(card.dataset.index)];
      if (!a || a.subhead || a.__subheadRequested) return;
      a.__subheadRequested = true;
      enrichCardSubhead(a, card);
    });
  }, { rootMargin: "300px" });
  feedEl.querySelectorAll(".news-card").forEach((card) => newsSubheadObserver.observe(card));
}

async function enrichCardSubhead(article, card) {
  try {
    const resp = await fetch(
      "/api/news/subhead?url=" + encodeURIComponent(article.url || "") +
      "&title=" + encodeURIComponent(article.title || "")
    );
    if (!resp.ok) return;
    const data = await resp.json();
    if (!data.subhead) return;
    article.subhead = data.subhead;
    const descEl = card.querySelector(".news-description");
    if (descEl) descEl.textContent = trimDescription(data.subhead);
  } catch (_) { /* keep the RSS description on failure */ }
}

function trimDescription(text, max = 200) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
}

function filterNews(keyword, tagEl) {
  document.querySelectorAll(".filter-tag").forEach((t) => t.classList.remove("active"));
  if (tagEl) tagEl.classList.add("active");
  renderNewsCards(allArticles, keyword);
}

// ===== Search =====
let searchResultsData = [];

async function doSearch() {
  const input = document.getElementById("searchInput");
  const query = input.value.trim();
  if (!query) return;

  const limit = parseInt(document.getElementById("searchLimit").value);
  const resultsDiv = document.getElementById("searchResultsSection");

  resultsDiv.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Searching...</p></div>';

  try {
    const res = await fetch(`${API_BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
    });

    const data = await res.json();

    if (!data.success) {
      resultsDiv.innerHTML = `<div class="empty-state"><div class="empty-icon">&#x26A0;</div><p>${data.error || "Search failed"}</p></div>`;
      return;
    }

    searchResultsData = (data.data || []).map(result => ({ ...result, searchQuery: query }));

    if (!searchResultsData.length) {
      resultsDiv.innerHTML = '<div class="empty-state"><div class="empty-icon">&#x1F50E;</div><p>No results found. Try a different query.</p></div>';
      return;
    }

    resultsDiv.innerHTML = searchResultsData
      .map(
        (r, i) => `
      <div class="result-card">
        <div class="result-info">
          <div class="result-title">${r.title || "Untitled"}</div>
          <div class="result-url">${r.url || ""}</div>
          <div class="result-snippet">${r.description || ""}</div>
        </div>
        <div class="result-actions">
          <button class="btn btn-sm scrape-btn" data-index="${i}">&#x1F4C4; Scrape</button>
          <button class="btn btn-sm report-add-btn" data-index="${i}">+ Report</button>
        </div>
      </div>`
      )
      .join("");

    // Attach event listeners
    document.querySelectorAll(".scrape-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(e.target.dataset.index);
        scrapeUrl(searchResultsData[idx].url, searchResultsData[idx].title, searchResultsData[idx].searchQuery);
      });
    });

    document.querySelectorAll(".report-add-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        const idx = parseInt(e.target.dataset.index);
        addUrlToReport(searchResultsData[idx].url, searchResultsData[idx].title, null, searchResultsData[idx].searchQuery);
        e.target.textContent = "Added!";
        e.target.disabled = true;
        setTimeout(() => {
          e.target.textContent = "+ Report";
          e.target.disabled = false;
        }, 1500);
      });
    });
  } catch (err) {
    resultsDiv.innerHTML = `<div class="empty-state"><div class="empty-icon">&#x26A0;</div><p>Error: ${err.message}</p></div>`;
  }
}

// ===== Website / Video Transcript Extraction =====
async function scrapeUrl(url, title, searchQuery = "") {
  const panel = document.getElementById("scrapeSection");
  const content = document.getElementById("scrapedContent");

  panel.style.display = "flex";
  content.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Extracting website text or video transcript...</p></div>';
  currentScrapedSource = null;

  try {
    const res = await fetch(`${API_BASE}/scrape`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();

    if (!data.success) {
      content.innerHTML = `<div class="scrape-error"><strong>Extraction failed</strong><p>${escapeXml(data.error || "Unknown extraction error")}</p><a href="${escapeXml(url)}" target="_blank" rel="noopener">Open source</a></div>`;
      return;
    }

    const extracted = data.data;
    const metadata = extracted.metadata || {};
    const sourceTitle = metadata.title || title || url;
    currentScrapedSource = {
      url: metadata.originalUrl || url,
      finalUrl: metadata.url || url,
      title: sourceTitle,
      content: extracted.content || extracted.markdown || "",
      sourceType: metadata.sourceType || "webpage",
      extractionMethod: metadata.extractionMethod || "Extracted content",
      wordCount: metadata.wordCount || 0,
      searchQuery,
    };

    content.innerHTML = `
      <div class="scrape-result-header">
        <div>
          <span class="scrape-type-badge">${metadata.sourceType === "video-transcript" ? "Video transcript" : "Website text"}</span>
          <h3>${escapeXml(sourceTitle)}</h3>
          <a href="${escapeXml(metadata.url || url)}" target="_blank" rel="noopener">${escapeXml(metadata.url || url)}</a>
        </div>
        <div class="scrape-metrics">
          <strong>${Number(metadata.wordCount || 0).toLocaleString()}</strong>
          <span>words</span>
        </div>
      </div>
      <div class="scrape-summary">
        <strong>Extracted summary</strong>
        <p>${escapeXml(extracted.summary || "No concise summary could be generated.")}</p>
      </div>
      <div class="scrape-method">${escapeXml(metadata.extractionMethod || "Content extraction")}${metadata.language && metadata.language !== "unknown" ? ` &middot; ${escapeXml(metadata.language)}` : ""}</div>
      <div class="scrape-extracted-text">${escapeXml(truncateText(currentScrapedSource.content, 18000))}</div>`;
  } catch (err) {
    content.innerHTML = `<div class="scrape-error"><strong>Extraction error</strong><p>${escapeXml(err.message)}</p></div>`;
  }
}

function addCurrentToReport() {
  if (!currentScrapedSource) return showToast("Extract a source before adding it to the report");
  addUrlToReport(currentScrapedSource.url, currentScrapedSource.title, currentScrapedSource);
}

// ===== Report Sources =====
function addUrlToReport(url, title, extractedSource = null, searchQuery = "") {
  let normalisedUrl;
  try {
    normalisedUrl = new URL(url).toString();
  } catch {
    showToast("Enter a valid HTTP or HTTPS URL");
    return false;
  }
  if (!["http:", "https:"].includes(new URL(normalisedUrl).protocol)) {
    showToast("Only HTTP and HTTPS URLs are supported");
    return false;
  }
  if (reportUrls.find(source => source.url === normalisedUrl)) {
    showToast("Source is already in this report");
    return false;
  }

  reportUrls.push({
    url: normalisedUrl,
    title: title || normalisedUrl,
    searchQuery: searchQuery || extractedSource?.searchQuery || "",
    ...(extractedSource ? {
      finalUrl: extractedSource.finalUrl,
      content: extractedSource.content,
      sourceType: extractedSource.sourceType,
      extractionMethod: extractedSource.extractionMethod,
      wordCount: extractedSource.wordCount,
    } : {}),
  });
  renderUrlList();
  showToast(extractedSource ? "Extracted source added to report" : "Source URL added to report");
  return true;
}

function removeUrlFromReport(url) {
  reportUrls = reportUrls.filter(source => source.url !== url);
  renderUrlList();
}

function renderUrlList() {
  const list = document.getElementById("urlList");
  updateReportDraftCount();
  if (!reportUrls.length) {
    list.innerHTML = '<p class="hint">Add website or video URLs. Public captions are extracted as transcripts when available.</p>';
    return;
  }

  list.innerHTML = reportUrls.map(source => `
    <div class="url-item report-source-item">
      <div class="report-source-info">
        <span class="report-source-type">${source.sourceType === "video-transcript" ? "Transcript" : source.content ? "Extracted webpage" : "Pending extraction"}</span>
        <strong>${escapeXml(source.title)}</strong>
        ${source.searchQuery ? `<span class="report-source-focus">Search focus: ${escapeXml(source.searchQuery)}</span>` : ""}
        <a href="${escapeXml(source.url)}" target="_blank" rel="noopener">${escapeXml(source.url)}</a>
      </div>
      <button class="remove-url" type="button" data-url="${escapeXml(source.url)}" aria-label="Remove source">&#x2715;</button>
    </div>
  `).join("");

  list.querySelectorAll(".remove-url").forEach(element => {
    element.addEventListener("click", event => removeUrlFromReport(event.currentTarget.dataset.url));
  });
}

// ===== Generate Report =====
async function generateReport() {
  if (!reportUrls.length) {
    showToast("Add at least one URL to the report");
    return;
  }

  const enteredTitle = document.getElementById("reportTitle").value.trim();
  const searchQueries = [...new Set(reportUrls.map(source => source.searchQuery).filter(Boolean))];
  const title = enteredTitle || (searchQueries.length === 1 ? `${searchQueries[0]} Report` : "Competitive Intelligence Report");
  const resultDiv = document.getElementById("reportResult");

  resultDiv.style.display = "block";
  resultDiv.scrollIntoView({ behavior: "smooth" });

  const findingsList = document.getElementById("reportFindings");
  const sourcesList = document.getElementById("reportSources");
  findingsList.innerHTML = '<li>Generating report...</li>';

  try {
    const res = await fetch(`${API_BASE}/report`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sources: reportUrls,
        title,
      }),
    });

    const data = await res.json();

    if (!data.success) {
      findingsList.innerHTML = `<li>Error: ${data.error}</li>`;
      return;
    }

    const report = data.report;

    displayReport(report);

    // Save the complete sourced report for later review.
    savedReports.unshift({
      ...report,
      date: report.generatedAt,
      findings: report.keyFindings,
    });
    if (savedReports.length > 20) savedReports = savedReports.slice(0, 20);
    localStorage.setItem("savedReports", JSON.stringify(savedReports));
    renderSavedReports();

    // Clear report URLs
    reportUrls = [];
    renderUrlList();
    renderSavedArticlesForReport();
  } catch (err) {
    findingsList.innerHTML = `<li>Error: ${err.message}</li>`;
  }
}

function displayReport(report) {
  const generatedAt = report.generatedAt || report.date;
  const keyFindings = (report.keyFindings || report.findings || []).slice(0, 5);
  document.getElementById("reportResult").style.display = "block";
  document.getElementById("reportResultTitle").textContent = report.title;
  document.getElementById("reportDate").textContent = generatedAt
    ? "Generated: " + new Date(generatedAt).toLocaleString()
    : "";
  document.getElementById("reportFindings").innerHTML = keyFindings.length
    ? keyFindings.map(finding => `<li>${escapeXml(finding)}</li>`).join("")
    : '<li>No key findings were generated.</li>';

  const themes = report.themes || [];
  document.getElementById("reportThemes").innerHTML = themes.length ? `
    <h3>Topics</h3>
    <div class="report-theme-grid">
      ${themes.map(theme => `
        <article class="report-theme-card">
          <h4>${escapeXml(theme.title)}</h4>
          <ul>${theme.findings.map(finding => `<li>${escapeXml(finding)}</li>`).join("")}</ul>
        </article>
      `).join("")}
    </div>` : "";

  const sourceSummaries = report.sourceSummaries || (report.sources || []).map(source => ({ ...source, sourceNumber: source.number }));
  const sourceItems = sourceSummaries.map(source => `
    <li class="report-source-record">
      <a href="${escapeXml(source.url)}" target="_blank" rel="noopener">${source.sourceNumber ? `[${source.sourceNumber}] ` : ""}${escapeXml(source.title)}</a>
      <span>${source.sourceType === "video-transcript" ? "Video transcript" : "Website text"}${source.wordCount ? ` &middot; ${Number(source.wordCount).toLocaleString()} words` : ""}${source.extractionMethod ? ` &middot; ${escapeXml(source.extractionMethod)}` : ""}</span>
      ${source.searchQuery ? `<strong class="report-source-focus">Search focus: ${escapeXml(source.searchQuery)}</strong>` : ""}
      ${source.summarySentences?.length
        ? `<ul class="report-source-summary">${source.summarySentences.map(sentence => `<li>${escapeXml(sentence)}</li>`).join("")}</ul>`
        : source.summary ? `<p class="report-source-summary-text">${escapeXml(source.summary)}</p>` : ""}
    </li>`);
  const failedItems = (report.failedSources || []).map(source => `
    <li class="report-source-record report-source-failed">
      <a href="${escapeXml(source.url)}" target="_blank" rel="noopener">${escapeXml(source.title || source.url)}</a>
      ${source.searchQuery ? `<strong class="report-source-focus">Search focus: ${escapeXml(source.searchQuery)}</strong>` : ""}
      <span>Not extracted &middot; ${escapeXml(source.error)}</span>
    </li>`);
  document.getElementById("reportSources").innerHTML = [...sourceItems, ...failedItems].join("");

  document.getElementById("reportFullContent").textContent = report.fullContent || "";
  document.getElementById("reportFull").style.display = "none";
  document.getElementById("toggleFullContent").textContent = "Show Cohesive Report";
}

function toggleFullContent() {
  const full = document.getElementById("reportFull");
  const btn = document.getElementById("toggleFullContent");
  if (full.style.display === "none") {
    full.style.display = "block";
    btn.textContent = "Hide Cohesive Report";
  } else {
    full.style.display = "none";
    btn.textContent = "Show Cohesive Report";
  }
}

function renderSavedReports() {
  const container = document.getElementById("savedReportsList");
  if (!savedReports.length) {
    container.innerHTML = '<p class="hint">No saved reports yet</p>';
    return;
  }

  container.innerHTML = savedReports
    .map(
      (r, i) => `
    <div class="result-card" style="flex-direction:column;align-items:flex-start;">
      <strong>${r.title}</strong>
      <span style="font-size:0.8rem;color:var(--text-muted);">${new Date(r.date).toLocaleString()}</span>
      <span style="font-size:0.82rem;color:var(--text-muted);">${(r.keyFindings || r.findings || []).slice(0, 5).length} findings | ${(r.sources || []).length} sources</span>
      <div style="margin-top:0.5rem;display:flex;gap:0.5rem;">
        <button class="btn btn-sm load-report-btn" data-index="${i}">Load</button>
        <button class="btn btn-sm delete-report-btn" data-index="${i}">Delete</button>
      </div>
    </div>`
    )
    .join("");

  document.querySelectorAll(".load-report-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.target.dataset.index);
      loadSavedReport(idx);
    });
  });

  document.querySelectorAll(".delete-report-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const idx = parseInt(e.target.dataset.index);
      savedReports.splice(idx, 1);
      localStorage.setItem("savedReports", JSON.stringify(savedReports));
      renderSavedReports();
    });
  });
}

function loadSavedReport(idx) {
  const report = savedReports[idx];
  if (!report) return;

  switchSearchReportsWorkspace("reports");
  displayReport(report);
  document.getElementById("reportResult").scrollIntoView({ behavior: "smooth" });
}

// ===== Knowledge Base =====
let kbData = null;
let kbActiveCategory = null;

async function loadKnowledgeBase(category = null, search = null) {
  const content = document.getElementById("kbContent");
  content.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading knowledge base...</p></div>';

  try {
    let url = `${API_BASE}/knowledge`;
    const params = [];
    if (category) params.push(`category=${category}`);
    if (search) params.push(`search=${encodeURIComponent(search)}`);
    if (params.length) url += "?" + params.join("&");

    const res = await fetch(url);
    const result = await res.json();

    if (!result.success) {
      content.innerHTML = `<div class="empty-state"><p>${result.error || "Failed to load"}</p></div>`;
      return;
    }

    kbData = result.data;
    kbActiveCategory = category;

    // Render category buttons
    renderKBCategories();

    // Render content
    renderKBContent(search);
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
  }
}

function renderKBCategories() {
  const container = document.getElementById("kbCategories");
  if (!kbData || !kbData.categories) return;

  let html = '<button class="kb-cat-btn active" data-cat="">All</button>';
  for (const [key, cat] of Object.entries(kbData.categories)) {
    const active = kbActiveCategory === key ? " active" : "";
    html += `<button class="kb-cat-btn${active}" data-cat="${key}">${cat.icon} ${cat.label}</button>`;
  }
  container.innerHTML = html;

  container.querySelectorAll(".kb-cat-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.getElementById("kbSearchInput").value = "";
      loadKnowledgeBase(btn.dataset.cat || null, null);
    });
  });
}

function renderKBContent(searchQuery = null) {
  const content = document.getElementById("kbContent");
  const timelineToggleBar = document.getElementById("timelineToggleBar");
  const categories = kbData?.categories;

  // Show timeline toggle only when viewing regulatory-timeline category
  const showTimelineToggle = kbActiveCategory === "regulatory-timeline" ||
    (Object.keys(categories || {}).length === 1 && Object.keys(categories)[0] === "regulatory-timeline");
  timelineToggleBar.style.display = showTimelineToggle ? "flex" : "none";

  if (!categories || !Object.keys(categories).length) {
    content.innerHTML = '<div class="kb-no-results"><div class="empty-icon">&#x1F50E;</div><p>No matching content found</p></div>';
    return;
  }

  // If timeline view is active for regulatory-timeline, render visual timeline
  if (showTimelineToggle && currentTimelineView === "visual") {
    renderTimelineView(categories, content);
    return;
  }

  let html = "";

  for (const [key, cat] of Object.entries(categories)) {
    const subsections = cat.subsections || [];
    html += `
    <div class="kb-section">
      <div class="kb-section-header" data-section="${key}">
        <span style="font-size:1.2rem;">${cat.icon}</span>
        <span class="kb-section-title">${cat.label}</span>
        <span class="kb-section-count">${subsections.length} entries</span>
        <span class="kb-section-arrow">&#x25BC;</span>
      </div>
      <div class="kb-section-body">`;

    for (const sub of subsections) {
      let displayContent = escapeHtml(sub.content || "");
      if (searchQuery) {
        const regex = new RegExp(`(${searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, "gi");
        displayContent = displayContent.replace(regex, '<span class="highlight">$1</span>');
      }

      let sourceLinks = "";
      if (sub.sources && sub.sources.length) {
        sourceLinks = `
        <div class="kb-sources">
          ${sub.sources.map(s => `<a href="${safeHref(s.url)}" target="_blank" rel="noopener" class="kb-source-link">${escapeHtml(s.label || s.url || "")}</a>`).join("")}
        </div>`;
      }

      html += `
        <div class="kb-card">
          <div class="kb-card-title">${escapeHtml(sub.title || "")}</div>
          <div class="kb-card-content">${displayContent}</div>
          ${sourceLinks}
        </div>`;
    }

    html += `</div></div>`;
  }

  content.innerHTML = html;

  // Toggle collapse
  content.querySelectorAll(".kb-section-header").forEach((header) => {
    header.addEventListener("click", () => {
      header.parentElement.classList.toggle("collapsed");
    });
  });
}

// Setup KB search & timeline toggle
document.addEventListener("DOMContentLoaded", () => {
  const kbSearchInput = document.getElementById("kbSearchInput");
  const kbSearchBtn = document.getElementById("kbSearchBtn");
  const kbClearBtn = document.getElementById("kbClearBtn");

  if (kbSearchBtn) {
    kbSearchBtn.addEventListener("click", () => {
      const query = kbSearchInput.value.trim();
      loadKnowledgeBase(null, query || null);
    });
  }

  if (kbSearchInput) {
    kbSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const query = kbSearchInput.value.trim();
        loadKnowledgeBase(null, query || null);
      }
    });
  }

  if (kbClearBtn) {
    kbClearBtn.addEventListener("click", () => {
      kbSearchInput.value = "";
      loadKnowledgeBase(null, null);
    });
  }

  // Timeline view toggle buttons
  document.querySelectorAll(".timeline-view-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".timeline-view-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      currentTimelineView = btn.dataset.timelineView;
      renderKBContent();
    });
  });
});

// ===== Timeline View =====
let currentTimelineView = "list";

function renderTimelineView(categories, container) {
  const timelineCat = categories["regulatory-timeline"];
  if (!timelineCat) {
    container.innerHTML = '<div class="kb-no-results"><p>No timeline data available</p></div>';
    return;
  }

  const entries = timelineCat.subsections || [];

  // Extract dates from titles and sort chronologically
  const parsed = entries.map(e => {
    let date = null;
    let label = e.title;
    // Parse dates like "2 August 2026", "2 December 2027", "2026-2027", "2027"
    const dateMatch = e.title.match(/(\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4}))/i);
    if (dateMatch) {
      date = new Date(dateMatch[1]);
      label = e.title.replace(dateMatch[0], "").replace(/[—–-]\s*$/, "").trim();
    } else {
      const yearMatch = e.title.match(/(\d{4})/);
      if (yearMatch) {
        date = new Date(parseInt(yearMatch[1]), 6, 1); // mid-year
      }
    }
    return { ...e, date, label };
  });

  // Sort by date
  parsed.sort((a, b) => {
    if (!a.date && !b.date) return 0;
    if (!a.date) return 1;
    if (!b.date) return -1;
    return a.date - b.date;
  });

  // Build timeline SVG
  const colors = ["#2563eb", "#7c3aed", "#dc2626", "#ea580c", "#059669"];
  const itemHeight = 140;
  const marginLeft = 280;
  const marginRight = 60;
  const topPad = 40;
  const totalHeight = entries.length * itemHeight + topPad + 60;
  const totalWidth = 900;

  let svgItems = "";
  let yPositions = [];

  parsed.forEach((entry, i) => {
    const y = topPad + i * itemHeight + 60;
    yPositions.push(y);
    const color = colors[i % colors.length];
    const dateStr = entry.date
      ? entry.date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
      : "Ongoing";

    svgItems += `
      <!-- Connector line -->
      ${i < parsed.length - 1 ? `<line x1="${marginLeft}" y1="${y}" x2="${marginLeft}" y2="${y + itemHeight}" stroke="#d1d5db" stroke-width="3" stroke-dasharray="6,4"/>` : ""}

      <!-- Node -->
      <circle cx="${marginLeft}" cy="${y}" r="12" fill="${color}" stroke="#fff" stroke-width="3">
        <title>${dateStr}</title>
      </circle>

      <!-- Date label (left) -->
      <text x="${marginLeft - 20}" y="${y - 18}" text-anchor="end" font-size="13" font-weight="700" fill="${color}">${dateStr}</text>

      <!-- Content card (right) -->
      <rect x="${marginLeft + 28}" y="${y - 28}" width="${totalWidth - marginLeft - marginRight - 28}" height="80" rx="8" fill="#ffffff" stroke="${color}" stroke-width="1.5" opacity="0.95"/>
      <text x="${marginLeft + 44}" y="${y - 4}" font-size="13" font-weight="600" fill="#1a1d28">
        ${wrapText(entry.title, 55)}
      </text>
      <text x="${marginLeft + 44}" y="${y + 16}" font-size="11" fill="#6b7280">
        ${wrapText(entry.content, 100, 2)}
      </text>

      <!-- Category badge -->
      <rect x="${marginLeft + 28}" y="${y - 40}" width="14" height="14" rx="7" fill="${color}"/>
    `;
  });

  const svg = `
    <div class="timeline-svg-wrapper">
      <svg viewBox="0 0 ${totalWidth} ${totalHeight}" class="timeline-svg" style="width:100%;max-width:${totalWidth}px;height:auto;">
        <defs>
          <filter id="timelineShadow"><feDropShadow dx="0" dy="1" stdDeviation="2" flood-opacity="0.08"/></filter>
        </defs>
        ${svgItems}
      </svg>
    </div>`;

  container.innerHTML = svg;
}

function wrapText(text, maxChars, maxLines = 2) {
  if (!text) return "";
  if (text.length <= maxChars) return escapeXml(text);
  const lines = [];
  let remaining = text;
  for (let i = 0; i < maxLines; i++) {
    if (remaining.length <= maxChars) {
      lines.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < 0 || cut < maxChars / 2) cut = maxChars;
    lines.push(remaining.substring(0, cut));
    remaining = remaining.substring(cut).trim();
  }
  const result = lines.join("\n");
  return escapeXml(result) + (remaining.length > 0 ? "…" : "");
}

function escapeXml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ===== Spider-Web Competitor Diagram =====
let spiderData = null;
const spiderViewState = {
  scale: 1,
  x: 0,
  y: 0,
  hiddenSectors: new Set(),
  showPeerLinks: false,
  controlsReady: false,
  pinnedNodeId: null
};

async function loadSpiderWeb() {
  const container = document.getElementById("spiderContainerSection");
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Building competitor network...</p></div>';

  try {
    if (!spiderData) {
      const res = await fetch(`${API_BASE}/network`);
      const result = await res.json();
      if (!result.success) throw new Error(result.error || "Failed to load network data");
      spiderData = result.data;
    }

    setupSpiderControls();
    renderSpiderLegend(spiderData);
    renderSpiderDiagram(spiderData, container);
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">&#x26A0;</div><p>Error: ${err.message}</p></div>`;
  }
}

function setupSpiderControls() {
  if (spiderViewState.controlsReady) return;
  spiderViewState.controlsReady = true;

  document.getElementById("spiderZoomIn").addEventListener("click", () => changeSpiderZoom(1.2));
  document.getElementById("spiderZoomOut").addEventListener("click", () => changeSpiderZoom(1 / 1.2));
  document.getElementById("spiderResetView").addEventListener("click", resetSpiderView);
  document.getElementById("spiderShowAll").addEventListener("click", () => {
    spiderViewState.hiddenSectors.clear();
    renderSpiderLegend(spiderData);
    renderSpiderDiagram(spiderData, document.getElementById("spiderContainerSection"));
  });
  document.getElementById("spiderPeerToggle").addEventListener("change", event => {
    spiderViewState.showPeerLinks = event.target.checked;
    renderSpiderDiagram(spiderData, document.getElementById("spiderContainerSection"));
  });
}

function changeSpiderZoom(multiplier) {
  spiderViewState.scale = Math.min(2.6, Math.max(0.5, spiderViewState.scale * multiplier));
  applySpiderTransform();
}

function resetSpiderView() {
  spiderViewState.scale = 1;
  spiderViewState.x = 0;
  spiderViewState.y = 0;
  applySpiderTransform();
}

function applySpiderTransform() {
  const svg = document.querySelector("#spiderContainerSection .spider-svg");
  const viewport = svg?.querySelector(".spider-viewport");
  if (!svg || !viewport) return;
  const cx = Number(svg.dataset.cx);
  const cy = Number(svg.dataset.cy);
  viewport.setAttribute(
    "transform",
    `translate(${cx + spiderViewState.x} ${cy + spiderViewState.y}) scale(${spiderViewState.scale}) translate(${-cx} ${-cy})`
  );
  document.getElementById("spiderZoomLevel").textContent = `${Math.round(spiderViewState.scale * 100)}%`;
}

function renderSpiderLegend(data) {
  const legend = document.getElementById("spiderLegend");
  legend.innerHTML = Object.entries(data.sectorColors).map(([key, sector]) => {
    const count = data.competitors.filter(comp => comp.sectors[0] === key).length;
    const visible = !spiderViewState.hiddenSectors.has(key);
    return `<button class="spider-legend-item ${visible ? "active" : "inactive"}" type="button" data-sector="${key}" aria-pressed="${visible}">
      <span class="legend-dot" style="background:${sector.color}"></span>
      <span>${sector.label}</span>
      <small>${count}</small>
    </button>`;
  }).join("");

  legend.querySelectorAll(".spider-legend-item").forEach(button => {
    button.addEventListener("click", () => {
      const sector = button.dataset.sector;
      if (spiderViewState.hiddenSectors.has(sector)) spiderViewState.hiddenSectors.delete(sector);
      else spiderViewState.hiddenSectors.add(sector);
      renderSpiderLegend(data);
      renderSpiderDiagram(data, document.getElementById("spiderContainerSection"));
    });
  });
}

function buildSpiderLabel(name, x, y, isCenter) {
  const words = name.split(/\s+/);
  const lines = [];
  let line = "";
  const maxChars = isCenter ? 18 : 17;
  words.forEach(word => {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  });
  if (line) lines.push(line);
  const visibleLines = lines.slice(0, 2);
  if (lines.length > 2) visibleLines[1] += "…";
  return `<text x="${x}" y="${y}" text-anchor="middle" font-size="${isCenter ? 15 : 11}" font-weight="${isCenter ? 700 : 600}" fill="${isCenter ? "#1a1d28" : "#374151"}" class="spider-label">
    ${visibleLines.map((text, index) => `<tspan x="${x}" dy="${index === 0 ? 0 : 14}">${escapeXml(text)}</tspan>`).join("")}
  </text>`;
}

function renderSpiderDiagram(data, container) {
  const sectorColors = data.sectorColors;
  const centerNode = data.center;
  const sectorOrder = Object.keys(sectorColors);
  const visibleCompetitors = data.competitors.filter(comp => !spiderViewState.hiddenSectors.has(comp.sectors[0]));
  const allNodes = [centerNode, ...visibleCompetitors];

  // Large three-ring layout with sector groups kept in contiguous angular bands.
  const svgW = 1600;
  const svgH = 1400;
  const cx = 800;
  const cy = 700;
  const radii = [260, 455, 650];
  const sorted = [...visibleCompetitors].sort((a, b) => {
    const sectorDifference = sectorOrder.indexOf(a.sectors[0]) - sectorOrder.indexOf(b.sectors[0]);
    return sectorDifference || a.name.localeCompare(b.name);
  });
  const positions = { [centerNode.id]: { x: cx, y: cy, ring: 0, angle: 0 } };
  const total = Math.max(sorted.length, 1);

  sorted.forEach((comp, index) => {
    const ringIndex = index % radii.length;
    const angle = (index / total) * Math.PI * 2 - Math.PI / 2 + ringIndex * 0.025;
    const radius = radii[ringIndex];
    positions[comp.id] = {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
      ring: ringIndex + 1,
      angle
    };
  });

  // One centre connection per company keeps the default view readable.
  const centerEdges = visibleCompetitors.map(comp => {
    const sector = comp.sectors[0];
    return {
      from: centerNode.id,
      to: comp.id,
      sector,
      color: sectorColors[sector]?.color || "#94a3b8",
      peer: false
    };
  });

  const peerEdges = [];
  if (spiderViewState.showPeerLinks) {
    for (let i = 0; i < visibleCompetitors.length; i++) {
      for (let j = i + 1; j < visibleCompetitors.length; j++) {
        const first = visibleCompetitors[i];
        const second = visibleCompetitors[j];
        const sharedSector = first.sectors.find(sector => second.sectors.includes(sector));
        if (!sharedSector) continue;
        peerEdges.push({
          from: first.id,
          to: second.id,
          sector: sharedSector,
          color: sectorColors[sharedSector]?.color || "#94a3b8",
          peer: true
        });
      }
    }
  }
  const finalEdges = [...centerEdges, ...peerEdges.slice(0, 45)];
  const svgParts = [];

  radii.forEach(radius => {
    svgParts.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="#dbe2ea" stroke-width="1.2" stroke-dasharray="5,8" opacity="0.8"/>`);
  });

  finalEdges.forEach(edge => {
    const from = positions[edge.from];
    const to = positions[edge.to];
    if (!from || !to) return;
    svgParts.push(`<line x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" class="spider-edge ${edge.peer ? "peer" : "centre-edge"}" data-sector="${edge.sector}" stroke="${edge.color}" stroke-width="${edge.peer ? 1 : 1.6}" stroke-opacity="${edge.peer ? 0.18 : 0.42}" stroke-dasharray="${edge.peer ? "5,5" : ""}"/>`);
  });

  allNodes.forEach(node => {
    const pos = positions[node.id];
    if (!pos) return;
    const isCenter = node.id === centerNode.id;
    const primarySector = node.sectors[0];
    const sector = sectorColors[primarySector] || { color: "#64748b" };
    const radius = isCenter ? 34 : node.sectors.length >= 3 ? 21 : node.sectors.length >= 2 ? 18 : 16;
    const nodeParts = [];

    if (!isCenter && node.sectors.length > 1) {
      const ringColors = node.sectors.map(item => sectorColors[item]?.color || "#94a3b8");
      const circumference = 2 * Math.PI * (radius + 4);
      const segment = circumference / ringColors.length;
      ringColors.forEach((color, colorIndex) => {
        nodeParts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${radius + 4}" fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="${segment} ${circumference - segment}" stroke-dashoffset="${-colorIndex * segment}" opacity="0.85"/>`);
      });
    }

    nodeParts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${radius}" fill="${sector.color}" stroke="#fff" stroke-width="3" class="spider-node" style="filter:url(#nodeShadow)">
      <title>${escapeXml(node.name)}${node.description ? `\n\n${escapeXml(node.description)}` : ""}</title>
    </circle>`);
    nodeParts.push(buildSpiderLabel(node.name, pos.x, isCenter ? pos.y + 54 : pos.y + radius + 20, isCenter));
    svgParts.push(`<g class="spider-node-group" data-id="${node.id}" data-sector="${primarySector}" tabindex="0" role="button" aria-label="${escapeXml(node.name)}">${nodeParts.join("")}</g>`);
  });

  svgParts.push(`<text x="${cx}" y="${cy - 48}" text-anchor="middle" font-size="11" fill="#6b7280" letter-spacing="1.5">CENTRE</text>`);

  container.innerHTML = `<div class="spider-svg-container">
    <svg viewBox="0 0 ${svgW} ${svgH}" class="spider-svg" data-cx="${cx}" data-cy="${cy}" aria-label="Interactive competitor technology network">
      <defs><filter id="nodeShadow"><feDropShadow dx="0" dy="2" stdDeviation="3" flood-opacity="0.18"/></filter></defs>
      <rect width="${svgW}" height="${svgH}" fill="#fafbfc" rx="12"/>
      <g class="spider-viewport">${svgParts.join("\n")}</g>
    </svg>
  </div>`;

  const svg = container.querySelector(".spider-svg");
  applySpiderTransform();

  container.querySelectorAll(".spider-node-group").forEach(group => {
    group.addEventListener("mouseenter", () => showSpiderDetail(group.dataset.id));
    group.addEventListener("mouseleave", () => {
      if (spiderViewState.pinnedNodeId === group.dataset.id) return;
      hideSpiderDetail();
    });
    group.addEventListener("focus", () => showSpiderDetail(group.dataset.id));
    group.addEventListener("blur", () => {
      if (spiderViewState.pinnedNodeId === group.dataset.id) return;
      hideSpiderDetail();
    });
    group.addEventListener("click", (event) => {
      event.stopPropagation();
      toggleSpiderPin(group.dataset.id);
    });
    group.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggleSpiderPin(group.dataset.id);
      }
    });
  });

  svg.addEventListener("wheel", event => {
    event.preventDefault();
    changeSpiderZoom(event.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });

  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  svg.addEventListener("pointerdown", event => {
    if (event.target.closest(".spider-node-group")) return;
    unpinSpiderNode();
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    svg.classList.add("is-panning");
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", event => {
    if (!dragging) return;
    const rect = svg.getBoundingClientRect();
    const viewBoxWidth = svg.viewBox.baseVal.width;
    const viewBoxHeight = svg.viewBox.baseVal.height;
    spiderViewState.x += (event.clientX - lastX) * viewBoxWidth / rect.width;
    spiderViewState.y += (event.clientY - lastY) * viewBoxHeight / rect.height;
    lastX = event.clientX;
    lastY = event.clientY;
    applySpiderTransform();
  });
  const stopDragging = event => {
    if (!dragging) return;
    dragging = false;
    svg.classList.remove("is-panning");
    if (svg.hasPointerCapture(event.pointerId)) svg.releasePointerCapture(event.pointerId);
  };
  svg.addEventListener("pointerup", stopDragging);
  svg.addEventListener("pointercancel", stopDragging);
}

function showSpiderDetail(nodeId) {
  if (!spiderData) return;
  const allNodes = [spiderData.center, ...spiderData.competitors];
  const node = allNodes.find(n => n.id === nodeId);
  if (!node) return;

  const detail = document.getElementById("spiderDetail");
  const nameEl = document.getElementById("spiderDetailName");
  const sectorsEl = document.getElementById("spiderDetailSectors");

  nameEl.textContent = node.name;
  let html = node.sectors.map(s => {
    const sc = spiderData.sectorColors[s];
    return `<span class="spider-sector-tag" style="background:${sc?.bg || '#f1f5f9'};color:${sc?.color || '#64748b'}">${sc?.label || s}</span>`;
  }).join("");

  // Add description if available
  if (node.description) {
    html += `<p class="spider-description">${node.description}</p>`;
  }

  // Add evidence-backed game use cases where available
  if (node.useCases && node.useCases.length) {
    html += `<div class="spider-use-cases">
      <strong>Current game uses</strong>
      ${node.useCases.map(item => `
        <a href="${item.source}" target="_blank" rel="noopener">
          <span>${item.game}</span>
          <small>${item.use}</small>
        </a>
      `).join("")}
    </div>`;
  }

  // Add source link if available
  if (node.url) {
    const domain = new URL(node.url).hostname.replace(/^www\./, "");
    html += `<a href="${node.url}" target="_blank" rel="noopener" class="spider-detail-link">&#x1F517; ${domain}</a>`;
  }

  sectorsEl.innerHTML = html;
  detail.style.display = "block";

  // Visual pin indicator
  const allGroups = document.querySelectorAll(".spider-node-group");
  allGroups.forEach(g => g.classList.toggle("is-pinned", g.dataset.id === spiderViewState.pinnedNodeId));
}

function hideSpiderDetail() {
  if (spiderViewState.pinnedNodeId) return; // Don't hide if pinned
  document.getElementById("spiderDetail").style.display = "none";
}

function toggleSpiderPin(nodeId) {
  if (spiderViewState.pinnedNodeId === nodeId) {
    // Clicking the same node again — unpin
    unpinSpiderNode();
  } else {
    // Pin this node
    spiderViewState.pinnedNodeId = nodeId;
    showSpiderDetail(nodeId);
  }
}

function unpinSpiderNode() {
  spiderViewState.pinnedNodeId = null;
  document.querySelectorAll(".spider-node-group.is-pinned").forEach(g => g.classList.remove("is-pinned"));
  document.getElementById("spiderDetail").style.display = "none";
}

// Close button handler
document.addEventListener("DOMContentLoaded", () => {
  const closeBtn = document.getElementById("spiderDetailClose");
  if (closeBtn) {
    closeBtn.addEventListener("click", () => { unpinSpiderNode(); hideSpiderDetail(); });
  }
});

// ===== Company Map =====
async function loadCompanyMap() {
  const container = document.getElementById("companyMapContainer");
  const statsRow = document.getElementById("mapStatsRow");
  const legend = document.getElementById("mapLegend");

  if (!container) return;

  // Show loading
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading map...</p></div>';

  // Load Tencent Maps SDK
  loadTencentMapSDK();

  try {
    const res = await fetch("/api/company-locations");
    const json = await res.json();
    if (!json.success) throw new Error("Failed to load location data");
    const data = json.data;
    const companies = data.companies;

    // Stats
    const regionCounts = Object.fromEntries(
      Object.keys(data.regions).map(regionId => [regionId, companies.filter(c => c.region === regionId).length])
    );
    statsRow.innerHTML = `
      <div class="map-stat">
        <span class="map-stat-value">${companies.length}</span>
        <span class="map-stat-label">Relevant Locations</span>
      </div>
      ${Object.entries(data.regions).map(([regionId, region]) => `
        <div class="map-stat" style="border-top:3px solid ${region.color}">
          <span class="map-stat-value" style="color:${region.color}">${regionCounts[regionId]}</span>
          <span class="map-stat-label">${region.label}</span>
        </div>
      `).join("")}
    `;

    // Legend
    legend.innerHTML = Object.entries(data.regions).map(([regionId, region]) => `
      <div class="map-legend-item" data-region="${regionId}">
        <span class="map-legend-dot" style="background:${region.color}"></span>
        ${region.label}
      </div>
    `).join("");

    // Build the map
    renderCompanyMap(companies, data.regions);
  } catch (err) {
    container.innerHTML = `<div class="error-state"><p>Failed to load map: ${err.message}</p></div>`;
  }
}

function renderCompanyMap(companies, regions) {
  const container = document.getElementById("companyMapContainer");

  // Compute bounds
  const lats = companies.map(c => c.lat);
  const lons = companies.map(c => c.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;

  // Adjust zoom based on spread
  const latSpan = maxLat - minLat;
  const lonSpan = maxLon - minLon;
  const maxSpan = Math.max(latSpan, lonSpan, 10);
  let zoom = Math.floor(Math.log2(360 / maxSpan)) + 1;
  zoom = Math.min(Math.max(zoom, 2), 10);

  container.innerHTML = '<div id="tencentMap" style="width:100%;height:580px;border-radius:12px;"></div>';

  // Tencent Maps GL JS — default proxy mode
  const mapEl = document.getElementById("tencentMap");
  if (!mapEl || typeof TMap === "undefined") {
    // Wait for SDK to load, then init
    const checkTMap = setInterval(() => {
      if (typeof TMap !== "undefined") {
        clearInterval(checkTMap);
        initMap(companies, regions, centerLat, centerLon, zoom);
      }
    }, 200);
    // Timeout after 10s
    setTimeout(() => { clearInterval(checkTMap); }, 10000);
  } else {
    initMap(companies, regions, centerLat, centerLon, zoom);
  }
}

function initMap(companies, regions, centerLat, centerLon, zoom) {
  const map = new TMap.Map("tencentMap", {
    zoom: zoom,
    center: new TMap.LatLng(centerLat, centerLon),
  });

  const markerStyles = Object.fromEntries(
    Object.entries(regions).map(([regionId, region]) => [
      `${regionId}Marker`,
      new TMap.MarkerStyle({
        width: 18,
        height: 24,
        anchor: { x: 9, y: 24 },
        src: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 18 24"><path d="M9 0C4.03 0 0 4.03 0 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z" fill="${region.color}"/><circle cx="9" cy="9" r="3" fill="white"/></svg>`)}`
      })
    ])
  );

  // Create markers and spread pins sharing a city so they remain selectable.
  const markerGeometries = companies.map(c => {
    let latOffset = 0;
    let lonOffset = 0;
    const cityCompanies = companies.filter(company => company.city === c.city);
    if (cityCompanies.length > 1) {
      const cityIndex = cityCompanies.indexOf(c);
      const angle = (cityIndex / cityCompanies.length) * Math.PI * 2;
      latOffset = Math.cos(angle) * 0.015;
      lonOffset = Math.sin(angle) * 0.015;
    }

    return {
      id: c.id,
      styleId: `${c.region}Marker`,
      position: new TMap.LatLng(c.lat + latOffset, c.lon + lonOffset),
      properties: {
        name: c.name,
        city: c.city,
        country: c.country,
        regionId: c.region,
        sector: c.sector,
        description: c.description,
        officeFunction: c.officeFunction || "Relevant development, research or regulatory location.",
        relevantProducts: c.relevantProducts || [],
        sources: c.sources || [],
        url: c.url
      }
    };
  });

  const markers = new TMap.MultiMarker({
    map: map,
    styles: markerStyles,
    geometries: markerGeometries
  });

  const infoWindow = new TMap.InfoWindow({
    map: map,
    position: new TMap.LatLng(0, 0),
    enableCustom: true,
    offset: { x: 0, y: -30 },
  });
  let infoPinned = false;
  let suppressMapCloseUntil = 0;
  infoWindow.close();

  function renderMapInfo(props, detailed = false) {
    const region = regions[props.regionId] || { label: props.regionId.toUpperCase(), color: "#64748b" };
    const productLimit = detailed ? props.relevantProducts.length : Math.min(props.relevantProducts.length, 2);
    const products = props.relevantProducts.slice(0, productLimit);
    return `
      <div class="map-info-window ${detailed ? "map-info-detailed" : "map-info-preview"}">
        <div class="map-info-header">
          <span class="map-info-region" style="background:${region.color}">${region.label}</span>
          <strong>${props.name}</strong>
        </div>
        <div class="map-info-location">${props.city}, ${props.country} &middot; ${props.sector}</div>
        <p class="map-info-desc">${props.description}</p>
        <div class="map-info-function"><strong>Location role</strong><span>${props.officeFunction}</span></div>
        ${products.length ? `
          <div class="map-info-section">
            <strong>Relevant games &amp; products</strong>
            <ul class="map-info-items">${products.map(product => `<li>${product}</li>`).join("")}</ul>
          </div>
        ` : ""}
        ${!detailed && props.relevantProducts.length > productLimit ? `<div class="map-info-more">Click this marker to show ${props.relevantProducts.length - productLimit} more item${props.relevantProducts.length - productLimit === 1 ? "" : "s"} and sources</div>` : ""}
        ${detailed ? `
          <div class="map-info-actions">
            ${props.url ? `<a class="map-info-link" href="${props.url}" target="_blank" rel="noopener">Company website &#8599;</a>` : ""}
            ${props.sources.map(source => `<a class="map-info-source" href="${source.url}" target="_blank" rel="noopener">${source.label} &#8599;</a>`).join("")}
          </div>
        ` : ""}
      </div>
    `;
  }

  // Hover gives a concise preview including the function of this specific office.
  markers.on("hover", e => {
    if (!e.geometry || infoPinned) return;
    infoWindow.setPosition(e.geometry.position);
    infoWindow.setContent(renderMapInfo(e.geometry.properties));
    infoWindow.open();
  });

  markers.on("mouseout", () => {
    if (!infoPinned) infoWindow.close();
  });

  // Click pins the complete office role, products and audit sources.
  markers.on("click", e => {
    if (!e.geometry) return;
    infoPinned = true;
    // Tencent Maps also emits a map click for a marker click. Briefly suppress
    // the map-close handler so the detailed content remains visible.
    suppressMapCloseUntil = Date.now() + 250;
    infoWindow.setPosition(e.geometry.position);
    infoWindow.setContent(renderMapInfo(e.geometry.properties, true));
    infoWindow.open();
  });

  map.on("click", () => {
    if (Date.now() < suppressMapCloseUntil) return;
    infoPinned = false;
    infoWindow.close();
  });
}

// Load Tencent Maps SDK dynamically
function loadTencentMapSDK() {
  if (document.getElementById("tmap-script")) return;
  const script = document.createElement("script");
  script.id = "tmap-script";
  script.src = "https://map.qq.com/api/gljs?v=1.exp&libraries=service";
  document.head.appendChild(script);
}

// ===== Utilities =====
function truncateText(text, maxLen) {
  if (text.length <= maxLen) return text;
  return text.substring(0, maxLen) + "\n\n... [content truncated]";
}

// ===== Tencent Products Spider-Web =====
let tencentProductsData = null;

async function loadTencentProducts() {
  const container = document.getElementById("tencentProductsContainerSection");
  const loading = document.getElementById("tencentProductsLoading");

  if (tencentProductsData) {
    renderTencentProducts();
    return;
  }

  loading.style.display = "flex";
  try {
    const res = await fetch(`${API_BASE}/tencent-products`);
    const json = await res.json();
    if (json.success) {
      tencentProductsData = json.data;
      renderTencentProducts();
    }
  } catch (err) {
    container.innerHTML = `<div class="empty-state"><p>Failed to load: ${err.message}</p></div>`;
  }
}

function splitTencentProductName(name, maxChars = 13) {
  const words = name.trim().split(/\s+/);
  const lines = [];
  let currentLine = "";

  words.forEach(word => {
    const candidate = currentLine ? `${currentLine} ${word}` : word;
    if (candidate.length <= maxChars) {
      currentLine = candidate;
      return;
    }
    if (currentLine) lines.push(currentLine);
    if (word.length <= maxChars) {
      currentLine = word;
      return;
    }

    // Prefer a natural hyphen break before splitting an unspaced product name.
    const hyphenBreak = word.lastIndexOf("-", maxChars - 1);
    if (hyphenBreak > 0) {
      lines.push(word.slice(0, hyphenBreak + 1));
      currentLine = word.slice(hyphenBreak + 1);
      return;
    }

    for (let index = 0; index < word.length; index += maxChars) {
      const chunk = word.slice(index, index + maxChars);
      if (chunk.length === maxChars || index + maxChars < word.length) lines.push(chunk);
      else currentLine = chunk;
    }
  });

  if (currentLine) lines.push(currentLine);
  return lines;
}

function renderTencentProducts() {
  const container = document.getElementById("tencentProductsContainerSection");
  const loading = document.getElementById("tencentProductsLoading");
  if (loading) loading.style.display = "none";

  const data = tencentProductsData;
  if (!data || !data.products) return;

  // Build legend
  const legend = document.getElementById("tencentProductsLegend");
  legend.innerHTML = `<div class="tp-legend-grid">${data.sectors.map(s =>
    `<div class="tp-legend-item"><span class="tp-legend-dot" style="background:${s.color}"></span>${s.label}</div>`
  ).join("")}</div>`;

  // Layout products in a radial layout
  const products = data.products;
  const sectorMap = {};
  data.sectors.forEach(s => { sectorMap[s.id] = s; });

  const cx = 620, cy = 580, centerR = 62;
  const svgWidth = 1240, svgHeight = 1160;

  // Assign products to rings based on sector count
  let ring0 = [], ring1 = [], ring2 = [];
  products.forEach(p => {
    if (p.sectors.length >= 3) ring0.push(p);
    else if (p.sectors.length >= 2) ring1.push(p);
    else ring2.push(p);
  });

  const rings = [ring0, ring1, ring2];
  const radii = [215, 370, 515];

  // Build a larger SVG so every product node can contain its complete name.
  let svg = `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg" class="tp-products-svg" style="width:100%;height:auto;max-width:1160px;">`;

  // Draw concentric rings
  radii.forEach((r, i) => {
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--border)" stroke-width="1" stroke-dasharray="6,4" opacity="${0.5 - i*0.15}"/>`;
  });

  // Tencent centre is appended after edges so its label stays unobstructed.
  let centerSvg = `<circle cx="${cx}" cy="${cy}" r="${centerR}" fill="#1e3a5f" stroke="#2563eb" stroke-width="4"/>`;
  centerSvg += `<text x="${cx}" y="${cy-7}" text-anchor="middle" fill="#fff" font-size="17" font-weight="700" font-family="system-ui">Tencent</text>`;
  centerSvg += `<text x="${cx}" y="${cy+16}" text-anchor="middle" fill="#93c5fd" font-size="12" font-family="system-ui">AI &amp; Gaming</text>`;

  // Compute and draw product nodes after edges so labels remain unobstructed.
  const allNodes = [];
  let nodeSvg = "";
  rings.forEach((ring, ringIdx) => {
    const r = radii[ringIdx];
    ring.forEach((p, i) => {
      const angle = (i / ring.length) * 2 * Math.PI - Math.PI/2 + ringIdx * 0.045;
      const nx = cx + r * Math.cos(angle);
      const ny = cy + r * Math.sin(angle);
      const labelLines = splitTencentProductName(p.name);
      const nodeR = labelLines.length >= 3 ? 56 : 49;
      allNodes.push({ ...p, nx, ny, r: nodeR });

      // Multi-sector ring
      const primaryColor = sectorMap[p.sectors[0]]?.color || "#6366f1";
      if (p.sectors.length > 1) {
        const segAngle = (2*Math.PI) / p.sectors.length;
        p.sectors.forEach((sid, si) => {
          const sc = sectorMap[sid];
          const a1 = si * segAngle - Math.PI/2;
          const a2 = (si+1) * segAngle - Math.PI/2;
          const x1 = nx + nodeR * Math.cos(a1);
          const y1 = ny + nodeR * Math.sin(a1);
          const x2 = nx + nodeR * Math.cos(a2);
          const y2 = ny + nodeR * Math.sin(a2);
          const large = segAngle > Math.PI ? 1 : 0;
          nodeSvg += `<path d="M${nx},${ny} L${x1},${y1} A${nodeR},${nodeR} 0 ${large},1 ${x2},${y2} Z" fill="${sc?.color || primaryColor}" opacity="0.9"/>`;
        });
        nodeSvg += `<circle cx="${nx}" cy="${ny}" r="${nodeR}" fill="none" stroke="#fff" stroke-width="2" opacity="0.65"/>`;
      } else {
        nodeSvg += `<circle cx="${nx}" cy="${ny}" r="${nodeR}" fill="${primaryColor}" opacity="0.9" stroke="#fff" stroke-width="2"/>`;
      }

      // Complete product title, wrapped and vertically centred inside the node.
      const lineHeight = 12;
      const labelStartY = ny - ((labelLines.length - 1) * lineHeight) / 2 + 3;
      nodeSvg += `<text x="${nx}" y="${labelStartY}" text-anchor="middle" fill="#fff" font-size="10" font-weight="650" font-family="system-ui" pointer-events="none" class="tp-node-label">${labelLines.map((line, lineIndex) => `<tspan x="${nx}" dy="${lineIndex === 0 ? 0 : lineHeight}">${escapeXml(line)}</tspan>`).join("")}</text>`;

      // Invisible hit area matching the larger node.
      nodeSvg += `<circle cx="${nx}" cy="${ny}" r="${nodeR+5}" fill="transparent" class="tp-node-hit" data-id="${p.id}" style="cursor:pointer">
        <title>${p.name}
${p.sectors.map(s => '• ' + (sectorMap[s]?.label || s)).join('\n')}
${p.description}</title>
      </circle>`;
    });
  });

  // Draw edges behind the nodes so they never cross product titles.
  allNodes.forEach(n => {
    svg += `<line x1="${cx}" y1="${cy}" x2="${n.nx}" y2="${n.ny}" stroke="${sectorMap[n.sectors[0]]?.color || '#94a3b8'}" stroke-width="1" opacity="0.22"/>`;
  });
  svg += nodeSvg;
  svg += centerSvg;

  svg += `</svg>`;
  container.innerHTML = svg;

  // Click handlers
  container.querySelectorAll(".tp-node-hit").forEach(el => {
    el.addEventListener("click", () => showTencentProductDetail(el.dataset.id));
  });

  // Detail close
  document.getElementById("tencentProductsDetailClose").addEventListener("click", () => {
    document.getElementById("tencentProductsDetail").style.display = "none";
  });
}

function showTencentProductDetail(productId) {
  const data = tencentProductsData;
  if (!data) return;
  const p = data.products.find(p => p.id === productId);
  if (!p) return;

  const sectorMap = {};
  data.sectors.forEach(s => { sectorMap[s.id] = s; });

  const detail = document.getElementById("tencentProductsDetail");
  document.getElementById("tencentProductsDetailName").textContent = p.name;
  document.getElementById("tencentProductsDetailSectors").innerHTML = p.sectors.map(s => {
    const sc = sectorMap[s];
    return `<span class="spider-sector-tag" style="background:${sc?.bg || '#f1f5f9'};color:${sc?.color || '#64748b'}">${sc?.label || s}</span>`;
  }).join("");
  document.getElementById("tencentProductsDetailDesc").textContent = p.description;
  const linkEl = document.getElementById("tencentProductsDetailLink");
  if (p.url) {
    linkEl.href = p.url;
    linkEl.style.display = "inline-block";
  } else {
    linkEl.style.display = "none";
  }
  detail.style.display = "block";
}

// ===== Current AI Use Cases =====
let currentUseCasesData = null;
let currentUseCasesFiltersReady = false;

async function loadCurrentUseCases() {
  const grid = document.getElementById("useCaseGrid");
  if (currentUseCasesData) {
    renderCurrentUseCases();
    return;
  }

  if (grid) {
    grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading current use cases...</p></div>';
  }

  try {
    const res = await fetch(`${API_BASE}/current-use-cases`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error || "Unable to load use cases");
    currentUseCasesData = json.data;
    populateCurrentUseCaseFilters();
    setupCurrentUseCaseFilters();
    renderCurrentUseCases();
  } catch (err) {
    if (grid) {
      grid.innerHTML = `<div class="empty-state"><div class="empty-icon">&#x26A0;</div><p>Failed to load: ${err.message}</p></div>`;
    }
  }
}

function populateCurrentUseCaseFilters() {
  if (!currentUseCasesData) return;
  const games = currentUseCasesData.games || [];
  const classSelect = document.getElementById("useCaseClassFilter");
  const categorySelect = document.getElementById("useCaseCategoryFilter");
  const classes = [...new Set(games.map(game => game.aiClass))].sort();
  const categories = [...new Set(games.flatMap(game => game.categories || []))].sort();

  classSelect.innerHTML = '<option value="all">All AI classes</option>' +
    classes.map(value => `<option value="${value}">${value}</option>`).join("");
  categorySelect.innerHTML = '<option value="all">All categories</option>' +
    categories.map(value => `<option value="${value}">${value}</option>`).join("");
}

function setupCurrentUseCaseFilters() {
  if (currentUseCasesFiltersReady) return;
  currentUseCasesFiltersReady = true;
  ["useCaseSearch", "useCaseClassFilter", "useCaseCategoryFilter"].forEach(id => {
    const element = document.getElementById(id);
    const eventName = element.tagName === "INPUT" ? "input" : "change";
    element.addEventListener(eventName, renderCurrentUseCaseCatalogue);
  });
}

function renderCurrentUseCases() {
  if (!currentUseCasesData) return;
  const games = currentUseCasesData.games || [];
  document.getElementById("useCasesGameCount").textContent = games.length;
  document.getElementById("useCasesCompanyCount").textContent = new Set(games.map(game => game.developer)).size;
  document.getElementById("useCasesGenerativeCount").textContent = games.filter(game =>
    /machine learning|generative/i.test(game.aiClass)
  ).length;

  const patterns = document.getElementById("useCasePatternsSection");
  patterns.innerHTML = `
    <div class="use-case-section-heading">
      <div>
        <span class="use-case-eyebrow">Evidence synthesis</span>
        <h2>Cross-Game Patterns</h2>
      </div>
      <p>${currentUseCasesData.methodology}</p>
    </div>
    <div class="use-case-pattern-grid">
      ${currentUseCasesData.patterns.map(pattern => `
        <article class="use-case-pattern-card">
          <h3>${pattern.title}</h3>
          <p>${pattern.content}</p>
          <div class="use-case-pattern-games">
            ${pattern.games.map(game => `<span>${game}</span>`).join("")}
          </div>
        </article>
      `).join("")}
    </div>
  `;

  renderCurrentUseCaseCatalogue();
}

function renderCurrentUseCaseCatalogue() {
  if (!currentUseCasesData) return;
  const query = document.getElementById("useCaseSearch").value.trim().toLowerCase();
  const classFilter = document.getElementById("useCaseClassFilter").value;
  const categoryFilter = document.getElementById("useCaseCategoryFilter").value;
  const games = currentUseCasesData.games.filter(game => {
    const haystack = [
      game.game,
      game.developer,
      game.publisher,
      game.aiClass,
      game.namedSystem,
      game.summary,
      game.details,
      ...(game.categories || [])
    ].join(" ").toLowerCase();
    const matchesQuery = !query || haystack.includes(query);
    const matchesClass = classFilter === "all" || game.aiClass === classFilter;
    const matchesCategory = categoryFilter === "all" || (game.categories || []).includes(categoryFilter);
    return matchesQuery && matchesClass && matchesCategory;
  });

  document.getElementById("useCaseResultCount").textContent = `${games.length} of ${currentUseCasesData.games.length} entries`;
  const grid = document.getElementById("useCaseGrid");
  if (!games.length) {
    grid.innerHTML = '<div class="empty-state"><p>No use cases match the selected filters.</p></div>';
    return;
  }

  grid.innerHTML = games.map(game => `
    <article class="use-case-card" data-use-case="${game.id}">
      <button class="use-case-card-header" type="button" aria-expanded="false">
        <div class="use-case-card-title-area">
          <div class="use-case-card-topline">
            <span class="use-case-class">${game.aiClass}</span>
            <span class="use-case-status">${game.releaseStatus}</span>
          </div>
          <h3>${game.game}</h3>
          <p class="use-case-developer">${game.developer} &middot; ${game.publisher}</p>
          <p class="use-case-summary">${game.summary}</p>
        </div>
        <span class="use-case-expand">&#x25BC;</span>
      </button>
      <div class="use-case-card-body">
        <div class="use-case-system">
          <span>Named system / technique</span>
          <strong>${game.namedSystem}</strong>
        </div>
        <p>${game.details}</p>
        <div class="use-case-tags">
          ${game.categories.map(category => `<span>${category}</span>`).join("")}
        </div>
        <div class="use-case-evidence-meta">
          <span><strong>Evidence:</strong> ${game.evidenceOrigin}</span>
        </div>
        <div class="use-case-sources">
          <h4>Supporting sources</h4>
          ${game.sources.map(source => `<a href="${source.url}" target="_blank" rel="noopener">${source.label}</a>`).join("")}
        </div>
      </div>
    </article>
  `).join("");

  grid.querySelectorAll(".use-case-card-header").forEach(button => {
    button.addEventListener("click", () => {
      const card = button.closest(".use-case-card");
      const isExpanded = card.classList.toggle("expanded");
      button.setAttribute("aria-expanded", String(isExpanded));
    });
  });
}

// ===== AI Gaming Trends =====
let gamingTrendsData = null;

async function loadGamingTrends() {
  const grid = document.getElementById("trendsGridSection");

  if (gamingTrendsData) {
    renderGamingTrends();
    return;
  }

  grid.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading AI gaming trends...</p></div>';

  try {
    const res = await fetch(`${API_BASE}/gaming-trends`);
    const json = await res.json();
    if (json.success) {
      gamingTrendsData = json.data;
      renderGamingTrends();
    }
  } catch (err) {
    grid.innerHTML = `<div class="empty-state"><div class="empty-icon">&#x26A0;</div><p>Failed to load: ${err.message}</p></div>`;
  }
}

function renderGamingTrends() {
  const data = gamingTrendsData;
  if (!data) return;

  // Render ecosystem context
  const ecosystem = document.getElementById("trendsEcosystemSection");
  if (ecosystem && data.ecosystemContext) {
    const ctx = data.ecosystemContext;
    ecosystem.innerHTML = `
      <h3>&#x1F30D; ${ctx.title}</h3>
      <div class="ecosystem-sections">
        ${ctx.sections.map(s => `
          <div class="ecosystem-card">
            <h4>${s.title}</h4>
            <p>${s.content}</p>
            ${s.sources && s.sources.length ? `
            <div class="trend-sources ecosystem-sources">
              ${s.sources.map(src => `<a href="${src.url}" target="_blank" rel="noopener" class="trend-source-link">${src.label}</a>`).join("")}
            </div>` : ""}
          </div>
        `).join("")}
      </div>`;
  }

  // Render evidence of current shipped and community-built AI implementations
  const currentUsesSection = document.getElementById("trendsCurrentUsesSection");
  if (currentUsesSection && data.currentUseEvidence) {
    const evidence = data.currentUseEvidence;
    currentUsesSection.innerHTML = `
      <div class="current-uses-header">
        <span class="use-case-eyebrow">Observed implementations</span>
        <h3>${evidence.title}</h3>
        <p>${evidence.description}</p>
      </div>
      <div class="current-uses-grid">
        ${evidence.sections.map(section => `
          <article class="current-use-evidence-card">
            <h4>${section.title}</h4>
            <p>${section.content}</p>
            <div class="current-use-game-tags">
              ${section.games.map(game => `<span>${game}</span>`).join("")}
            </div>
            <div class="trend-sources ecosystem-sources">
              ${section.sources.map(source => `<a href="${source.url}" target="_blank" rel="noopener" class="trend-source-link">${source.label}</a>`).join("")}
            </div>
          </article>
        `).join("")}
      </div>
    `;
  }

  // Render the game technology patent landscape from the supplied patent research
  const patentsSection = document.getElementById("trendsPatentsSection");
  if (patentsSection && data.patentLandscape) {
    const landscape = data.patentLandscape;
    const patentCount = landscape.companies.reduce((total, company) => total + company.patents.length, 0);
    patentsSection.innerHTML = `
      <div class="patents-section-header">
        <div>
          <span class="patents-eyebrow">Competitive IP intelligence</span>
          <h3>${landscape.title}</h3>
          <p>${landscape.description}</p>
        </div>
        <div class="patents-count">
          <strong>${patentCount}</strong>
          <span>patent signals</span>
        </div>
      </div>
      <div class="patent-company-list">
        ${landscape.companies.map(company => `
          <article class="patent-company-card">
            <div class="patent-company-header">
              <div>
                <h4>${company.name}</h4>
                <p>${company.summary}</p>
              </div>
              <span class="patent-company-count">${company.patents.length} entries</span>
            </div>
            <div class="patent-grid">
              ${company.patents.map(patent => `
                <div class="patent-card">
                  <a class="patent-number" href="${patent.url}" target="_blank" rel="noopener">${patent.number}</a>
                  <h5>${patent.title}</h5>
                  <p>${patent.description}</p>
                  <div class="patent-trend-tags">
                    ${patent.trendLinks.map(tag => `<span>${tag}</span>`).join("")}
                  </div>
                </div>
              `).join("")}
            </div>
            ${company.sources && company.sources.length ? `
              <div class="patent-sources">
                ${company.sources.map(source => `<a href="${source.url}" target="_blank" rel="noopener">${source.label}</a>`).join("")}
              </div>
            ` : ""}
          </article>
        `).join("")}
      </div>
      <p class="patents-source-note">${landscape.sourceNote}</p>
    `;
  }

  // Render trend cards
  const grid = document.getElementById("trendsGridSection");
  if (!data.trends || !data.trends.length) {
    grid.innerHTML = '<div class="empty-state"><p>No trends data available</p></div>';
    return;
  }

  grid.innerHTML = data.trends.map((trend, idx) => `
    <div class="trend-card" id="trend-${trend.id}">
      <div class="trend-card-header" data-trend="${trend.id}">
        <span class="trend-card-icon">${trend.icon}</span>
        <div class="trend-card-info">
          <div class="trend-card-title">${trend.shortTitle}</div>
          <div class="trend-card-summary">${trend.summary}</div>
          <div class="trend-card-meta">
            <span class="trend-card-category">${trend.category}</span>
            ${trend.knowledgeBaseRef ? `<span class="trend-kb-ref">KB: ${trend.knowledgeBaseRef}</span>` : ""}
          </div>
        </div>
        <span class="trend-card-expand">&#x25BC;</span>
      </div>
      <div class="trend-card-body">
        <p class="trend-detail">${trend.details}</p>
        <div class="trend-examples">
          <h4>Examples</h4>
          <ul>${trend.examples.map(e => `<li>${e}</li>`).join("")}</ul>
        </div>
        <div class="trend-companies">
          ${trend.companies.map(c => `<span class="trend-company-tag">${c}</span>`).join("")}
        </div>
        ${trend.sources && trend.sources.length ? `
        <div class="trend-sources">
          <h4>Sources</h4>
          ${trend.sources.map(s => `<a href="${s.url}" target="_blank" rel="noopener" class="trend-source-link">${s.label}</a>`).join("")}
        </div>` : ""}
        <div class="trend-card-actions">
          <button class="trend-search-btn" data-trend="${trend.id}" data-keywords="${encodeURIComponent(trend.searchKeywords)}">
            &#x1F50D; Search for latest
          </button>
        </div>
        <div class="trend-search-results" id="search-results-${trend.id}"></div>
        <div class="trend-search-status" id="search-status-${trend.id}" style="display:none;">
          <div class="spinner" style="width:14px;height:14px;border-width:2px;"></div>
          <span>Searching the web...</span>
        </div>
      </div>
    </div>
  `).join("");

  // Wire up expand/collapse
  grid.querySelectorAll(".trend-card-header").forEach(header => {
    header.addEventListener("click", () => {
      const card = header.parentElement;
      card.classList.toggle("expanded");
    });
  });

  // Wire up search buttons
  grid.querySelectorAll(".trend-search-btn").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const trendId = btn.dataset.trend;
      const keywords = decodeURIComponent(btn.dataset.keywords);

      // Expand the card if collapsed
      const card = document.getElementById(`trend-${trendId}`);
      if (card) card.classList.add("expanded");

      const resultsDiv = document.getElementById(`search-results-${trendId}`);
      const statusDiv = document.getElementById(`search-status-${trendId}`);

      btn.disabled = true;
      btn.textContent = "Searching...";
      resultsDiv.classList.remove("visible");
      resultsDiv.innerHTML = "";
      statusDiv.style.display = "flex";

      try {
        const res = await fetch(`${API_BASE}/gaming-trends/search`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords, limit: 5 }),
        });
        const json = await res.json();

        statusDiv.style.display = "none";
        btn.disabled = false;
        btn.innerHTML = "&#x1F50D; Search for latest";

        if (!json.success) {
          resultsDiv.innerHTML = `<p class="hint" style="margin-top:0.5rem;">Search failed: ${json.error}</p>`;
          resultsDiv.classList.add("visible");
          return;
        }

        const items = json.data || [];
        if (!items.length) {
          resultsDiv.innerHTML = '<p class="hint" style="margin-top:0.5rem;">No results found</p>';
          resultsDiv.classList.add("visible");
          return;
        }

        resultsDiv.innerHTML = items.map(item => `
          <div class="trend-search-result">
            <a href="${item.url || '#'}" target="_blank" rel="noopener">${item.title || "Untitled"}</a>
            <div class="result-snippet">${item.description || ""}</div>
          </div>
        `).join("");
        resultsDiv.classList.add("visible");
      } catch (err) {
        statusDiv.style.display = "none";
        btn.disabled = false;
        btn.innerHTML = "&#x1F50D; Search for latest";
        resultsDiv.innerHTML = `<p class="hint" style="margin-top:0.5rem;">Error: ${err.message}</p>`;
        resultsDiv.classList.add("visible");
      }
    });
  });
}

// ===== AI Regulatory Timeline =====
let regulatoryTimelineData = null;

async function loadRegulatoryTimeline() {
  const content = document.getElementById("regulatoryTimelineContentSection");

  if (regulatoryTimelineData) {
    renderRegulatoryTimeline("all");
    return;
  }

  content.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading regulatory timeline...</p></div>';

  try {
    const res = await fetch(`${API_BASE}/regulatory-timeline`);
    const json = await res.json();
    if (json.success) {
      regulatoryTimelineData = json.data;
      setupTimelineFilters();
      renderRegulatoryTimeline("all");
    }
  } catch (err) {
    content.innerHTML = `<div class="empty-state"><p>Failed to load: ${err.message}</p></div>`;
  }
}

function setupTimelineFilters() {
  document.querySelectorAll(".timeline-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".timeline-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderRegulatoryTimeline(btn.dataset.filter);
    });
  });
}

function renderRegulatoryTimeline(filter) {
  const content = document.getElementById("regulatoryTimelineContentSection");
  if (!regulatoryTimelineData) return;

  const events = filter === "all"
    ? regulatoryTimelineData.events
    : regulatoryTimelineData.events.filter(e =>
        e.jurisdiction === filter || e.category === filter
      );

  if (events.length === 0) {
    content.innerHTML = '<div class="empty-state"><p>No events match this filter</p></div>';
    return;
  }

  let html = '<div class="timeline-spine"></div>';

  events.forEach(e => {
    const dotClass = e.category === "Critical Deadline" ? "critical" : e.jurisdiction.toLowerCase();
    const badgeClass = e.category === "Critical Deadline" ? "critical" : e.jurisdiction.toLowerCase();

    const linkHtml = e.link ? `<a href="${e.link}" target="_blank" rel="noopener" class="timeline-link">${e.linkLabel || "Official source →"}</a>` : "";

    html += `
      <div class="timeline-event">
        <div class="timeline-dot ${dotClass}"></div>
        <div class="timeline-date">${e.label}</div>
        <h3>
          ${e.title}
          <span class="timeline-badge ${badgeClass}">${e.category === "Critical Deadline" ? "⚠ Critical" : e.jurisdiction}</span>
          <span class="event-cat">${e.category}</span>
        </h3>
        <p>${e.description}</p>
        <div class="timeline-impact"><strong>Impact:</strong> ${e.impact}</div>
        ${linkHtml}
      </div>`;
  });

  content.innerHTML = html;
}

// ===== Risks =====
let risksData = null;

async function loadRisks() {
  if (risksData) {
    renderRisks();
    return;
  }

  const categoriesEl = document.getElementById("risksCategories");
  categoriesEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading risk analysis...</p></div>';

  try {
    const res = await fetch(`${API_BASE}/risks`);
    const json = await res.json();
    if (json.success) {
      risksData = json.data;
      setupRisksFilters();
      renderRisks();
    }
  } catch (err) {
    categoriesEl.innerHTML = `<div class="empty-state"><p>Failed to load: ${err.message}</p></div>`;
  }
}

function setupRisksFilters() {
  document.querySelectorAll(".risks-filter-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".risks-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      renderRisks(btn.dataset.filter);
    });
  });
}

function renderRisks(filter = "all") {
  if (!risksData) return;

  const cats = risksData.categories;
  const summaries = risksData.companyRiskSummaries;

  // Stats
  let totalRisks = 0;
  let criticalRisks = 0;
  const allCompanies = new Set();
  Object.values(cats).forEach(cat => {
    cat.risks.forEach(r => {
      if (filter === "all" || r.severity === filter) {
        totalRisks++;
        if (r.severity === "critical") criticalRisks++;
        (r.affectedCompanies || []).forEach(c => allCompanies.add(c));
      }
    });
  });

  document.getElementById("risksCategoryCount").textContent = Object.keys(cats).length;
  document.getElementById("risksTotalCount").textContent = totalRisks;
  document.getElementById("risksCriticalCount").textContent = criticalRisks;
  document.getElementById("risksCompaniesCount").textContent = allCompanies.size;

  // Company risk summaries
  const companiesGrid = document.getElementById("risksCompaniesGrid");
  let companyHtml = "";
  const summaryEntries = Object.entries(summaries);
  summaryEntries.forEach(([id, s]) => {
    const criticalCount = s.topRisks.filter(r => {
      const cat = cats[r];
      return cat && cat.severity === "critical";
    }).length;
    const highCount = s.topRisks.filter(r => {
      const cat = cats[r];
      return cat && cat.severity === "high";
    }).length;

    companyHtml += `
      <div class="risk-company-card" data-company="${id}">
        <div class="risk-company-header">
          <span class="risk-company-name">${s.name}</span>
          <span class="risk-company-badges">
            ${criticalCount > 0 ? `<span class="risk-badge critical">${criticalCount} critical</span>` : ""}
            ${highCount > 0 ? `<span class="risk-badge high">${highCount} high</span>` : ""}
          </span>
        </div>
        <p class="risk-company-summary">${s.summary}</p>
        <div class="risk-company-sources">
          ${(s.sources || []).map(src =>
            `<a href="${src.url}" target="_blank" rel="noopener" class="risk-source-link">↗ ${src.label}</a>`
          ).join("")}
        </div>
      </div>`;
  });
  companiesGrid.innerHTML = companyHtml || '<div class="empty-state"><p>No company risk profiles available</p></div>';

  // Risk categories with detailed analysis
  const categoriesEl = document.getElementById("risksCategories");
  let catHtml = "";

  const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const sortedCats = Object.values(cats).sort((a, b) =>
    (severityOrder[a.severity] || 99) - (severityOrder[b.severity] || 99)
  );

  sortedCats.forEach(cat => {
    const filteredRisks = filter === "all"
      ? cat.risks
      : cat.risks.filter(r => r.severity === filter);

    if (filteredRisks.length === 0) return;

    const sevClass = cat.severity;
    const sevLabel = cat.severity.toUpperCase();

    catHtml += `
      <div class="risk-category-card" data-severity="${cat.severity}">
        <div class="risk-category-header">
          <span class="risk-category-icon">${cat.icon}</span>
          <div class="risk-category-title-area">
            <h3 class="risk-category-title">${cat.title}</h3>
            <span class="risk-severity-tag ${sevClass}">${sevLabel}</span>
            <span class="risk-reg-tags">${(cat.regulations || []).slice(0, 3).map(r => `<span class="risk-reg-tag">${r}</span>`).join("")}</span>
          </div>
        </div>
        <p class="risk-category-desc">${cat.description}</p>

        <div class="risk-items">
          ${filteredRisks.map(r => {
            const comps = (r.affectedCompanies || []).slice(0, 6);
            const moreCount = (r.affectedCompanies || []).length - 6;
            return `
            <div class="risk-item">
              <div class="risk-item-header">
                <span class="risk-item-severity ${r.severity}">${r.severity.toUpperCase()}</span>
                <h4 class="risk-item-title">${r.title}</h4>
              </div>
              <p class="risk-item-desc">${r.description}</p>
              <div class="risk-item-meta">
                ${comps.length > 0 ? `<span class="risk-meta-label">Affected:</span>
                <span class="risk-affected-companies">${comps.join(", ")}${moreCount > 0 ? ` +${moreCount} more` : ""}</span>` : ""}
              </div>
              ${r.products && r.products.length > 0 ? `
              <div class="risk-item-meta">
                <span class="risk-meta-label">Products:</span>
                <span class="risk-affected-products">${r.products.slice(0, 5).join(", ")}${r.products.length > 5 ? ` +${r.products.length - 5} more` : ""}</span>
              </div>` : ""}
              <div class="risk-item-sources">
                ${(r.sources || []).map(src =>
                  `<a href="${src.url}" target="_blank" rel="noopener" class="risk-source-link">↗ ${src.label}</a>`
                ).join("")}
                ${r.kbCrossReference ? `<span class="risk-xref">📚 KB: ${r.kbCrossReference}</span>` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>`;
  });

  categoriesEl.innerHTML = catHtml || '<div class="empty-state"><p>No risks match the selected filter</p></div>';
}

// ===== Source Monitor + Review Queue (Scope C, P1–P3) =====
// The server crawls the official allowlist and, instead of auto-editing the site,
// queues PROPOSED CHANGES (only when they would update/expand/correct existing
// content, or are a clearly new, covered topic). This client polls the queue every
// 5 minutes and shows a single quiet "Suggested updates" badge. Opening it shows
// the review panel where the user approves each change.
const SU_POLL_MS = 5 * 60 * 1000;

function setupSourceMonitor() {
  pollProposedChanges();
  setInterval(pollProposedChanges, SU_POLL_MS);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pollProposedChanges();
  });
}

async function pollProposedChanges() {
  try {
    const statusRes = await fetch(`${API_BASE}/regulatory-status`);
    const status = statusRes.ok ? await statusRes.json() : null;
    const lastScan = status?.lastScanAt ? Date.parse(status.lastScanAt) : 0;
    const stale = !lastScan || (Date.now() - lastScan) > 30 * 60 * 1000;
    if (stale) {
      fetch(`${API_BASE}/source-scan`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
      }).catch(() => {});
    }
    await updateSuggestedUpdatesBadge();
  } catch (_) {
    // Silent failure — will retry on the next interval.
  }
}

async function updateSuggestedUpdatesBadge() {
  try {
    const res = await fetch(`${API_BASE}/proposed-changes`);
    const json = res.ok ? await res.json() : null;
    const count = json?.pendingCount || 0;
    const btn = document.getElementById("suggestedUpdatesBtn");
    const countEl = document.getElementById("suggestedUpdatesCount");
    if (!btn) return;
    if (countEl) countEl.textContent = count;
    btn.style.display = count > 0 ? "inline-flex" : "none";
    btn.dataset.count = String(count);
  } catch (_) {}
}

// ---- Review panel: list proposed changes; user Integrates or Dismisses ----
function setupReviewPanel() {
  const btn = document.getElementById("suggestedUpdatesBtn");
  const overlay = document.getElementById("reviewPanelOverlay");
  const closeBtn = document.getElementById("closeReviewPanel");
  const listEl = document.getElementById("reviewPanelList");
  const emptyEl = document.getElementById("reviewPanelEmpty");

  if (btn) btn.addEventListener("click", async () => {
    await renderReviewPanel();
    if (overlay) overlay.style.display = "flex";
  });
  if (closeBtn) closeBtn.addEventListener("click", () => { if (overlay) overlay.style.display = "none"; });
  if (overlay) overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.style.display = "none"; });

  if (listEl) listEl.addEventListener("click", async (e) => {
    const integrateBtn = e.target.closest("[data-integrate]");
    const dismissBtn = e.target.closest("[data-dismiss]");
    const editToggle = e.target.closest("[data-edit-toggle]");
    if (editToggle) {
      const card = editToggle.closest(".proposal-card");
      if (!card) return;
      const textEl = card.querySelector(".proposal-summary-text");
      const box = card.querySelector(".proposal-edit-box");
      if (!box) return;
      const editing = box.style.display !== "none";
      if (editing) {
        if (textEl) textEl.textContent = box.value;
        box.style.display = "none";
        if (textEl) textEl.style.display = "";
        editToggle.textContent = "Edit summary";
      } else {
        if (textEl) textEl.style.display = "none";
        box.style.display = "block";
        box.focus();
        editToggle.textContent = "Save";
      }
      return;
    }
    if (dismissBtn) {
      const id = dismissBtn.dataset.dismiss;
      await authedFetch(`${API_BASE}/proposed-changes/${id}/dismiss`, { method: "POST" }).catch(() => {});
      const card = dismissBtn.closest(".proposal-card");
      if (card) card.remove();
      await updateSuggestedUpdatesBadge();
      checkReviewEmpty();
      return;
    }
    if (integrateBtn) {
      const id = integrateBtn.dataset.integrate;
      const card = integrateBtn.closest(".proposal-card");
      const editBox = card.querySelector(".proposal-edit-box");
      const targetSel = card.querySelector(".proposal-target");
      const catKey = card.querySelector(".proposal-catkey");
      const body = { edit: editBox ? editBox.value : "" };
      if (targetSel && targetSel.value) body.targetDataset = targetSel.value;
      if (catKey && catKey.value) body.targetCategoryKey = catKey.value;
      integrateBtn.disabled = true;
      try {
        const res = await authedFetch(`${API_BASE}/proposed-changes/${id}/integrate`, {
          method: "POST", body: JSON.stringify(body),
        });
        if (res.ok) {
          card.remove();
          await updateSuggestedUpdatesBadge();
          checkReviewEmpty();
          showToast("Change integrated into the app.", "success");
        } else {
          integrateBtn.disabled = false;
          showToast("Could not integrate that change.", "error");
        }
      } catch (_) {
        integrateBtn.disabled = false;
      }
    }
  });
}

async function renderReviewPanel() {
  const listEl = document.getElementById("reviewPanelList");
  const emptyEl = document.getElementById("reviewPanelEmpty");
  if (!listEl) return;
  listEl.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Loading proposed changes…</p></div>';
  try {
    const res = await fetch(`${API_BASE}/proposed-changes`);
    const json = res.ok ? await res.json() : { pending: [] };
    const items = json.pending || [];
    if (!items.length) {
      listEl.innerHTML = "";
      if (emptyEl) emptyEl.style.display = "block";
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    const actionLabel = {
      update: "Expand existing entry",
      deadline: "New deadline",
      correction: "Corrects / supersedes",
      new: "New topic",
    };
    const reasonLabels = {
      "information-outdated": "Information Outdated",
      "additional-information": "Additional Information",
      "new-case-study": "New Case Study",
      "new-deadline": "New Deadline",
      "new-development": "New Development",
    };
    const reasonOrder = ["information-outdated", "additional-information", "new-case-study", "new-deadline", "new-development"];
    const matchHtml = (p) => p.matchedRecord
      ? `<div class="proposal-match">Matches: <strong>${escapeHtml(p.matchedRecord.title)}</strong> <span class="proposal-confidence">(${Math.round((p.matchConfidence || 0) * 100)}% overlap)</span></div>`
      : `<div class="proposal-match proposal-match-new">Not currently in the app — a new topic.</div>`;
    // The AI-generated, app-style summary is the primary preview. Editing is
    // opt-in: a hidden textarea (pre-filled with the summary) is revealed only
    // when the user clicks "Edit summary", so the default view prioritises the
    // AI summary without an always-on editable box. The hidden box is kept in
    // the DOM so the existing Integrate handler reads the (edited) summary.
    const previewHtml = (p) => {
      // Manual review required: the source blocked automated access (#3). Never
      // present the bot-wall page; ask a human to review the original article.
      if (p.fetchStatus === "blocked") {
        return `<div class="proposal-blocked-notice">
          <strong>Manual review required.</strong> This site was detected as potentially containing new information, but due to restrictions on automated / non-human access, we couldn't retrieve it automatically.
          ${p.url ? `<a class="proposal-source-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open the original article ↗</a>` : ""}
        </div>`;
      }
      // Honest pending state (#4): the model couldn't rewrite yet (quota / offline).
      // Evaluated BEFORE the styled-summary check so a rate-limited proposal that
      // already has an extracted preview still shows this notice (and NOT the raw
      // extracted text under the "AI-generated" label). The next scan retries it
      // after the short per-proposal backoff and auto-enriches when capacity recovers.
      if (p.enrichStatus === "rate-limited" || p.enrichStatus === "pending") {
        return `<div class="proposal-pending-notice">
          AI rewrite temporarily unavailable (quota); will auto-enrich when capacity recovers.
          ${p.url ? `<a class="proposal-source-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open the original article ↗</a>` : ""}
        </div>`;
      }
      // Primary preview: the AI-styled, app-style summary is the real suggestion.
      // We render it ONLY when it actually exists — we never fall back to raw or
      // extracted text as the "finished" suggestion (#4).
      if (p.styledSummary) {
        return `
        <div class="proposal-summary-block">
          <div class="proposal-preview-label">Proposed entry (AI-generated, in app style):</div>
          <div class="proposal-preview proposal-summary-text">${escapeHtml(p.styledSummary)}</div>
          <div class="proposal-edit-row">
            <button class="btn btn-sm proposal-edit-toggle" data-edit-toggle type="button">Edit summary</button>
          </div>
          <textarea class="proposal-edit-box text-input" rows="4" style="display:none">${escapeHtml(p.styledSummary)}</textarea>
          ${p.url ? `<a class="proposal-source-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open the original article ↗</a>` : ""}
        </div>`;
      }
      // No AI-generated summary and not a transient rate-limit. Two distinct
      // situations end up here, and they must read differently:
      //   (a) The proposal was created but the background scanner hasn't analysed
      //       it yet (or it predates the live-enrichment schema and has no
      //       fetchStatus/enrichStatus at all). This is NOT a failure — it's
      //       simply queued. Show an honest "being analysed" state, NOT the
      //       alarming "No extractable summary — open the original article" copy.
      //   (b) The source was genuinely fetched and reviewed but yielded nothing
      //       usable. Only then is the "No extractable summary" message correct.
      if (!p.fetchStatus && !p.enrichStatus) {
        return `<div class="proposal-pending-notice">
          This update is still being analysed. A preview will appear automatically once the source has been reviewed.
          ${p.url ? `<a class="proposal-source-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open the original article ↗</a>` : ""}
        </div>`;
      }
      return `<div class="proposal-nopreview">No extractable summary was available from the source feed. <a href="${escapeHtml(p.url || "#")}" target="_blank" rel="noopener">Open the original article</a> to review the content before approving.</div>`;
    };
    const cardHtml = (p) => {
      const targetDefault = p.targetDataset
        || (p.matchedRecord ? p.matchedRecord.dataset
           : (p.category === "use-case" ? "use-cases"
              : p.detectedAction === "deadline" ? "timeline"
              : "knowledge"));
      const showCatKey = targetDefault === "knowledge";
      const catKey = p.targetCategory || "regulations";
      const reasonKey = reasonLabels[p.updateCategory] ? p.updateCategory : "new-development";
      return `
      <div class="proposal-card" data-id="${p.id}">
        <div class="proposal-head">
          <span class="proposal-action proposal-action-${p.detectedAction}">${actionLabel[p.detectedAction] || p.detectedAction}</span>
          <span class="proposal-source">${escapeHtml(p.publisher || p.source || "")}</span>
          <span class="proposal-date">${escapeHtml(p.publishedLabel || "")}</span>
        </div>
        <div class="proposal-title">${escapeHtml(p.title)}</div>
        ${matchHtml(p)}
        ${p.updateReason ? `<div class="proposal-reason"><span class="proposal-reason-pill proposal-reason-${reasonKey}">${reasonLabels[reasonKey]}</span> ${escapeHtml(p.updateReason)}</div>` : ""}
        ${previewHtml(p)}
        <div class="proposal-controls">
          <label class="proposal-field">Add to:
            <select class="proposal-target text-input">
              <option value="timeline" ${targetDefault === "timeline" ? "selected" : ""}>AI Regulatory Timeline</option>
              <option value="knowledge" ${targetDefault === "knowledge" ? "selected" : ""}>Knowledge Base</option>
              <option value="use-cases" ${targetDefault === "use-cases" ? "selected" : ""}>AI Use Cases</option>
            </select>
          </label>
          ${showCatKey ? `<input class="proposal-catkey text-input" placeholder="Category key (e.g. regulations)" value="${escapeHtml(catKey)}" />` : ""}
        </div>
        <div class="proposal-actions">
          <button class="btn btn-sm btn-primary" data-integrate="${p.id}" type="button">Integrate</button>
          <button class="btn btn-sm" data-dismiss="${p.id}" type="button">Dismiss</button>
        </div>
      </div>`;
    };
    // Group proposals by their "why suggested" category so the user can scan and
    // compare updates of the same kind together (Information Outdated, Additional
    // Information, New Case Study, ...).
    const groups = {};
    for (const p of items) {
      const k = reasonLabels[p.updateCategory] ? p.updateCategory : "new-development";
      (groups[k] = groups[k] || []).push(p);
    }
    const presentKeys = reasonOrder.filter(k => groups[k] && groups[k].length);
    const navHtml = `
      <nav class="proposal-nav" aria-label="Jump to update category">
        <span class="proposal-nav-label">Jump to:</span>
        ${presentKeys.map(k => `
          <a class="proposal-nav-chip" data-jump="proposal-group-${k}" href="#proposal-group-${k}">
            <span class="proposal-reason-pill proposal-reason-${k}">${reasonLabels[k]}</span>
            <span class="proposal-nav-count">${groups[k].length}</span>
          </a>`).join("")}
      </nav>`;
    listEl.innerHTML = navHtml + presentKeys.map(k => `
        <div class="proposal-group" id="proposal-group-${k}">
          <div class="proposal-group-head">
            <span class="proposal-reason-pill proposal-reason-${k}">${reasonLabels[k]}</span>
            <span class="proposal-group-count">${groups[k].length}</span>
          </div>
          ${groups[k].map(cardHtml).join("")}
        </div>`).join("");
    // Quick-nav: clicking a category chip smoothly scrolls to that group.
    const nav = listEl.querySelector(".proposal-nav");
    if (nav) {
      nav.addEventListener("click", (e) => {
        const a = e.target.closest("a[data-jump]");
        if (!a) return;
        e.preventDefault();
        const target = document.getElementById(a.getAttribute("data-jump"));
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    }
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state"><p>Failed to load: ${err.message}</p></div>`;
  }
}

function checkReviewEmpty() {
  const listEl = document.getElementById("reviewPanelList");
  const emptyEl = document.getElementById("reviewPanelEmpty");
  if (listEl && emptyEl && !listEl.querySelector(".proposal-card")) {
    emptyEl.style.display = "block";
  }
}

function updateTabBadge(viewId, count) {
  const btn = document.querySelector(`.nav-btn[data-view="${viewId}"]`);
  if (!btn) return;

  // Remove existing badge
  const existingBadge = btn.querySelector(".tab-badge");
  if (existingBadge) existingBadge.remove();

  if (count > 0) {
    const badge = document.createElement("span");
    badge.className = "tab-badge";
    badge.textContent = count > 99 ? "99+" : count;
    btn.appendChild(badge);
  }
}

// ===== Toast notifications =====
let activeToastTimer = null;
function showToast(message, type = "info") {
  // Remove existing toast
  const existing = document.querySelector(".toast-notification");
  if (existing) existing.remove();
  if (activeToastTimer) clearTimeout(activeToastTimer);

  const toast = document.createElement("div");
  toast.className = `toast-notification toast-${type}`;
  toast.innerHTML = `<span>${message}</span><button class="toast-close" onclick="this.parentElement.remove()">&times;</button>`;
  document.body.appendChild(toast);

  activeToastTimer = setTimeout(() => {
    if (toast.parentElement) toast.remove();
  }, 6000);
}
