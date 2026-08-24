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

// ===== Init =====
document.addEventListener("DOMContentLoaded", () => {
  restoreTabOrder();
  setupNavigation();
  setupSettings();
  checkApiStatus();
  loadKnowledgeBase();
  setupSubTabs();
  setupNewsFavorites();
  setupFolderUI();
  setupNewsCompetitors();
  setupMySources();
  setupTeamSourcesComposer();
  setupQA();
  setupTabDragDrop();
  setupSourceMonitor();
  setupNewsStream();
  setupReviewPanel();
  setupStatExpand();
  setupTeamSources();
  setupNewsTeamSources();
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

      if (viewId === "news-view") { loadNews(); loadTeamSources(); }
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

  // Refresh news — single explicit control; clears the live "new since you looked" badge.
  document.getElementById("refreshNewsBtn").addEventListener("click", () => {
    newsUnseenCount = 0;
    const badge = document.getElementById("newsLiveBadge");
    if (badge) { badge.hidden = true; badge.textContent = ""; badge.title = ""; }
    loadNews(true);
  });

  // Search button
  document.getElementById("searchBtn").addEventListener("click", doSearch);
  document.getElementById("searchInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
  // Clear an active search and return to the live feed
  document.getElementById("clearSearchBtn")?.addEventListener("click", clearSearch);
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

// ===== Phase 3a: "My Sources" picker (attach saved News articles as [S#]) =====
function setupMySources() {
  const toggle = document.getElementById("useMySources");
  const panel = document.getElementById("mySourcesPanel");
  if (!toggle || !panel) return;
  toggle.addEventListener("change", () => {
    panel.style.display = toggle.checked ? "block" : "none";
    if (toggle.checked) renderMySourcesList();
  });
}

// Thread D composer control: opt-in Team Sources, mirroring My Sources.
// Default OFF. When switched on, the checklist is populated and every ingested
// team source is auto-selected (so the toggle alone = "include all team
// sources"); the user can then deselect specific ones. Selected citation_ids
// are sent to /api/summarise and the server only injects those [T#] items.
function setupTeamSourcesComposer() {
  const toggle = document.getElementById("useTeamSources");
  const panel = document.getElementById("teamSourcesComposerPanel");
  if (!toggle || !panel) return;
  toggle.addEventListener("change", () => {
    panel.style.display = toggle.checked ? "block" : "none";
    if (toggle.checked) {
      renderTeamComposerList();
    } else {
      selectedTeamSourceIds.clear();
      updateTeamComposerCount();
    }
  });
}

async function renderTeamComposerList() {
  const list = document.getElementById("teamSourcesComposerList");
  const empty = document.getElementById("teamSourcesComposerEmpty");
  const count = document.getElementById("teamSourcesComposerCount");
  if (!list) return;
  try {
    const res = await fetch(`${API_BASE}/sources`);
    if (!res.ok) { list.innerHTML = ""; if (empty) empty.style.display = "block"; return; }
    const data = await res.json();
    const sourcesList = Array.isArray(data.sources) ? data.sources : [];
    if (!sourcesList.length) {
      list.innerHTML = "";
      if (empty) empty.style.display = "block";
      updateTeamComposerCount();
      return;
    }
    if (empty) empty.style.display = "none";
    // Auto-select all ingested team sources when the panel first opens, so the
    // toggle alone includes the whole pool (per the agreed UX).
    selectedTeamSourceIds = new Set(sourcesList.map(s => s.citationId).filter(Boolean));
    list.innerHTML = sourcesList.map(s => {
      const cid = s.citationId || "";
      const key = encodeURIComponent(cid);
      const checked = cid ? "checked" : "";
      const urlHost = s.url ? hostOf(s.url) : "";
      return `<label class="my-sources-item">
        <input type="checkbox" class="team-source-check" data-cid="${key}" ${checked} />
        <span class="my-sources-item-title">${escapeHtml(s.citationId ? `[${cid}] ` : "")}${escapeHtml(s.title || s.url || "Untitled")}</span>
        ${urlHost ? `<a class="my-sources-item-url" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(urlHost)}</a>` : ""}
      </label>`;
    }).join("");
    list.querySelectorAll(".team-source-check").forEach(cb => {
      cb.addEventListener("change", () => {
        const cid = decodeURIComponent(cb.dataset.cid);
        if (cb.checked) selectedTeamSourceIds.add(cid);
        else selectedTeamSourceIds.delete(cid);
        updateTeamComposerCount();
      });
    });
    updateTeamComposerCount();
  } catch (_) {
    list.innerHTML = "";
    if (empty) empty.style.display = "block";
  }
}

function updateTeamComposerCount() {
  const count = document.getElementById("teamSourcesComposerCount");
  if (count) count.textContent = `${selectedTeamSourceIds.size} selected`;
}

function renderMySourcesList() {
  const list = document.getElementById("mySourcesList");
  const empty = document.getElementById("mySourcesEmpty");
  const count = document.getElementById("mySourcesCount");
  if (!list) return;

  if (!savedNewsArticles.length) {
    list.innerHTML = "";
    if (empty) empty.style.display = "block";
    if (count) count.textContent = "0 selected";
    return;
  }
  if (empty) empty.style.display = "none";

  const folders = listFolders();
  const groups = [];
  folders.forEach(f => {
    const items = savedNewsArticles.filter(a => (a.folderIds || []).includes(f.id));
    if (items.length) groups.push({ label: f.name, items });
  });
  const ungrouped = savedNewsArticles.filter(a => !(a.folderIds || []).length);
  if (ungrouped.length) groups.push({ label: "Ungrouped", items: ungrouped });

  list.innerHTML = groups.map(g => `
    <div class="my-sources-group">
      <div class="my-sources-group-label">${escapeHtml(g.label)}</div>
      ${g.items.map(a => {
        const key = newsArticleKey(a);
        const checked = selectedMySourceKeys.has(key) ? "checked" : "";
        const urlHost = a.url ? hostOf(a.url) : "";
        return `<label class="my-sources-item">
          <input type="checkbox" class="my-source-check" data-key="${escapeHtml(encodeURIComponent(key))}" ${checked} />
          <span class="my-sources-item-title">${escapeHtml(a.title || "Untitled")}</span>
          ${urlHost ? `<a class="my-sources-item-url" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">${escapeHtml(urlHost)}</a>` : ""}
        </label>`;
      }).join("")}
    </div>`).join("");

  list.querySelectorAll(".my-source-check").forEach(cb => {
    cb.addEventListener("change", () => {
      const key = decodeURIComponent(cb.dataset.key);
      if (cb.checked) selectedMySourceKeys.add(key);
      else selectedMySourceKeys.delete(key);
      if (count) count.textContent = `${selectedMySourceKeys.size} selected`;
    });
  });
  if (count) count.textContent = `${selectedMySourceKeys.size} selected`;
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

  // Phase 3a: attach selected saved articles as user-supplied [S#] sources.
  let userSources = [];
  if (document.getElementById("useMySources")?.checked === true) {
    userSources = savedNewsArticles
      .filter(a => selectedMySourceKeys.has(newsArticleKey(a)))
      .map(a => ({
        title: a.title || "Untitled",
        url: a.url || "",
        text: (a.description || "").slice(0, 4000),
      }));
  }

  // Thread D: attach selected team sources as [T#] evidence, but ONLY when the
  // composer toggle is on (opt-in). Defaults to none, so team evidence is never
  // auto-injected into every answer (saves tokens; makes the "not cited" badge
  // meaningful because the user explicitly chose them).
  const teamSources = document.getElementById("useTeamSources")?.checked === true
    ? [...selectedTeamSourceIds]
    : [];

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
        userSources,
        teamSources,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(data.error || "Answer generation failed");

    lastAnswerText = data.answer || "";
    lastAnswerSources = data.sources || [];
    renderAnswerByStyle();
    const sourceCount = data.sources?.length || 0;
    const internetLabel = data.internetUsed ? " · internet evidence included" : "";
    const skipLabel = data.internetSkipped ? " · web skipped (local evidence covers)" : "";
    const modeText =
      data.model?.mode === "extractive-citation" ? "extractive · cited"
      : data.model?.mode === "local-open-source-model" ? "AI model"
      : "extractive (model fallback)";
    document.getElementById("summaryResultMeta").textContent = `${sourceCount} sources · ${modeText}${internetLabel}${skipLabel} · ${new Date(data.generatedAt).toLocaleTimeString()}`;

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
// **bold**, and [A#]/[W#]/[T#] inline citation chips/links. Legacy "■ " headings and
// citation behaviour are preserved. Unknown headings become "other" sections.
function parseAnswer(text, sources) {
  const sourceMap = new Map((sources || []).map(s => [s.id, s]));
  const renderInline = (line) => {
    let html = escapeHtml(line);
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    html = html.replace(/\[([AWST]\d+)\]/g, (m, id) => {
      const src = sourceMap.get(id);
      const cls = "ans-cite" + (src?.sourceType === "internet" ? " ans-cite-web" : src?.sourceType === "user" ? " ans-cite-user" : src?.sourceType === "team" ? " ans-cite-team" : "");
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
// Phase 3a: keys of saved News articles the user has chosen to attach as [S#] sources.
let selectedMySourceKeys = new Set();
// Thread D: citation_ids (e.g. "T2") of team sources the user has chosen to attach as [T#] evidence.
let selectedTeamSourceIds = new Set();

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
    // Client-side Sources notice (proposal B): when the user attached a [S#]
    // source but the answer did not cite it, disclose the gap transparently
    // instead of silently dropping the context.
    const isUserSource = source.sourceType === "user";
    // The cited check now applies to every source type (not just user [S#]
    // sources): a web [W#], team [T#], or KB [A#] source that was retrieved as
    // evidence but never referenced inline by the answer is disclosed as
    // "retrieved, not cited" so the reader knows it was considered but not used.
    const cited = lastAnswerText.includes("[" + source.id + "]");
    let notice = "";
    if (!cited) {
      notice = isUserSource
        ? `<p class="evidence-notice">Another source was used over this as evidence due to greater relevance</p>`
        : `<p class="evidence-notice evidence-notice-muted">Retrieved, not cited in answer.</p>`;
    }
    return `
      <article class="summary-evidence-card">
        <div class="summary-evidence-card-header">
          <span class="summary-evidence-id">${escapeHtml(source.id)}</span>
          <span class="summary-evidence-kind">${source.sourceType === "internet" ? "Internet" : escapeHtml(source.dataset || "Application")}</span>
        </div>
        ${titleMarkup}
        <p>${escapeHtml(source.excerpt || "")}</p>
        ${notice}
      </article>`;
  }).join("");
}

// ===== Drag-and-Drop Tab Reordering =====
const TAB_ORDER_KEY = "tabOrder";
const DEFAULT_TAB_ORDER = [
  "knowledge-base", "news-view", "summarise-view",
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
  // Refreshing the feed exits any active search and restores the live list.
  searchActive = false;
  hideSearchBanner();
  const feed = document.getElementById("newsFeed");
  feed.innerHTML = '<div class="loading-state"><div class="spinner"></div><p>Scanning competitor news...</p></div>';

  try {
    const params = new URLSearchParams({ competitors: selectedNewsCompetitorIds.join(",") });
    if (forceRefresh) params.set("refresh", Date.now().toString());
    const res = await fetch(`${API_BASE}/news?${params.toString()}`, { cache: "no-store" });
    const data = await res.json();

    if (!data.success) {
      feed.innerHTML = `<div class="empty-state"><p>${data.error || "Failed to fetch news"}</p></div>`;
      return;
    }

    document.getElementById("articleCount").textContent = data.count;

    const updatedEl = document.getElementById("lastUpdated");
    if (data.cached) {
      updatedEl.innerHTML = '<span style="color:#d97706;">Cached results</span> &mdash; ' +
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
      feed.innerHTML = '<div class="empty-state"><p>No articles found. Try refreshing or check the Search tab for custom queries.</p></div>';
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
    feed.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
  }
}

const SAVED_ARTICLES_KEY = "savedNewsArticles";
const NEWS_FOLDERS_KEY = "newsFolders";
let currentFilter = null;
let allArticles = [];
let newsViewMode = "recent";
let savedNewsArticles = loadSavedNewsArticles();
let newsFolders = loadNewsFolders();
// null = "All Saved"; otherwise the id of the folder currently filtered in Saved Articles.
let activeFolderFilter = null;
// Thread B: a single open SSE connection for live news updates (one per tab).
let newsEventSource = null;
// Count of server-pushed news updates that arrived while the user was not looking
// at the News feed. Drives the "new since you looked" badge on the Refresh control.
let newsUnseenCount = 0;

function loadSavedNewsArticles() {
  try {
    const saved = JSON.parse(localStorage.getItem(SAVED_ARTICLES_KEY) || "[]");
    return Array.isArray(saved) ? saved : [];
  } catch (_) {
    return [];
  }
}

function loadNewsFolders() {
  try {
    const data = JSON.parse(localStorage.getItem(NEWS_FOLDERS_KEY) || "[]");
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

function saveNewsArticles() {
  localStorage.setItem(SAVED_ARTICLES_KEY, JSON.stringify(savedNewsArticles));
  updateSavedArticleCount();
}

function saveNewsFolders() {
  localStorage.setItem(NEWS_FOLDERS_KEY, JSON.stringify(newsFolders));
}

function newsArticleKey(article) {
  return article?.url || `${article?.title || ""}|${article?.publishedAt || ""}`;
}

// Dedup for "Add to Team Sources" from a news card. Keyed by the article URL.
// `addedToTeamSources` tracks in-session adds (survives card re-renders);
// `existingTeamSourceUrls` is refreshed from GET /api/sources so a card already
// present in Team Sources (e.g. added via the paste box) shows as added too.
const addedToTeamSources = new Set();
const existingTeamSourceUrls = new Set();

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

  const newsFeedEl = document.getElementById("newsFeed");
  const attachFavoriteHandler = (container, sourceListGetter) => {
    container?.addEventListener("click", event => {
      const button = event.target.closest(".news-favorite-btn");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();

      const key = decodeURIComponent(button.dataset.articleKey || "");
      const article = sourceListGetter().find(item => newsArticleKey(item) === key);
      if (article) toggleNewsFavorite(article, container);
    });
  };
  // When a search is active the feed shows search results, so look them up there.
  attachFavoriteHandler(newsFeedEl, () => searchActive ? searchResultsData : [...allArticles, ...savedNewsArticles]);
}

function setNewsViewMode(mode) {
  newsViewMode = mode === "saved" ? "saved" : "recent";
  // Leaving a sub-tab always exits an active search and restores the live feed.
  searchActive = false;
  activeSearchQuery = "";
  hideSearchBanner();
  const title = document.getElementById("newsSectionTitle");
  const filters = document.getElementById("filterTags");
  const searchResults = document.getElementById("searchResultsSection");
  if (searchResults) searchResults.style.display = "none";

  if (title) title.textContent = newsViewMode === "saved" ? "Saved Articles" : "Recent News & Updates";
  if (filters) filters.style.display = newsViewMode === "saved" ? "none" : "flex";

  if (newsViewMode === "saved") {
    renderSavedArticles();
  } else {
    renderNewsCards(allArticles, currentFilter);
  }
  // Keep the folder sidebar in sync with the active sub-tab (hidden unless Saved).
  renderFoldersSidebar();
}

function toggleNewsFavorite(article, container = document.getElementById("newsFeed")) {
  const key = newsArticleKey(article);
  const existingIndex = savedNewsArticles.findIndex(saved => newsArticleKey(saved) === key);

  if (existingIndex >= 0) {
    savedNewsArticles.splice(existingIndex, 1);
  } else {
    savedNewsArticles.unshift({ ...article, savedAt: new Date().toISOString() });
  }

  saveNewsArticles();
  showToast(existingIndex >= 0 ? "Article removed from saved items." : "Article saved for later.");
  if (searchActive) {
    renderSearchResultsToFeed();
  } else if (newsViewMode === "saved") {
    renderSavedArticles();
  } else {
    renderNewsCards(allArticles, currentFilter);
  }
}

function updateSavedArticleCount() {
  const count = document.getElementById("savedArticleCount");
  if (count) count.textContent = savedNewsArticles.length;
}

// ===== Folders for saved articles (localStorage) =====
// Folders let a user group saved articles (e.g. "risks", "competitors"). An
// article must be saved to belong to a folder; assigning to a folder saves it.
function createFolder(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const folder = {
    id: "fld_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: trimmed,
    createdAt: new Date().toISOString(),
  };
  newsFolders.push(folder);
  saveNewsFolders();
  return folder;
}

function listFolders() {
  return newsFolders;
}

// How many saved articles currently sit in a folder (used for chip counts and
// for warning the user before a delete).
function countArticlesInFolder(folderId) {
  return savedNewsArticles.filter(a => (a.folderIds || []).includes(folderId)).length;
}

// Renames a folder in place. Returns an { ok, reason } result so the caller can
// explain the failure instead of silently doing nothing.
function renameFolder(folderId, name) {
  const folder = newsFolders.find(f => f.id === folderId);
  if (!folder) return { ok: false, reason: "not-found" };
  const trimmed = (name || "").trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (trimmed.length > 40) return { ok: false, reason: "too-long" };
  if (trimmed === folder.name) return { ok: true, reason: "unchanged" };
  const clash = newsFolders.some(
    f => f.id !== folderId && f.name.trim().toLowerCase() === trimmed.toLowerCase()
  );
  if (clash) return { ok: false, reason: "duplicate" };
  folder.name = trimmed;
  saveNewsFolders();
  return { ok: true, reason: "renamed" };
}

// Deletes a folder and cascades the removal into every saved article that
// referenced it. Articles stay saved — only the grouping disappears — so a
// delete can never lose the user's starred content.
function deleteFolder(folderId) {
  if (!folderId) return { ok: false, reason: "empty" };
  const idx = newsFolders.findIndex(f => f.id === folderId);
  if (idx < 0) return { ok: false, reason: "not-found" };
  const [removed] = newsFolders.splice(idx, 1);

  let touched = 0;
  savedNewsArticles.forEach(a => {
    if (!Array.isArray(a.folderIds)) return;
    const at = a.folderIds.indexOf(folderId);
    if (at >= 0) {
      a.folderIds.splice(at, 1);
      touched += 1;
    }
  });

  // Never leave the view filtered by a folder that no longer exists.
  if (activeFolderFilter === folderId) activeFolderFilter = null;

  saveNewsFolders();
  if (touched) saveNewsArticles();
  return { ok: true, reason: "deleted", name: removed ? removed.name : "", detached: touched };
}

function getArticleFolders(article) {
  const key = newsArticleKey(article);
  const saved = savedNewsArticles.find(s => newsArticleKey(s) === key);
  return saved ? (saved.folderIds || []) : [];
}

// Resolves the live article object (search results, saved, or feed) by key so
// menu/folder actions operate on the right copy.
function resolveArticleByKey(key) {
  if (searchActive) {
    const s = searchResultsData.find(x => newsArticleKey(x) === key);
    if (s) return s;
  }
  const saved = savedNewsArticles.find(x => newsArticleKey(x) === key);
  if (saved) return saved;
  return allArticles.find(x => newsArticleKey(x) === key) || null;
}

// Adds or removes an article from a folder. Ensures the article is saved first
// (so it shows in Saved Articles and can carry folderIds). Keeps the current
// view, the folder sidebar, and the card's star/folder state in sync.
function toggleArticleFolder(article, folderId) {
  const key = newsArticleKey(article);
  let saved = savedNewsArticles.find(s => newsArticleKey(s) === key);
  const wasSaved = !!saved;
  if (!saved) {
    savedNewsArticles.unshift({ ...article, savedAt: new Date().toISOString(), folderIds: [] });
    saved = savedNewsArticles[0];
  }
  saved.folderIds = saved.folderIds || [];
  const idx = saved.folderIds.indexOf(folderId);
  const folder = newsFolders.find(f => f.id === folderId);
  const folderName = folder ? folder.name : "folder";
  if (idx >= 0) {
    saved.folderIds.splice(idx, 1);
    showToast(`Removed from “${folderName}”.`);
  } else {
    saved.folderIds.push(folderId);
    showToast(wasSaved ? `Added to “${folderName}”.` : `Saved to “${folderName}”.`);
  }
  saveNewsArticles();

  if (searchActive) renderSearchResultsToFeed();
  else if (newsViewMode === "saved") renderSavedArticles();
  else renderNewsCards(allArticles, currentFilter);
  renderFoldersSidebar();
}

// Sidebar of folder chips shown only on the Saved Articles sub-tab.
function renderFoldersSidebar() {
  const sidebar = document.getElementById("foldersSidebar");
  if (!sidebar) return;
  if (newsViewMode !== "saved") {
    sidebar.style.display = "none";
    return;
  }
  sidebar.style.display = "flex";
  const folders = listFolders();
  const chips = [];
  // Portability toolbar (Option A): Export / Import the folder map + saved
  // articles. Manual cross-device move; no server round-trip.
  chips.push(
    `<div class="folder-toolbar">` +
      `<button class="folder-tool-btn" id="exportFoldersBtn" type="button">Export</button>` +
      `<button class="folder-tool-btn" id="importFoldersBtn" type="button">Import</button>` +
    `</div>`
  );
  chips.push(
    `<button class="folder-chip${activeFolderFilter === null ? " active" : ""}" data-folder-id="">All Saved <span class="folder-count">${savedNewsArticles.length}</span></button>`
  );
  folders.forEach(f => {
    const n = countArticlesInFolder(f.id);
    const isActive = activeFolderFilter === f.id;
    const id = escapeHtml(f.id);
    // User folders are wrapped so the filter button and the options control are
    // siblings — a nested button would be invalid HTML. "All Saved" and
    // "+ New folder" stay bare, which is what makes them un-deletable.
    chips.push(
      `<span class="folder-chip-wrap${isActive ? " active" : ""}">` +
        `<button class="folder-chip${isActive ? " active" : ""}" data-folder-id="${id}">${escapeHtml(f.name)} <span class="folder-count">${n}</span></button>` +
        `<button class="folder-chip-more" data-folder-menu-id="${id}" type="button" title="Rename or delete" aria-label="Options for folder ${escapeHtml(f.name)}">&#8943;</button>` +
      `</span>`
    );
  });
  chips.push(`<button class="folder-chip folder-new" id="newFolderChip" type="button">+ New folder</button>`);
  sidebar.innerHTML = chips.join("");
}

// ===== Thread D: Team Sources (shared, editor-curated evidence library) =====
// Sources an editor adds here become citable [T#] evidence in the Q&A lane.
function setupTeamSources() {
  const addBtn = document.getElementById("addTeamSourceBtn");
  if (addBtn) addBtn.addEventListener("click", addTeamSource);
  const urlInput = document.getElementById("teamSourceUrl");
  if (urlInput) urlInput.addEventListener("keydown", (e) => { if (e.key === "Enter") addTeamSource(); });
  const list = document.getElementById("teamSourcesList");
  if (list) {
    list.addEventListener("click", (e) => {
      const del = e.target.closest("[data-delete-id]");
      if (del) { e.preventDefault(); deleteTeamSource(del.dataset.deleteId); return; }
      const btn = e.target.closest("[data-refresh-id]");
      if (btn) { e.preventDefault(); refreshTeamSource(btn.dataset.refreshId); }
    });
  }
}

async function loadTeamSources() {
  const listEl = document.getElementById("teamSourcesList");
  const emptyEl = document.getElementById("teamSourcesEmpty");
  if (!listEl) return;
  try {
    const res = await fetch(`${API_BASE}/sources`);
    if (!res.ok) { listEl.innerHTML = ""; return; }
    const data = await res.json();
    const sourcesList = Array.isArray(data.sources) ? data.sources : [];
    existingTeamSourceUrls.clear();
    sourcesList.forEach((s) => { if (s && s.url) existingTeamSourceUrls.add(s.url); });
    if (!sourcesList.length) {
      listEl.innerHTML = "";
      if (emptyEl) emptyEl.style.display = "block";
      return;
    }
    if (emptyEl) emptyEl.style.display = "none";
    listEl.innerHTML = sourcesList.map(renderTeamSourceRow).join("");
  } catch (_) {
    listEl.innerHTML = "";
  }
}

function renderTeamSourceRow(s) {
  const id = escapeHtml(s.id);
  const title = escapeHtml(s.title || s.url || s.citationId || "Untitled");
  const url = safeHref(s.url);
  const citation = s.citationId ? `<span class="team-source-cite">[${escapeHtml(s.citationId)}]</span>` : "";
  const status = escapeHtml(s.status || "pending");
  // "unknown" is the server default when no editor name is supplied — hide it
  // rather than rendering a meaningless "· unknown" tag.
  const addedBy = (s.addedBy && s.addedBy !== "unknown") ? ` · ${escapeHtml(s.addedBy)}` : "";
  const refreshBtn = `<button class="team-source-refresh" data-refresh-id="${id}" type="button" title="Re-fetch and re-ingest">&#x21BB;</button>`;
  const delBtn = `<button class="team-source-delete" data-delete-id="${id}" type="button" title="Remove this source">&#10005;</button>`;
  return (
    `<div class="team-source-row">` +
      `<span class="team-source-status status-${escapeHtml(status)}">${status}</span>` +
      citation +
      `<a class="team-source-title-link" href="${url}" target="_blank" rel="noopener">${title}</a>` +
      `<span class="team-source-meta">${addedBy}</span>` +
      refreshBtn +
      delBtn +
    `</div>`
  );
}

async function addTeamSource() {
  const urlInput = document.getElementById("teamSourceUrl");
  const titleInput = document.getElementById("teamSourceTitle");
  const url = urlInput && urlInput.value ? urlInput.value.trim() : "";
  if (!url) { showToast("Enter a URL to add."); return; }
  const title = titleInput && titleInput.value ? titleInput.value.trim() : "";
  try {
    const res = await authedFetch(`${API_BASE}/sources`, {
      method: "POST",
      body: JSON.stringify({ kind: "url", url, title }),
    });
    if (res.status === 401) { showToast("Editor key required to add team sources."); return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "Failed to add source.");
      return;
    }
    if (urlInput) urlInput.value = "";
    if (titleInput) titleInput.value = "";
    showToast("Source added — ingesting in the background…");
    await loadTeamSources();
  } catch (_) {
    showToast("Network error adding source.");
  }
}

async function refreshTeamSource(id) {
  try {
    const res = await authedFetch(`${API_BASE}/sources/${encodeURIComponent(id)}/refresh`, { method: "POST" });
    if (res.status === 401) { showToast("Editor key required."); return; }
    showToast("Re-ingesting source…");
    await loadTeamSources();
  } catch (_) {
    showToast("Network error refreshing source.");
  }
}

async function deleteTeamSource(id) {
  try {
    const res = await authedFetch(`${API_BASE}/sources/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (res.status === 401) { showToast("Editor key required."); return; }
    if (!res.ok) { showToast("Failed to remove source."); return; }
    showToast("Source removed.");
    await loadTeamSources();
  } catch (_) {
    showToast("Network error removing source.");
  }
}

// Add a news article directly to Team Sources from its card. Reuses the exact
// same POST /api/sources call the URL paste-box makes — the article URL is the
// resolvable link (Google News redirect handled by the reader pipeline), so no
// server change is needed. Editor-gated via authedFetch (prompts for the key).
function setupNewsTeamSources() {
  const feed = document.getElementById("newsFeed");
  if (!feed) return;
  feed.addEventListener("click", (e) => {
    const btn = e.target.closest(".news-team-src-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    addNewsArticleToTeamSources(btn);
  });
}

async function addNewsArticleToTeamSources(btn) {
  const url = btn.dataset.url;
  const title = btn.dataset.title || "";
  const key = btn.dataset.articleKey || url;
  if (!url || url === "#") { showToast("This article has no link to add."); return; }
  if (addedToTeamSources.has(key)) { showToast("Already added to Team Sources."); return; }
  btn.disabled = true;
  try {
    const res = await authedFetch(`${API_BASE}/sources`, {
      method: "POST",
      body: JSON.stringify({ kind: "url", url, title }),
    });
    if (res.status === 401) { showToast("Editor key required to add team sources."); btn.disabled = false; return; }
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "Failed to add source.");
      btn.disabled = false;
      return;
    }
    addedToTeamSources.add(key);
    btn.classList.add("added");
    btn.innerHTML = "&#10003;";
    btn.title = "Already in Team Sources";
    showToast("Added to Team Sources — ingesting in background…");
  } catch (_) {
    showToast("Network error adding source.");
    btn.disabled = false;
  }
}

// ===== Option A: portable folder map (Export / Import) =====
// Serialises the two localStorage keys to a JSON file so a user can move their
// News+Search folders + saved articles between devices/browsers without a server.
function exportFolders() {
  const payload = {
    app: "gaming-competitive-intelligence",
    kind: "news-folders",
    version: 1,
    exportedAt: new Date().toISOString(),
    newsFolders: newsFolders,
    savedNewsArticles: savedNewsArticles,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  a.href = url;
  a.download = `news-folders-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  showToast("Folders exported.");
}

// Reads an exported file and MERGES it into the current local state:
//  - folders union by id (incoming name wins on id match so renames propagate);
//  - articles union by key, folderIds merged, most-recent savedAt kept;
//  - dangling folderIds (not in the merged folder list) are pruned.
function importFolders(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!data || data.kind !== "news-folders" ||
          !Array.isArray(data.newsFolders) || !Array.isArray(data.savedNewsArticles)) {
        showToast("That file is not a valid folders export.");
        return;
      }
      const byId = new Map(newsFolders.map(f => [f.id, f]));
      let addedFolders = 0, updatedFolders = 0;
      for (const f of data.newsFolders) {
        if (!f || typeof f.id !== "string" || typeof f.name !== "string") continue;
        const existing = byId.get(f.id);
        if (existing) {
          if (existing.name !== f.name) { existing.name = f.name; updatedFolders++; }
        } else {
          newsFolders.push({ id: f.id, name: f.name, createdAt: f.createdAt || new Date().toISOString() });
          addedFolders++;
        }
      }
      const validIds = new Set(newsFolders.map(f => f.id));
      const byKey = new Map(savedNewsArticles.map(a => [newsArticleKey(a), a]));
      let addedArticles = 0, mergedArticles = 0;
      for (const inc of data.savedNewsArticles) {
        if (!inc || typeof inc !== "object") continue;
        const key = newsArticleKey(inc);
        if (!key) continue;
        const incFolders = Array.isArray(inc.folderIds) ? inc.folderIds : [];
        const existing = byKey.get(key);
        if (existing) {
          const merged = new Set([...(existing.folderIds || []), ...incFolders]);
          existing.folderIds = [...merged].filter(id => validIds.has(id));
          if (inc.savedAt && (!existing.savedAt || inc.savedAt > existing.savedAt)) existing.savedAt = inc.savedAt;
          mergedArticles++;
        } else {
          savedNewsArticles.push({ ...inc, folderIds: incFolders.filter(id => validIds.has(id)) });
          addedArticles++;
        }
      }
      saveNewsFolders();
      saveNewsArticles();
      renderFoldersSidebar();
      renderSavedArticles();
      showToast(`Imported: ${addedFolders} new / ${updatedFolders} updated folder(s), ${addedArticles} new / ${mergedArticles} updated article(s).`);
    } catch (err) {
      showToast("Could not read that file: " + err.message);
    }
  };
  reader.onerror = () => showToast("Could not read that file.");
  reader.readAsText(file);
}

function openFolderMenu(anchorBtn, articleKey) {
  closeFolderMenu();
  const article = resolveArticleByKey(articleKey);
  const inFolders = getArticleFolders(article || {});
  const folders = listFolders();
  const items = folders.length
    ? folders.map(f => {
        const checked = inFolders.includes(f.id);
        return `<label class="folder-menu-item">
          <input type="checkbox" data-folder-id="${escapeHtml(f.id)}"${checked ? " checked" : ""}>
          <span>${escapeHtml(f.name)}</span>
        </label>`;
      }).join("")
    : `<div class="folder-menu-empty">No folders yet — create one below.</div>`;

  const menu = document.createElement("div");
  menu.id = "folderMenu";
  menu.className = "folder-menu";
  menu.dataset.articleKey = articleKey;
  menu.innerHTML = `
    <div class="folder-menu-title">Save to folder</div>
    <div class="folder-menu-list">${items}</div>
    <div class="folder-menu-new">
      <input type="text" id="folderMenuNewInput" class="text-input" placeholder="New folder name" maxlength="40" />
      <button class="btn btn-sm btn-primary" id="folderMenuNewBtn" type="button">Add</button>
    </div>`;
  document.body.appendChild(menu);

  // Position below the anchor, clamped to the viewport.
  const rect = anchorBtn.getBoundingClientRect();
  const menuW = 230;
  const vw = document.documentElement.clientWidth;
  let left = window.scrollX + rect.left;
  if (left + menuW > window.scrollX + vw - 8) {
    left = window.scrollX + Math.max(8, vw - menuW - 8);
  }
  menu.style.left = left + "px";
  menu.style.top = window.scrollY + rect.bottom + 4 + "px";
  menu.style.width = menuW + "px";

  menu.addEventListener("click", (e) => {
    const cb = e.target.closest('input[type="checkbox"][data-folder-id]');
    if (cb) {
      const art = resolveArticleByKey(menu.dataset.articleKey);
      if (art) toggleArticleFolder(art, cb.dataset.folderId);
      return;
    }
    if (e.target.closest("#folderMenuNewBtn")) {
      const input = menu.querySelector("#folderMenuNewInput");
      const name = input.value.trim();
      if (!name) { input.focus(); return; }
      const folder = createFolder(name);
      if (folder) {
        const art = resolveArticleByKey(menu.dataset.articleKey);
        if (art) toggleArticleFolder(art, folder.id); // assign to the new folder
        openFolderMenu(anchorBtn, menu.dataset.articleKey); // re-open with the new folder checked
      }
      return;
    }
    e.stopPropagation();
  });

  const input = menu.querySelector("#folderMenuNewInput");
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); menu.querySelector("#folderMenuNewBtn")?.click(); }
    else if (e.key === "Escape") closeFolderMenu();
  });
}

function closeFolderMenu() {
  document.getElementById("folderMenu")?.remove();
}

function closeFolderActionMenu() {
  document.getElementById("folderActionMenu")?.remove();
}

// Small popover on a folder chip's "⋯" control offering Rename / Delete.
// Purely local: both actions mutate localStorage only, no server round-trip.
function openFolderActionMenu(anchorBtn, folderId) {
  closeFolderActionMenu();
  closeFolderMenu();
  const folder = newsFolders.find(f => f.id === folderId);
  if (!folder) return;
  const count = countArticlesInFolder(folderId);

  const menu = document.createElement("div");
  menu.id = "folderActionMenu";
  menu.className = "folder-menu folder-action-menu";
  menu.dataset.folderId = folderId;
  menu.innerHTML = `
    <div class="folder-menu-title">${escapeHtml(folder.name)}</div>
    <div class="folder-menu-list">
      <button class="folder-action-item" data-action="rename" type="button">Rename folder</button>
      <button class="folder-action-item danger" data-action="delete" type="button">Delete folder</button>
    </div>
    <div class="folder-action-note">${count} saved article${count === 1 ? "" : "s"} — deleting the folder keeps them saved.</div>`;
  document.body.appendChild(menu);

  // Position below the anchor, clamped to the viewport.
  const rect = anchorBtn.getBoundingClientRect();
  const menuW = 230;
  const vw = document.documentElement.clientWidth;
  let left = window.scrollX + rect.left;
  if (left + menuW > window.scrollX + vw - 8) {
    left = window.scrollX + Math.max(8, vw - menuW - 8);
  }
  menu.style.left = left + "px";
  menu.style.top = window.scrollY + rect.bottom + 4 + "px";
  menu.style.width = menuW + "px";

  menu.addEventListener("click", (e) => {
    const action = e.target.closest(".folder-action-item")?.dataset.action;
    if (!action) { e.stopPropagation(); return; }
    const id = menu.dataset.folderId;
    const target = newsFolders.find(f => f.id === id);
    if (!target) { closeFolderActionMenu(); return; }

    if (action === "rename") {
      closeFolderActionMenu();
      const input = window.prompt("Rename folder:", target.name);
      if (input === null) return; // cancelled
      const res = renameFolder(id, input);
      if (res.ok) {
        if (res.reason === "renamed") showToast(`Folder renamed to “${input.trim()}”.`);
        renderFoldersSidebar();
      } else if (res.reason === "duplicate") {
        showToast("A folder with that name already exists.");
      } else if (res.reason === "too-long") {
        showToast("Folder names are limited to 40 characters.");
      } else if (res.reason === "empty") {
        showToast("Folder name cannot be empty.");
      }
      return;
    }

    if (action === "delete") {
      closeFolderActionMenu();
      const n = countArticlesInFolder(id);
      const warn = n
        ? `Delete “${target.name}”?\n\n${n} saved article${n === 1 ? "" : "s"} will stay saved under All Saved — only the folder grouping is removed.`
        : `Delete “${target.name}”?`;
      if (!window.confirm(warn)) return;
      const res = deleteFolder(id);
      if (res.ok) {
        showToast(`Folder “${res.name}” deleted.`);
        renderSavedArticles(); // re-renders cards + sidebar with the filter reset
      }
    }
  });
}

// Wires the card "Save to folder" menu and the Saved-Articles folder sidebar.
function setupFolderUI() {
  const feed = document.getElementById("newsFeed");
  feed?.addEventListener("click", (e) => {
    const btn = e.target.closest(".news-folder-btn");
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const key = decodeURIComponent(btn.dataset.articleKey || "");
    openFolderMenu(btn, key);
  });

  // Close the menu when clicking anywhere outside it (the feed handler stops
  // propagation on open, so the opening click won't close it immediately).
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("folderMenu");
    if (menu && !e.target.closest(".news-folder-btn") && !menu.contains(e.target)) {
      closeFolderMenu();
    }
    const actionMenu = document.getElementById("folderActionMenu");
    if (actionMenu && !e.target.closest(".folder-chip-more") && !actionMenu.contains(e.target)) {
      closeFolderActionMenu();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeFolderActionMenu();
  });

  const sidebar = document.getElementById("foldersSidebar");
  sidebar?.addEventListener("click", (e) => {
    // Portability toolbar (Option A) — handled before the chip logic below.
    const exp = e.target.closest("#exportFoldersBtn");
    if (exp) { e.preventDefault(); exportFolders(); return; }
    const imp = e.target.closest("#importFoldersBtn");
    if (imp) { e.preventDefault(); document.getElementById("folderImportInput")?.click(); return; }

    // Options control first — it sits beside the chip, not inside it.
    const more = e.target.closest(".folder-chip-more");
    if (more) {
      e.preventDefault();
      e.stopPropagation();
      openFolderActionMenu(more, more.dataset.folderMenuId || "");
      return;
    }

    const chip = e.target.closest(".folder-chip");
    if (!chip) return;
    closeFolderActionMenu();
    if (chip.id === "newFolderChip") {
      const name = window.prompt("New folder name:");
      if (name && name.trim()) {
        createFolder(name.trim());
        renderFoldersSidebar();
      }
      return;
    }
    const id = chip.dataset.folderId || null;
    activeFolderFilter = id === "" ? null : id;
    renderFoldersSidebar();
    renderSavedArticles();
  });

  // Option A: import the folder map + saved articles from an exported JSON file.
  const importInput = document.getElementById("folderImportInput");
  importInput?.addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) importFolders(file);
    e.target.value = ""; // allow re-importing the same file
  });
}

function renderSavedArticles() {
  let list = savedNewsArticles;
  if (activeFolderFilter) {
    list = list.filter(a => (a.folderIds || []).includes(activeFolderFilter));
  }
  renderNewsCards(list, null, true);
  renderFoldersSidebar();
}

function hostOf(url) {
  try { return new URL(String(url || "")).hostname.replace(/^www\./i, ""); } catch (_) { return ""; }
}

// Shared card markup so News feed, Saved, and Search results all render
// identically and stay star/save-able via the same favorite handler.
function newsCardHtml(a, i, saved) {
  const safeUrl = /^https?:\/\//i.test(a.url || "") ? a.url : "#";
  const sourceBits = [];
  if (a.sourceName) {
    sourceBits.push(a.sourceName);
  } else if (safeUrl !== "#") {
    // Fall back to the article's host, not the full URL (the title is the
    // link already, so repeating the raw URL wastes space on the card).
    sourceBits.push(hostOf(a.url));
  }
  if (a.publishedAt) {
    sourceBits.push(new Date(a.publishedAt).toLocaleDateString(undefined, {
      year: "numeric", month: "short", day: "numeric"
    }));
  }
  const sourceLine = sourceBits.filter(Boolean).join(" · ");
  const articleKey = encodeURIComponent(newsArticleKey(a));
  const inFolders = getArticleFolders(a).length > 0;

  // "Add to Team Sources" affordance — mirrors the URL paste box but fires
  // straight from the card. Deduped against in-session adds + existing sources.
  const teamKey = a.url || "";
  const inTeam = !!teamKey && (addedToTeamSources.has(teamKey) || existingTeamSourceUrls.has(teamKey));
  const canAddTeam = safeUrl !== "#";
  const teamBtn = `<button class="news-team-src-btn${inTeam ? " added" : ""}" data-url="${escapeHtml(safeUrl)}" data-title="${escapeHtml(a.title || "")}" data-article-key="${escapeHtml(teamKey)}" type="button" ${canAddTeam ? "" : "disabled "}aria-label="Add to Team Sources" title="${inTeam ? "Already in Team Sources" : (canAddTeam ? "Add to Team Sources" : "No link to add")}">${inTeam ? "&#10003;" : "&#43;"}</button>`;

  return `
    <div class="news-card${saved ? " is-saved" : ""}" data-index="${i}">
      <div class="news-card-header">
        <div class="news-title">
          <a href="${escapeHtml(safeUrl)}" target="_blank" rel="noopener">${escapeHtml(a.title || "Untitled")}</a>
        </div>
        <div class="news-card-actions">
          <button class="news-folder-btn${inFolders ? " active" : ""}" data-article-key="${escapeHtml(articleKey)}" aria-label="Save to folder" title="Save to folder">&#128193;<span class="news-folder-caret">&#9662;</span></button>
          <button class="news-favorite-btn${saved ? " active" : ""}" data-article-key="${escapeHtml(articleKey)}" aria-label="${saved ? "Remove from saved articles" : "Save article for later"}" title="${saved ? "Remove from saved articles" : "Save article for later"}">${saved ? "&#9733;" : "&#9734;"}</button>
          ${teamBtn}
        </div>
      </div>
      <div class="news-tag-row">
        <span class="news-tag">${escapeHtml((a.competitorKeyword || "News").replace(/ Tencent 2026/i, ""))}</span>
      </div>
      <p class="news-source">${escapeHtml(sourceLine)}</p>
      <p class="news-description">${escapeHtml(trimDescription(a.subhead || a.description))}</p>
    </div>`;
}

function renderNewsCards(articles, filter, savedView = false) {
  currentFilter = savedView ? null : filter;

  const feed = document.getElementById("newsFeed");

  const filtered = filter
    ? articles.filter((a) => a.competitorKeyword === filter)
    : articles;

  if (!filtered.length) {
    if (savedView) {
      feed.innerHTML = activeFolderFilter
        ? '<div class="empty-state"><div class="empty-icon">&#128193;</div><p>This folder is empty.</p><p>Open an article’s “Save to folder” menu to add it here.</p></div>'
        : '<div class="empty-state"><div class="empty-icon">&#9734;</div><p>No saved articles yet.</p><p>Star an article in Recent News &amp; Updates — or use “Save to folder” — to keep it here for later.</p></div>';
    } else {
      feed.innerHTML = '<div class="empty-state"><p>No articles match this filter</p></div>';
    }
    return;
  }

  feed.innerHTML = filtered.map((a, i) => newsCardHtml(a, i, isNewsArticleSaved(a))).join("");

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
// Search results are rendered into the main article feed (newsFeed) so the
// visible list the user is watching actually updates to match the query, with
// a banner + "Return to Default" button to return to the live feed.
let searchResultsData = [];
let searchActive = false;
let activeSearchQuery = "";

async function doSearch() {
  const input = document.getElementById("searchInput");
  const query = input.value.trim();
  if (!query) return;

  const limit = parseInt(document.getElementById("searchLimit").value);
  const feed = document.getElementById("newsFeed");

  searchActive = true;
  activeSearchQuery = query;
  showSearchBanner(query);
  feed.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Searching the web for “${escapeHtml(query)}”…</p></div>`;

  try {
    const res = await fetch(`${API_BASE}/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, limit }),
    });

    const data = await res.json();

    if (!data.success) {
      searchResultsData = [];
      feed.innerHTML = `<div class="empty-state"><p>${escapeHtml(data.error || "Search failed")}</p></div>`;
      return;
    }

    const results = (data.data || []).map(result => ({
      url: result.url,
      title: result.title || "Untitled",
      description: result.description || "",
      sourceName: hostOf(result.url),
    }));

    searchResultsData = results;
    renderSearchResultsToFeed();
  } catch (err) {
    searchResultsData = [];
    feed.innerHTML = `<div class="empty-state"><p>Error: ${escapeHtml(err.message)}</p></div>`;
  }
}

function showSearchBanner(query) {
  const banner = document.getElementById("searchBanner");
  const text = document.getElementById("searchBannerText");
  if (!banner || !text) return;
  text.textContent = `Showing web results for “${query}”`;
  banner.style.display = "flex";
}

function hideSearchBanner() {
  const banner = document.getElementById("searchBanner");
  if (banner) banner.style.display = "none";
}

function renderSearchResultsToFeed() {
  const feed = document.getElementById("newsFeed");
  if (!feed) return;
  if (!searchResultsData.length) {
    feed.innerHTML = '<div class="empty-state"><p>No results found. Try a different query.</p></div>';
    return;
  }
  feed.innerHTML = searchResultsData.map((a, i) => newsCardHtml(a, i, isNewsArticleSaved(a))).join("");
}

function clearSearch() {
  searchActive = false;
  activeSearchQuery = "";
  searchResultsData = [];
  hideSearchBanner();
  if (newsViewMode === "saved") renderSavedArticles();
  else renderNewsCards(allArticles, currentFilter);
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
    html += `<button class="kb-cat-btn${active}" data-cat="${key}">${cat.icon ? cat.icon + " " : ""}${cat.label}</button>`;
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
    content.innerHTML = '<div class="kb-no-results"><p>No matching content found</p></div>';
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
        ${cat.icon ? '<span style="font-size:1.2rem;">' + cat.icon + '</span>' : ""}
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
    container.innerHTML = `<div class="empty-state"><p>Error: ${err.message}</p></div>`;
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
    const count = data.competitors.filter(comp => comp.sectors.includes(key)).length;
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
  const visibleCompetitors = data.competitors.filter(comp => comp.sectors.some(s => !spiderViewState.hiddenSectors.has(s)));
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
    const radius = isCenter ? 34 : node.sectors.length >= 3 ? 21 : node.sectors.length >= 2 ? 18 : 16;
    const nodeParts = [];

    if (!isCenter) {
      // Every node (single- and multi-sector) gets a ring of its visible
      // sector colours. Hiding a sector removes its colour from the ring
      // (e.g. hiding "Platform / Distribution" leaves Valve's ring blue-only
      // — a full ring of the one remaining colour). The node is only rendered
      // here if at least one sector is visible, so ringColors is never empty.
      const ringColors = node.sectors
        .filter(s => !spiderViewState.hiddenSectors.has(s))
        .map(item => sectorColors[item]?.color || "#94a3b8");
      const circumference = 2 * Math.PI * (radius + 4);
      const segment = circumference / ringColors.length;
      ringColors.forEach((color, colorIndex) => {
        nodeParts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${radius + 4}" fill="none" stroke="${color}" stroke-width="3" stroke-dasharray="${segment} ${circumference - segment}" stroke-dashoffset="${-colorIndex * segment}" opacity="0.85"/>`);
      });
    }

    nodeParts.push(`<circle cx="${pos.x}" cy="${pos.y}" r="${radius}" fill="#1e293b" stroke="#fff" stroke-width="3" class="spider-node" style="filter:url(#nodeShadow)">
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
    html += `<a href="${node.url}" target="_blank" rel="noopener" class="spider-detail-link">${domain}</a>`;
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
      grid.innerHTML = `<div class="empty-state"><p>Failed to load: ${err.message}</p></div>`;
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
    grid.innerHTML = `<div class="empty-state"><p>Failed to load: ${err.message}</p></div>`;
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
      <h3>${ctx.title}</h3>
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
        ${trend.icon ? '<span class="trend-card-icon">' + trend.icon + '</span>' : ""}
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
            Search for latest
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
        btn.innerHTML = "Search for latest";

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
        btn.innerHTML = "Search for latest";
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
          <span class="timeline-badge ${badgeClass}">${e.category === "Critical Deadline" ? '<span class="sev-dot sev-critical"></span>Critical' : e.jurisdiction}</span>
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

// ===== Item 3: expandable count-stat cards (view-only detail lists) =====
const STAT_EXPAND = {
  useCasesGameCount: () => (currentUseCasesData?.games || []).map(g => g.game),
  useCasesCompanyCount: () => [...new Set((currentUseCasesData?.games || []).map(g => g.developer))].sort(),
  useCasesGenerativeCount: () => (currentUseCasesData?.games || [])
    .filter(g => /machine learning|generative/i.test(g.aiClass)).map(g => g.game),
  risksCategoryCount: () => Object.values(risksData?.categories || {}).map(c => c.title),
  risksTotalCount: () => Object.values(risksData?.categories || {})
    .flatMap(c => c.risks.map(r => r.title)),
  risksCriticalCount: () => Object.values(risksData?.categories || {})
    .flatMap(c => c.risks.filter(r => r.severity === "critical").map(r => r.title)),
  risksCompaniesCount: () => {
    const set = new Set();
    Object.values(risksData?.categories || {}).forEach(c =>
      c.risks.forEach(r => (r.affectedCompanies || []).forEach(x => set.add(x))));
    return [...set];
  },
};

function toggleStatExpand(card) {
  const ul = card.querySelector(".stat-expand-list");
  if (!ul) return;
  const expanded = card.classList.toggle("expanded");
  card.setAttribute("aria-expanded", expanded ? "true" : "false");
  ul.setAttribute("aria-hidden", expanded ? "false" : "true");
  if (expanded && ul.childElementCount === 0) {
    const items = STAT_EXPAND[card.dataset.statKey]?.() || [];
    ul.innerHTML = items.length
      ? items.map(i => `<li>${escapeHtml(i)}</li>`).join("")
      : '<li class="stat-expand-empty">No items to list</li>';
  }
}

let statExpandReady = false;
let statExpandGlobalBound = false;
function setupStatExpand() {
  if (statExpandReady) return;
  statExpandReady = true;
  Object.keys(STAT_EXPAND).forEach(key => {
    const val = document.getElementById(key);
    if (!val) return;
    const card = val.closest(".stat-card");
    if (!card || card.dataset.statReady) return;
    card.dataset.statReady = "1";
    card.dataset.statKey = key;
    card.classList.add("expandable");
    card.setAttribute("tabindex", "0");
    card.setAttribute("role", "button");
    card.setAttribute("aria-expanded", "false");
    const label = card.querySelector(".stat-label");
    if (label && !label.querySelector(".stat-expand-cue")) {
      const cue = document.createElement("span");
      cue.className = "stat-expand-cue";
      cue.textContent = " ⌄";
      label.appendChild(cue);
    }
    if (!card.querySelector(".stat-expand-list")) {
      const ul = document.createElement("ul");
      ul.className = "stat-expand-list";
      ul.setAttribute("aria-hidden", "true");
      card.appendChild(ul);
    }
    card.addEventListener("click", (e) => { e.stopPropagation(); toggleStatExpand(card); });
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleStatExpand(card); }
    });
  });
  if (!statExpandGlobalBound) {
    statExpandGlobalBound = true;
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".stat-card.expandable")) closeAllStatExpand();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeAllStatExpand();
    });
  }
}
function closeAllStatExpand() {
  document.querySelectorAll(".stat-card.expanded").forEach(c => {
    c.classList.remove("expanded");
    c.setAttribute("aria-expanded", "false");
    c.querySelector(".stat-expand-list")?.setAttribute("aria-hidden", "true");
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
          ${cat.icon ? '<span class="risk-category-icon">' + cat.icon + '</span>' : ""}
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
                ${r.kbCrossReference ? `<span class="risk-xref">KB: ${r.kbCrossReference}</span>` : ""}
              </div>
            </div>`;
          }).join("")}
        </div>
      </div>`;
  });

  categoriesEl.innerHTML = catHtml || '<div class="empty-state"><p>No risks match the selected filter</p></div>';
}

// ===== Live news stream (Thread B) =====
// One SSE connection per tab to /api/news/stream. On a `news-updated` event we
// reveal a "New updates" pill; if the News view is already open we silently
// ===== News live stream (Thread B) =====
// Subscribes to server-pushed news updates so the feed feels live. There is a
// single Refresh control; an unseen-update badge appears on it when new content
// lands while the user is looking elsewhere. No decorative emoji — line-glyph
// controls only (PR #46 convention).
function setupNewsStream() {
  if (newsEventSource || typeof EventSource === "undefined") return;
  const badge = document.getElementById("newsLiveBadge");

  function renderBadge() {
    if (!badge) return;
    if (newsUnseenCount > 0) {
      badge.hidden = false;
      badge.textContent = newsUnseenCount > 9 ? "9+" : String(newsUnseenCount);
      badge.title = newsUnseenCount + " new article" + (newsUnseenCount === 1 ? "" : "s") + " since you last looked";
    } else {
      badge.hidden = true;
      badge.textContent = "";
      badge.title = "";
    }
  }

  newsEventSource = new EventSource(`${API_BASE}/news/stream`);
  newsEventSource.addEventListener("news-updated", () => {
    newsUnseenCount += 1;
    const newsView = document.getElementById("news-view");
    if (newsView && newsView.classList.contains("active")) {
      // Already looking at the feed — refresh in place and clear the badge.
      loadNews();
      newsUnseenCount = 0;
    }
    renderBadge();
  });
  newsEventSource.onerror = () => {
    // Browser auto-reconnects on transient drops; nothing to do here.
  };
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
    const readBtn = e.target.closest("[data-read]");
    if (readBtn) {
      const card = readBtn.closest(".proposal-card");
      const url = card && card.getAttribute("data-url");
      if (url) { await openReaderSplit(card, url); return; }
    }
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
      const card = integrateBtn.closest(".proposal-card");
      if (card) await integrateProposalCard(card);
    }
  });

  // Split-screen reader controls (inside #readerSplitView).
  const split = document.getElementById("readerSplitView");
  if (split) {
    split.addEventListener("click", async (e) => {
      const back = e.target.closest("#readerBack");
      const save = e.target.closest("#readerSave");
      const integrate = e.target.closest("#readerIntegrate");
      if (back) { await closeReaderSplit(false); return; }
      if (save) { await closeReaderSplit(true); return; }
      if (integrate) {
        const id = split.dataset.cardId;
        const listEl2 = document.getElementById("reviewPanelList");
        const card = id && listEl2 ? listEl2.querySelector(`.proposal-card[data-id="${CSS.escape(id)}"]`) : null;
        if (card) { await applyReaderSummaryToCard(); await integrateProposalCard(card); }
        await closeReaderSplit(false);
      }
    });
  }
}

// Integrate a proposal card into the curated dataset, reading the (optionally
// edited) summary straight from the card's `.proposal-edit-box`. Shared by the
// card's own Integrate button and the split-screen reader's Integrate action.
async function integrateProposalCard(card) {
  const id = card.getAttribute("data-id");
  if (!id) return;
  const integrateBtn = card.querySelector("[data-integrate]");
  const editBox = card.querySelector(".proposal-edit-box");
  const targetSel = card.querySelector(".proposal-target");
  const catKey = card.querySelector(".proposal-catkey");
  const body = { edit: editBox ? editBox.value : "" };
  if (targetSel && targetSel.value) body.targetDataset = targetSel.value;
  if (catKey && catKey.value) body.targetCategoryKey = catKey.value;
  if (integrateBtn) integrateBtn.disabled = true;
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
      if (integrateBtn) integrateBtn.disabled = false;
      showToast("Could not integrate that change.", "error");
    }
  } catch (_) {
    if (integrateBtn) integrateBtn.disabled = false;
  }
}

// Open the split-screen reader for a proposal: fetch the source article via the
// hardened /api/reader endpoint and render it as TEXT ONLY (never innerHTML, so
// there is no XSS surface). The right pane is the summary editor; its contents
// are written back to the card on Save / Integrate.
async function openReaderSplit(card, url) {
  const split = document.getElementById("readerSplitView");
  const listEl = document.getElementById("reviewPanelList");
  const summaryBox = document.getElementById("readerSummary");
  const articleEl = document.getElementById("readerArticle");
  const statusEl = document.getElementById("readerStatus");
  const origLink = document.getElementById("readerOriginalLink");
  const manualEl = document.getElementById("readerManualEntry");
  if (!split || !summaryBox || !articleEl || !listEl) return;

  let editBox = card.querySelector(".proposal-edit-box");
  if (!editBox) {
    // Blocked / no-preview cards have no editor yet — create a hidden one so a
    // manually written summary can still be integrated.
    editBox = document.createElement("textarea");
    editBox.className = "proposal-edit-box text-input";
    editBox.style.display = "none";
    card.appendChild(editBox);
  }
  const summaryText = card.querySelector(".proposal-summary-text");
  summaryBox.value = editBox.value || (summaryText && summaryText.textContent) || "";
  articleEl.textContent = "";
  articleEl.dataset.partial = "";
  if (manualEl) {
    manualEl.style.display = "none";
    const ui = document.getElementById("readerManualUrl");
    const ti = document.getElementById("readerManualText");
    if (ui) ui.value = "";
    if (ti) ti.value = "";
  }
  if (statusEl) { statusEl.style.display = "none"; statusEl.textContent = ""; statusEl.classList.remove("reader-status-error"); }
  if (origLink) origLink.href = url;
  split.dataset.cardId = card.getAttribute("data-id") || "";
  listEl.style.display = "none";
  split.style.display = "flex";
  if (statusEl) { statusEl.textContent = "Resolving source & loading article…"; statusEl.style.display = "block"; }

  // Pass the article title + publisher so the server can resolve news.google.com
  // redirect URLs to the real publisher (the landing page has no article body).
  const titleEl = card.querySelector(".proposal-title");
  const sourceEl = card.querySelector(".proposal-source");
  const title = titleEl ? titleEl.textContent.trim() : "";
  const rawDomain = sourceEl ? sourceEl.textContent.trim() : "";
  // Only pass a real domain (one containing a dot). Publisher names like
  // "Reuters" are not domains and would make source resolution fail; the
  // server resolves by article title in that case.
  const domain = rawDomain.includes(".") ? rawDomain : "";
  // The human-readable publisher name (e.g. "Reuters") is surfaced as the
  // reader credit so it never shows the Google News aggregator host.
  const publisher = rawDomain;
  const cardId = card.getAttribute("data-id") || "";
  const qs = `url=${encodeURIComponent(url)}&title=${encodeURIComponent(title)}&domain=${encodeURIComponent(domain)}&publisher=${encodeURIComponent(publisher)}&id=${encodeURIComponent(cardId)}`;

  split.dataset.readerUrl = url;
  split.dataset.cardId = cardId;
  split.dataset.readerPublisher = publisher;
  const badge = document.getElementById("readerStoreBadge");
  if (badge) badge.style.display = "none";
  const licBadge = document.getElementById("readerLicenseBadge");
  if (licBadge) licBadge.style.display = "none";
  const attr = document.getElementById("readerAttribution");
  if (attr) { attr.style.display = "none"; attr.innerHTML = ""; }

  await loadReaderUrl(`${API_BASE}/reader?${qs}`, articleEl, statusEl, manualEl);
  bindReaderManualEntry();
  bindReaderRefresh();
}

// Fetch a reader URL and render the result. On a Google News link that the
// server cannot resolve, switch the article pane to manual entry (Option D)
// instead of showing a dead-end error.
async function loadReaderUrl(targetUrl, articleEl, statusEl, manualEl) {
  try {
    const res = await fetch(targetUrl);
    if (!res.ok) {
      const errJson = await res.json().catch(() => ({}));
      if (/Google News link/i.test(errJson.error || "") && manualEl) {
        showReaderManualEntry(manualEl, statusEl);
        return;
      }
      if (statusEl) {
        statusEl.textContent = (errJson.error || "Could not load this article. Use “Open original” to read it.");
        statusEl.style.display = "block";
        statusEl.classList.add("reader-status-error");
      }
      return;
    }
    const data = await res.json();
    // Surface a generated AI summary in the reader's summary pane (right side)
    // whenever the server provides one — covers the manual paste-URL path.
    const summaryBox = document.getElementById("readerSummary");
    if (summaryBox && data.styledSummary) summaryBox.value = data.styledSummary;
    // Phase 4 — licence gate surfacing. If the gate withheld the full text
    // (restricted class), show the honest "metadata only" notice and stop — we
    // never expose full text for restricted sources. Otherwise render the
    // source + license-class badge and mandatory credit line.
    if (data.gated && data.gateReason === "restricted") {
      renderReaderAttribution(data);
      showReaderRestrictedNotice(articleEl, statusEl);
      return;
    }
    renderReaderAttribution(data);
    // Phase 3 — store viewer: the server returned stored content without a live
    // fetch. Render it directly and surface the retention state.
    if (data.fromStore) {
      showReaderStoreBadge(data.retentionState);
      articleEl.dataset.partial = "";
      articleEl.textContent = data.text && data.text.trim()
        ? data.text
        : "(No readable text could be extracted from this page.)";
      if (statusEl) {
        if (data.retentionState === "excerpt") {
          statusEl.textContent = "Stored excerpt — full text rolled to a 300-word excerpt per the retention policy. Use “Refresh from source” for the live article.";
          statusEl.style.display = "block";
          statusEl.classList.remove("reader-status-error");
        } else {
          statusEl.style.display = "none";
          statusEl.classList.remove("reader-status-error");
        }
      }
      return;
    }
    // Server exhausted every resolver AND the Google News viewer fallback: offer
    // the user a way to supply the URL / full text themselves.
    if (data.unresolved) {
      if (manualEl) showReaderManualEntry(manualEl, statusEl);
      else if (statusEl) { statusEl.textContent = data.message || "Could not load this article."; statusEl.style.display = "block"; }
      return;
    }
    if (statusEl) { statusEl.style.display = "none"; statusEl.classList.remove("reader-status-error"); }
    articleEl.dataset.partial = data.partial ? "1" : "";
    articleEl.textContent = data.text && data.text.trim()
      ? data.text
      : "(No readable text could be extracted from this page.)";
    if (data.partial) {
      // Honest, non-intrusive note that this is a partial preview, not the full article.
      if (statusEl) {
        statusEl.textContent = "Retrieved a partial preview from Google News (headline + summary only). Open the original for the full article.";
        statusEl.style.display = "block";
        statusEl.classList.remove("reader-status-error");
      }
    }
  } catch (_) {
    if (statusEl) {
      statusEl.textContent = "Could not load this article. Use “Open original” to read it.";
      statusEl.style.display = "block";
      statusEl.classList.add("reader-status-error");
    }
  }
}

function showReaderManualEntry(manualEl, statusEl) {
  if (statusEl) { statusEl.style.display = "none"; statusEl.classList.remove("reader-status-error"); }
  manualEl.style.display = "block";
}

// Toggle the "stored copy" badge in the article pane header. Only non-full
// retention states (excerpt) get a visible label; "full" is the default.
function showReaderStoreBadge(state) {
  const badge = document.getElementById("readerStoreBadge");
  if (!badge) return;
  if (!state || state === "full") { badge.style.display = "none"; return; }
  badge.style.display = "inline-block";
  badge.textContent = state === "excerpt" ? "Stored · excerpt" : "Stored";
}

// Phase 4 — attribution UI. Mirror of LICENSE_LABELS in lib/licenseGate.js so
// the reader badge matches the server's governance classes.
const READER_LICENSE_LABELS = {
  "open": "Open",
  "news-fair-use": "News · fair use",
  "api-restricted": "API-restricted",
  "restricted": "Restricted",
};

function safeHttpUrl(u) {
  if (typeof u !== "string") return "";
  return /^https?:\/\//i.test(u) ? u : "";
}

// Render the source + license-class badge and the mandatory credit line from a
// gated /api/reader response. Builds DOM nodes (never innerHTML of untrusted
// data) so external source URLs cannot inject markup.
function renderReaderAttribution(data) {
  const badge = document.getElementById("readerLicenseBadge");
  const credit = document.getElementById("readerAttribution");
  if (!badge) return;
  const cls = (data && (data.licenseClass || (data.attribution && data.attribution.licenseClass))) || "open";
  badge.style.display = "inline-block";
  badge.dataset.cls = cls;
  badge.textContent = READER_LICENSE_LABELS[cls] || cls;
  if (!credit) return;
  const a = (data && data.attribution) || {};
  credit.innerHTML = "";
  if (!(a.title || a.source || a.url)) { credit.style.display = "none"; return; }
  credit.style.display = "block";
  const prefix = document.createElement("span");
  prefix.className = "reader-credit-prefix";
  prefix.textContent = "Source: ";
  credit.appendChild(prefix);
  const url = safeHttpUrl(a.url);
  if (url) {
    const link = document.createElement("a");
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = a.source || a.title || a.url;
    link.title = a.url;
    credit.appendChild(link);
  } else {
    const txt = document.createElement("span");
    txt.textContent = a.source || a.title || "";
    credit.appendChild(txt);
  }
  if (a.retrievedAt) {
    try {
      const when = document.createElement("span");
      when.className = "reader-credit-when";
      when.textContent = " · retrieved " + new Date(a.retrievedAt).toLocaleString();
      credit.appendChild(when);
    } catch (_) { /* keep silently */ }
  }
  // Mandatory credit line for anything that is not fully open.
  if (cls !== "open") {
    const note = document.createElement("div");
    note.className = "reader-credit-note";
    note.textContent = "Quoted under " + (READER_LICENSE_LABELS[cls] || cls) +
      ". The full text is governed by its source licence; a link and attribution are required.";
    credit.appendChild(note);
  }
}

// Restricted sources: the licence gate stripped the body. Show an honest
// "metadata only" notice instead of a misleading "no text extracted" message.
function showReaderRestrictedNotice(articleEl, statusEl) {
  if (articleEl) { articleEl.textContent = ""; articleEl.dataset.partial = "1"; }
  if (statusEl) {
    statusEl.textContent = "Full text withheld — this source is licensed as Restricted (metadata, link and snippet only; no paywall circumvention).";
    statusEl.style.display = "block";
    statusEl.classList.remove("reader-status-error");
  }
}

// Re-fetch the live source for the current item (bypasses the store cache).
async function refreshReader() {
  const split = document.getElementById("readerSplitView");
  const articleEl = document.getElementById("readerArticle");
  const statusEl = document.getElementById("readerStatus");
  if (!split) return;
  const url = split.dataset.readerUrl;
  const id = split.dataset.cardId;
  if (!url) return;
  if (statusEl) { statusEl.textContent = "Refreshing from source…"; statusEl.style.display = "block"; statusEl.classList.remove("reader-status-error"); }
  const badge = document.getElementById("readerStoreBadge");
  if (badge) badge.style.display = "none";
  const licBadge = document.getElementById("readerLicenseBadge");
  if (licBadge) licBadge.style.display = "none";
  const attr = document.getElementById("readerAttribution");
  if (attr) { attr.style.display = "none"; attr.innerHTML = ""; }
  const publisher = (split.dataset.readerPublisher || "").trim();
  const qs = `url=${encodeURIComponent(url)}&id=${encodeURIComponent(id || "")}&publisher=${encodeURIComponent(publisher)}&refresh=1`;
  await loadReaderUrl(`${API_BASE}/reader?${qs}`, articleEl, statusEl, document.getElementById("readerManualEntry"));
}

// Bind the refresh button once.
function bindReaderRefresh() {
  const btn = document.getElementById("readerRefresh");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", refreshReader);
}

// Wire the manual-entry controls once. Pasting a real publisher URL re-runs the
// reader fetch; pasting full text drops it straight into the article pane.
function bindReaderManualEntry() {
  const manualEl = document.getElementById("readerManualEntry");
  if (!manualEl || manualEl.dataset.bound === "1") return;
  manualEl.dataset.bound = "1";
  const urlInput = document.getElementById("readerManualUrl");
  const textInput = document.getElementById("readerManualText");
  const articleEl = document.getElementById("readerArticle");
  const statusEl = document.getElementById("readerStatus");
  const loadBtn = document.getElementById("readerManualLoad");
  const useBtn = document.getElementById("readerManualUseText");
  if (loadBtn) loadBtn.addEventListener("click", async () => {
    const u = (urlInput.value || "").trim();
    if (!u) { urlInput.focus(); return; }
    if (statusEl) { statusEl.textContent = "Loading from URL…"; statusEl.style.display = "block"; statusEl.classList.remove("reader-status-error"); }
    const split = document.getElementById("readerSplitView");
    const cardId = (split && split.dataset.cardId) || "";
    await loadReaderUrl(`${API_BASE}/reader?url=${encodeURIComponent(u)}&id=${encodeURIComponent(cardId)}`, articleEl, statusEl, manualEl);
    // Collapse the manual panel once real content arrives.
    if (articleEl.textContent && articleEl.textContent.trim() && !articleEl.dataset.partial) {
      manualEl.style.display = "none";
      if (statusEl) statusEl.style.display = "none";
    }
  });
  if (useBtn) useBtn.addEventListener("click", async () => {
    const t = (textInput.value || "").trim();
    if (!t) { textInput.focus(); return; }
    articleEl.textContent = t;
    articleEl.dataset.partial = "";
    manualEl.style.display = "none";
    if (statusEl) statusEl.style.display = "none";
    // Phase 3 — write the pasted text back into the shared store so it persists
    // across reloads (keyed by the current proposal id), and surface the AI
    // summary the server generates for it in the reader's summary pane.
    const split = document.getElementById("readerSplitView");
    const id = split && split.dataset.cardId;
    if (id) {
      try {
        const r = await fetch(`${API_BASE}/reader/store`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, text: t }),
        });
        const j = await r.json().catch(() => ({}));
        const summaryBox = document.getElementById("readerSummary");
        if (summaryBox && j.styledSummary) summaryBox.value = j.styledSummary;
      } catch (_) { /* non-fatal */ }
    }
  });
}

// Copy the split-view summary textarea back into the proposal card so the
// existing Integrate flow picks it up.
async function applyReaderSummaryToCard() {
  const split = document.getElementById("readerSplitView");
  const listEl = document.getElementById("reviewPanelList");
  const summaryBox = document.getElementById("readerSummary");
  if (!split || !listEl || !summaryBox) return;
  const id = split.dataset.cardId;
  if (!id) return;
  const card = listEl.querySelector(`.proposal-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  const val = summaryBox.value;
  const editBox = card.querySelector(".proposal-edit-box");
  if (editBox) editBox.value = val;
  const textEl = card.querySelector(".proposal-summary-text");
  if (textEl) { textEl.textContent = val; textEl.style.display = ""; }
}

// Hide the split view and restore the proposal list. When apply is true the
// summary textarea is written back to the card first.
async function closeReaderSplit(apply) {
  const split = document.getElementById("readerSplitView");
  const listEl = document.getElementById("reviewPanelList");
  if (!split || !listEl) return;
  if (apply) await applyReaderSummaryToCard();
  split.style.display = "none";
  listEl.style.display = "";
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
    const enriching = json.enrichingCount || 0;
    const hintEl = document.getElementById("reviewEnrichingHint");
    if (hintEl) {
      if (enriching > 0) {
        hintEl.textContent = `${enriching} update${enriching === 1 ? "" : "s"} still enriching and will appear here automatically.`;
        hintEl.style.display = "";
      } else {
        hintEl.style.display = "none";
      }
    }
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
          ${p.jurisdiction && p.jurisdiction !== "unknown" ? `<div class="proposal-meta proposal-jurisdiction"><span class="proposal-meta-label">Jurisdiction:</span> ${escapeHtml(p.jurisdiction)}</div>` : ""}
          ${p.whyItMatters ? `<div class="proposal-meta proposal-whymatters"><span class="proposal-meta-label">Why it matters:</span> ${escapeHtml(p.whyItMatters)}</div>` : ""}
          <div class="proposal-edit-row">
            <button class="btn btn-sm proposal-edit-toggle" data-edit-toggle type="button">Edit summary</button>
          </div>
          <textarea class="proposal-edit-box text-input" rows="4" style="display:none">${escapeHtml(p.styledSummary)}</textarea>
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
        </div>`;
      }
      return `<div class="proposal-nopreview">No extractable summary was available from the source feed. Open the original article (link above) to review the content before approving.</div>`;
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
      <div class="proposal-card" data-id="${p.id}" data-url="${escapeHtml(p.url || "")}">
        <div class="proposal-head">
          <span class="proposal-action proposal-action-${p.detectedAction}">${actionLabel[p.detectedAction] || p.detectedAction}</span>
          <span class="proposal-source">${escapeHtml(p.publisher || p.source || "")}</span>
          <span class="proposal-license-badge proposal-license-${p.licenseClass || "open"}" data-cls="${p.licenseClass || "open"}">${READER_LICENSE_LABELS[p.licenseClass] || p.licenseClass || "Open"}</span>
          <span class="proposal-date">${escapeHtml(p.publishedLabel || "")}</span>
          ${p.jurisdiction && p.jurisdiction !== "unknown" ? `<span class="proposal-jurisdiction-pill">${escapeHtml(p.jurisdiction)}</span>` : ""}
        </div>
        <div class="proposal-title">${escapeHtml(p.title)}</div>
        ${p.url ? `<a class="proposal-source-link" href="${escapeHtml(p.url)}" target="_blank" rel="noopener">Open the original article ↗</a>` : ""}
        ${matchHtml(p)}
        ${p.updateReason ? `<div class="proposal-reason"><span class="proposal-reason-pill proposal-reason-${reasonKey}">${reasonLabels[reasonKey]}</span> ${escapeHtml(p.updateReason)}</div>` : ""}
        ${previewHtml(p)}
        ${p.url ? `<button class="btn btn-sm btn-reader" data-read="${p.id}" type="button">Manually Read &amp; Write Summary</button>` : ""}
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
