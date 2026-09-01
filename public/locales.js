/*
 * locales.js — zh-CN i18n scaffold (Thread E, re-scoped to UI translation only).
 *
 * Scope (per 2026-08-24 decision): language changes only. Regulatory coverage
 * stays UK + EU. No China-source addition, no locale-aware AI output in v1.
 * This file is a SELF-CONTAINED scaffold:
 *   - defines window.LOCALES (en + zh-CN) and window.t()
 *   - applyLang() translates the static shell via a selector map (I18N_MAP)
 *   - wires the header language switcher (#langSwitch)
 * Dynamic, JS-rendered content (cards, loading states) is migrated incrementally
 * in later PRs; v1 translates the chrome so the mechanism is proven end-to-end.
 *
 * Node-safe: document/localStorage access is guarded so this file can be
 * required in tests (module.exports) without a DOM.
 */
(function (root) {
  'use strict';

  // ---------------------------------------------------------------------------
  // Dictionaries. `en` is the canonical source; `zh-CN` is Simplified Chinese.
  // ---------------------------------------------------------------------------
  const LOCALES = {
    en: {
      // Navigation
      'nav.knowledgeBase': 'Knowledge Base',
      'nav.news': 'News + Search',
      'nav.qna': 'Q&A',
      'nav.competitorWeb': 'Competitor Web',
      'nav.tencentProducts': 'Tencent Products',
      'nav.gamingTrends': 'AI Gaming Trends',
      'nav.useCases': 'AI Use Cases',
      'nav.timeline': 'AI Regulatory Timeline',
      'nav.risks': 'AI Use Risks',
      'nav.companyMap': 'Company Map',
      'nav.patents': 'Patents',

      // View titles
      'view.kb.title': 'Knowledge Base',
      'view.kb.subtitle': 'AI Regulations, Competitor Profiles, Technology Insights & Tencent Strategy — sourced from proprietary research documents',
      'view.news.title': 'Focused News Feed',
      'view.news.subtitle': 'Tracking AI developments, regulation, use cases, and selected competitors',
      'view.qna.title': 'Q&A',
      'view.qna.subtitle': "Ask detailed questions across the application's curated data, with evidence cited inline. Optionally search the internet for additional context.",
      'view.spider.title': 'Competitor Technology Web',
      'view.spider.subtitle': 'Interactive network diagram connecting competitors by shared technology sectors. Coloured by sector, Tencent at centre.',
      'view.tencent.title': 'Tencent AI & Gaming Products',
      'view.tencent.subtitle': "Interactive network of Tencent's AI, gaming, creative, and cloud products — coloured by sector. Connect to explore the product ecosystem.",
      'view.timeline.title': 'AI Regulatory Timeline',
      'view.timeline.subtitle': 'Key compliance deadlines and milestones for the EU AI Act, UK ICO roadmap, and related digital regulation — 2024 through 2030',
      'view.gaming.title': 'AI Gaming Trends',
      'view.gaming.subtitle': 'How LLMs and generative AI are being integrated into video games — expanded from the 9 trends in the Knowledge Base with live internet research',
      'view.useCases.title': 'AI Use Cases',
      'view.useCases.subtitle': 'Game-by-game evidence of how authored AI, procedural simulation, machine learning, and generative AI are used in released, announced, and community-built experiences',
      'view.risks.title': 'AI Use Risks',
      'view.risks.subtitle': 'Cross-referenced risk analysis for products and companies — drawn from the Knowledge Base, Competitor Web, EU AI Act, UK regulation, and proprietary research documents',
      'view.companyMap.title': 'Company & Studio Map',
      'view.companyMap.subtitle': 'Selected development, research, engine, and regulatory locations directly connected to competitor products and current game-AI use cases across the UK, EU, and North America',
      'view.patents.title': 'Patents',
      'view.patents.subtitle': 'Live patent filings from the European Patent Office, cross-referenced to the companies tracked in this app — searchable by applicant, keyword and AI/gaming classification',

      // Patents view (live EPO OPS). "Data: EPO OPS" is deliberately NOT in this
      // dictionary: it is an attribution string and must stay untranslated.
      'patents.applicantPlaceholder': 'Applicant — pick a tracked company, or type any name',
      'patents.prompt': 'Choose an applicant or keyword, then search.',
      'patents.needFilter': 'Choose a company, keyword or classification first.',
      'patents.noResults': 'No patents matched these filters.',
      'patents.searchedWith': 'Search sent to EPO OPS:',
      'patents.unreadableResponse': 'The response from EPO OPS could not be read — this is a fault, not an empty result.',
      'patents.resultsLabel': 'Patent results',
      'patents.showing': 'Showing {count} of {total} matches',
      'patents.cached': 'cached result',
      'patents.viewOnEspacenet': 'View on Espacenet',
      // Opt-in headline translation. Titles arrive in the filing language;
      // translating them all automatically would burn DeepL quota, so the
      // button only appears when the headline is not in the UI language.
      'patents.translate': 'Translate headline',
      'patents.showOriginal': 'Show original',
      'patents.translating': 'Translating…',
      'patents.translationFailed': 'Translation unavailable',
      'patents.liveNote': 'Live results from the European Patent Office (EPO OPS). Queries are cached for 12 hours to stay within the EPO fair-use quota.',
      'patents.notConfiguredNote': 'Live patent search is not configured on this server — the EPO OPS credentials are missing.',

      // Sections / panels
      'news.recentTitle': 'Recent News & Updates',
      'section.teamSources': 'Team Sources',
      'section.teamSourcesSub': 'Shared evidence library · cited as [T#] in Q&A',
      'useCases.catalogueTitle': 'Game Catalogue',
      'risks.companyProfiles': 'Company Risk Profiles',
      'risks.categories': 'Risk Categories & Detailed Analysis',
      'risks.affected': 'Affected',
      'reader.splitTitle': 'Read the article & write a summary',
      'reader.openButton': 'Read & write summary',
      'reader.openOriginal': 'Open original ↗',
      'common.visitProductPage': 'Visit product page',
      'common.suggestedUpdates': 'Suggested updates',
      'common.articlesTracked': 'Articles Tracked',
      'common.competitorsMonitored': 'Competitors Monitored',
      'common.sources': 'Sources',
      'common.answer': 'Answer',
      'common.includeInternet': 'Include Internet Sources',
      'common.mySources': 'My Sources',
      'common.teamSources': 'Team Sources',
      'common.answerStyle': 'Answer style',
      'common.full': 'Full (all sections)',
      'common.detailed': 'In-depth',
      'common.bullets': 'Key points',
      'common.conclusion': 'Short conclusion',

      // Reader / review panel
      'reader.summaryLabel': 'Summary (feeds the proposed entry)',
      'reader.integrate': 'Integrate',
      'reader.saveBack': 'Save & back',
      'reader.back': '← Back',
      'reader.refresh': 'Refresh',
      'common.printPdf': 'Print / Save as PDF',
      'review.empty': "Nothing to review. The app's content already matches the monitored official sources.",

      // Modals
      'modal.addCompetitors.title': 'Add Competitors',
      'modal.addCompetitors.subtitle': 'Choose competitors to include in focused News searches.',
      'modal.settings.title': 'Settings',
      'modal.settings.hint': 'Search is powered by different APIs.',
      'modal.review.title': 'Suggested updates',
      'modal.review.subtitle': 'The monitor found official sources that may update existing content. Review each one and choose how to integrate it.',

      // Buttons
      'btn.settings': 'Settings',
      'btn.addCompetitors': 'Add Competitors',
      'btn.returnToDefault': 'Return to Default',
      'btn.search': 'Search',
      'btn.clear': 'Clear',
      'btn.addSource': 'Add Source',
      'btn.applyRefresh': 'Apply & Refresh',
      'btn.cancel': 'Cancel',
      'btn.selectAll': 'Select all',
      'btn.ask': 'Ask',
      'btn.add': 'Add',

      // Status
      'status.checkingApi': 'Checking API...',
      'status.serverOffline': 'Server Offline',

      // Filters / sub-tabs
      'filter.all': 'All',
      'filter.eu': 'EU',
      'filter.uk': 'UK',
      'filter.both': 'Both',
      'filter.critical': 'Critical',
      'filter.high': 'High',
      'filter.medium': 'Medium',
      'filter.low': 'Low',
      'news.recentTab': 'Recent News & Updates',
      'news.savedTab': 'Saved Articles',
      'spider.networkTab': 'Competitor Network',
      'tencent.productMap': 'Product Map',
      'timeline.timelineTab': 'Regulatory Timeline',
      'gaming.ecosystemTab': 'Ecosystem Overview',
      'gaming.currentUsesTab': 'Current Shipped Uses',
      'gaming.patentsTab': 'Game Technology Patents',
      'gaming.analysisTab': 'Trend Analysis',
      'useCases.patternsTab': 'Cross-Game Patterns',
      'useCases.catalogueTab': 'Game Catalogue',
      'risks.profilesTab': 'Company Risk Profiles',
      'risks.categoriesTab': 'Risk Categories & Analysis',

      // Footer
      'footer.aiTransparency': 'This feature uses AI models to assist with answers and background updates. Be aware responses are AI generated to an extent, and so the accuracy of information cannot be assured.',

      // Q&A panel (dynamic chrome)
      'qna.noSavedArticles': 'No saved articles yet. Save articles in News + Search to use them here.',
      'qna.noTeamSources': 'No team sources yet. Add them under News + Search → Team Sources.',
      'qna.sources': 'Sources',

      // Loading states
      'loading.knowledgeBase': 'Loading knowledge base...',
      'loading.competitorNetwork': 'Building competitor network...',
      'loading.map': 'Loading map...',
      'loading.useCases': 'Loading current use cases...',
      'loading.gamingTrends': 'Loading AI gaming trends...',
      'loading.regulatoryTimeline': 'Loading regulatory timeline...',
      'loading.riskAnalysis': 'Loading risk analysis...',
      'loading.aiModelSynthesising': 'Loading the AI model and synthesising evidence...',
      'loading.scanningNews': 'Scanning competitor news...',
      'loading.webSearch': 'Searching the web for “{query}”…',
      'loading.proposedChanges': 'Loading proposed changes…',
      'loading.retrievingEvidence': 'Retrieving application evidence...',
      'loading.patents': 'Loading patent search...',
      'loading.patentsSearch': 'Searching the European Patent Office...',

      // Placeholders
      'ph.newsSearch': 'Search articles, e.g., NetEase AI game engine partnership 2026',
      'ph.kbSearch': 'Search knowledge base... e.g. EU AI Act, Stability AI, runtime generative, watermarking',
      'ph.teamSourceUrl': 'Paste an article URL to add as shared evidence…',
      'ph.teamSourceTitle': 'Optional title',
      'ph.competitorPicker': 'Find a competitor...',
      'ph.customCompetitor': 'Add a competitor not in the list (e.g. Epic Games)...',
      'ph.qnaQuestion': 'Ask a question about the application data…',
      'ph.useCaseSearch': 'Search games, systems, developers, or techniques...',
      'ph.readerUrl': 'Paste the article URL:',
      'ph.readerText': 'Paste the article body here…',
    },

    'zh-CN': {
      // Navigation
      'nav.knowledgeBase': '知识库',
      'nav.news': '新闻 + 搜索',
      'nav.qna': '问答',
      'nav.competitorWeb': '竞争对手关系网',
      'nav.tencentProducts': '腾讯产品',
      'nav.gamingTrends': 'AI 游戏趋势',
      'nav.useCases': 'AI 应用案例',
      'nav.timeline': 'AI 监管时间表',
      'nav.risks': 'AI 使用风险',
      'nav.companyMap': '公司与工作室地图',
      'nav.patents': '专利',

      // View titles
      'view.kb.title': '知识库',
      'view.kb.subtitle': '人工智能法规、竞争对手档案、技术洞察与腾讯战略——来源自有研究文档',
      'view.news.title': '精选新闻推送',
      'view.news.subtitle': '追踪人工智能发展、监管、应用案例与选定竞争对手',
      'view.qna.title': '问答',
      'view.qna.subtitle': '就本应用策展的数据提出详细问题，并以内联方式引用证据。可选择联网搜索以获取更多背景信息。',
      'view.spider.title': '竞争对手技术关系网',
      'view.spider.subtitle': '以共享技术领域连接各竞争对手的交互式关系图。按领域着色，腾讯居中。',
      'view.tencent.title': '腾讯 AI 与游戏产品',
      'view.tencent.subtitle': '腾讯人工智能、游戏、创意与云产品的交互式关系网——按领域着色。点击连接以探索产品生态。',
      'view.timeline.title': 'AI 监管时间表',
      'view.timeline.subtitle': '欧盟《人工智能法案》、英国 ICO 路线图及相关数字监管的关键合规期限与里程碑——2024 至 2030 年',
      'view.gaming.title': 'AI 游戏趋势',
      'view.gaming.subtitle': '大语言模型与生成式人工智能如何融入电子游戏——在知识库 9 大趋势基础上结合实时网络研究扩展',
      'view.useCases.title': 'AI 应用案例',
      'view.useCases.subtitle': '逐游戏呈现创作型 AI、程序化模拟、机器学习与生成式 AI 如何应用于已发布、已公布及社区自制体验的证据',
      'view.risks.title': 'AI 使用风险',
      'view.risks.subtitle': '针对产品与公司的交叉引用风险分析——来源包括知识库、竞争对手关系网、欧盟《人工智能法案》、英国监管及自有研究文档',
      'view.companyMap.title': '公司与工作室地图',
      'view.companyMap.subtitle': '与竞争对手产品及当前游戏 AI 应用案例直接相关的精选开发、研究、引擎与监管地点，覆盖英国、欧盟与北美',
      'view.patents.title': '专利',
      'view.patents.subtitle': '来自欧洲专利局的实时专利申请，并与本应用追踪的公司相互参照——可按申请人、关键词及 AI/游戏分类检索',

      // 专利视图（EPO OPS 实时数据）。"Data: EPO OPS" 为署名字符串，刻意不做翻译。
      'patents.applicantPlaceholder': '申请人——选择已追踪的公司，或输入任意名称',
      'patents.prompt': '选择申请人或关键词，然后开始检索。',
      'patents.needFilter': '请先选择公司、关键词或专利分类。',
      'patents.noResults': '没有符合这些筛选条件的专利。',
      'patents.searchedWith': '已发送至 EPO OPS 的检索式：',
      'patents.unreadableResponse': '无法读取 EPO OPS 的响应——这是系统故障，而非检索结果为空。',
      'patents.resultsLabel': '专利检索结果',
      'patents.showing': '显示 {count} 条，共 {total} 条匹配结果',
      'patents.cached': '缓存结果',
      'patents.viewOnEspacenet': '在 Espacenet 上查看',
      'patents.translate': '翻译标题',
      'patents.showOriginal': '显示原文',
      'patents.translating': '正在翻译……',
      'patents.translationFailed': '翻译不可用',
      'patents.liveNote': '实时数据来自欧洲专利局（EPO OPS）。为遵守 EPO 的合理使用配额，检索结果会缓存 12 小时。',
      'patents.notConfiguredNote': '此服务器尚未配置实时专利检索——缺少 EPO OPS 凭据。',

      // Sections / panels
      'news.recentTitle': '最新新闻与更新',
      'section.teamSources': '团队来源',
      'section.teamSourcesSub': '共享证据库 · 在问答中以 [T#] 引用',
      'useCases.catalogueTitle': '游戏目录',
      'risks.companyProfiles': '公司风险档案',
      'risks.categories': '风险类别与详细分析',
      'reader.splitTitle': '阅读文章并撰写摘要',
      'reader.openButton': '阅读并撰写摘要',
      'reader.openOriginal': '打开原文 ↗',
      'common.visitProductPage': '访问产品页面',
      'common.suggestedUpdates': '建议更新',
      'common.articlesTracked': '追踪文章数',
      'common.competitorsMonitored': '监控竞争对手数',
      'common.sources': '来源',
      'common.answer': '回答',
      'common.includeInternet': '包含网络来源',
      'common.mySources': '我的来源',
      'common.teamSources': '团队来源',
      'common.answerStyle': '回答风格',
      'common.full': '完整（全部章节）',
      'common.detailed': '深入',
      'common.bullets': '要点',
      'common.conclusion': '简短结论',

      // Reader / review panel
      'reader.summaryLabel': '摘要（用于建议条目）',
      'reader.integrate': '整合',
      'reader.saveBack': '保存并返回',
      'reader.back': '← 返回',
      'reader.refresh': '刷新',
      'common.printPdf': '打印 / 保存为 PDF',
      'review.empty': '暂无需审核的内容。应用内容已与受监控的官方来源一致。',

      // Modals
      'modal.addCompetitors.title': '添加竞争对手',
      'modal.addCompetitors.subtitle': '选择要纳入精选新闻搜索的竞争对手。',
      'modal.settings.title': '设置',
      'modal.settings.hint': '搜索由不同的 API 提供支持。',
      'modal.review.title': '建议更新',
      'modal.review.subtitle': '监测器发现了可能更新现有内容的官方来源。请逐项审核并选择整合方式。',

      // Buttons
      'btn.settings': '设置',
      'btn.addCompetitors': '添加竞争对手',
      'btn.returnToDefault': '返回默认',
      'btn.search': '搜索',
      'btn.clear': '清除',
      'btn.addSource': '添加来源',
      'btn.applyRefresh': '应用并刷新',
      'btn.cancel': '取消',
      'btn.selectAll': '全选',
      'btn.ask': '提问',
      'btn.add': '添加',

      // Status
      'status.checkingApi': '正在检查 API…',
      'status.serverOffline': '服务器离线',

      // Filters / sub-tabs
      'filter.all': '全部',
      'filter.eu': '欧盟',
      'filter.uk': '英国',
      'filter.both': '两者',
      'filter.critical': '严重',
      'filter.high': '高',
      'filter.medium': '中',
      'filter.low': '低',
      'news.recentTab': '最新新闻与更新',
      'news.savedTab': '已保存文章',
      'spider.networkTab': '竞争对手网络',
      'tencent.productMap': '产品地图',
      'timeline.timelineTab': '监管时间表',
      'gaming.ecosystemTab': '生态概览',
      'gaming.currentUsesTab': '当前已落地应用',
      'gaming.patentsTab': '游戏技术专利',
      'gaming.analysisTab': '趋势分析',
      'useCases.patternsTab': '跨游戏模式',
      'useCases.catalogueTab': '游戏目录',
      'risks.profilesTab': '公司风险档案',
      'risks.categoriesTab': '风险类别与分析',
      'risks.affected': '受影响',

      // Footer
      'footer.aiTransparency': '本功能使用 AI 模型辅助回答与后台更新。请注意，回答在一定程度上由 AI 生成，因此无法保证信息的准确性。',

      // Q&A panel (dynamic chrome)
      'qna.noSavedArticles': '暂无已保存文章。请在“新闻 + 搜索”中保存文章以在此使用。',
      'qna.noTeamSources': '暂无团队来源。请在“新闻 + 搜索”→“团队来源”中添加。',
      'qna.sources': '来源',

      // Loading states
      'loading.knowledgeBase': '正在加载知识库……',
      'loading.competitorNetwork': '正在构建竞争对手关系网……',
      'loading.map': '正在加载地图……',
      'loading.useCases': '正在加载当前应用案例……',
      'loading.gamingTrends': '正在加载 AI 游戏趋势……',
      'loading.regulatoryTimeline': '正在加载监管时间表……',
      'loading.riskAnalysis': '正在加载风险分析……',
      'loading.aiModelSynthesising': '正在加载 AI 模型并综合证据……',
      'loading.scanningNews': '正在扫描竞争对手新闻……',
      'loading.webSearch': '正在联网搜索“{query}”…',
      'loading.proposedChanges': '正在加载建议更新……',
      'loading.retrievingEvidence': '正在检索应用证据……',
      'loading.patents': '正在加载专利检索……',
      'loading.patentsSearch': '正在检索欧洲专利局……',

      // Placeholders
      'ph.newsSearch': '搜索文章，例如：网易 AI 游戏引擎合作 2026',
      'ph.kbSearch': '搜索知识库……例如：欧盟 AI 法案、Stability AI、运行时生成、水印',
      'ph.teamSourceUrl': '粘贴文章 URL 以添加为共享证据……',
      'ph.teamSourceTitle': '可选标题',
      'ph.competitorPicker': '查找竞争对手……',
      'ph.customCompetitor': '添加列表中未有的竞争对手（例如 Epic Games）……',
      'ph.qnaQuestion': '就应用数据提问……',
      'ph.useCaseSearch': '搜索游戏、系统、开发者或技术……',
      'ph.readerUrl': '粘贴文章 URL：',
      'ph.readerText': '在此粘贴文章正文……',
    },
  };

  // ---------------------------------------------------------------------------
  // Selector map: element selector -> i18n key. `attr:'placeholder'` sets the
  // placeholder attribute instead of textContent. Only TEXT-ONLY elements are
  // mapped (no element wipes child nodes). Incremental PRs extend this map as
  // more of the dynamically-rendered UI is migrated.
  // ---------------------------------------------------------------------------
  const I18N_MAP = [
    // Navigation
    { sel: '.nav-btn[data-view="knowledge-base"]', key: 'nav.knowledgeBase' },
    { sel: '.nav-btn[data-view="news-view"]', key: 'nav.news' },
    { sel: '.nav-btn[data-view="summarise-view"]', key: 'nav.qna' },
    { sel: '.nav-btn[data-view="spider-web"]', key: 'nav.competitorWeb' },
    { sel: '.nav-btn[data-view="tencent-products"]', key: 'nav.tencentProducts' },
    { sel: '.nav-btn[data-view="gaming-trends"]', key: 'nav.gamingTrends' },
    { sel: '.nav-btn[data-view="current-use-cases"]', key: 'nav.useCases' },
    { sel: '.nav-btn[data-view="regulatory-timeline"]', key: 'nav.timeline' },
    { sel: '.nav-btn[data-view="risks"]', key: 'nav.risks' },
    { sel: '.nav-btn[data-view="company-map"]', key: 'nav.companyMap' },
    { sel: '.nav-btn[data-view="patents"]', key: 'nav.patents' },

    // View titles
    { sel: '#knowledge-base .page-header h1', key: 'view.kb.title' },
    { sel: '#news-view .page-header h1', key: 'view.news.title' },
    { sel: '#summarise-view .summary-hero h1', key: 'view.qna.title' },
    { sel: '#spider-web .page-header h1', key: 'view.spider.title' },
    { sel: '#tencent-products .page-header h1', key: 'view.tencent.title' },
    { sel: '#regulatory-timeline .page-header h1', key: 'view.timeline.title' },
    { sel: '#gaming-trends .page-header h1', key: 'view.gaming.title' },
    { sel: '#current-use-cases .page-header h1', key: 'view.useCases.title' },
    { sel: '#risks .page-header h1', key: 'view.risks.title' },
    { sel: '#company-map .page-header h1', key: 'view.companyMap.title' },
    { sel: '#patents .page-header h1', key: 'view.patents.title' },

    // View subtitles
    { sel: '#knowledge-base .subtitle', key: 'view.kb.subtitle' },
    { sel: '#news-view .subtitle', key: 'view.news.subtitle' },
    { sel: '#summarise-view .summary-hero p', key: 'view.qna.subtitle' },
    { sel: '#spider-web .subtitle', key: 'view.spider.subtitle' },
    { sel: '#tencent-products .subtitle', key: 'view.tencent.subtitle' },
    { sel: '#regulatory-timeline .subtitle', key: 'view.timeline.subtitle' },
    { sel: '#gaming-trends .subtitle', key: 'view.gaming.subtitle' },
    { sel: '#current-use-cases .subtitle', key: 'view.useCases.subtitle' },
    { sel: '#risks .subtitle', key: 'view.risks.subtitle' },
    { sel: '#company-map .subtitle', key: 'view.companyMap.subtitle' },
    { sel: '#patents .subtitle', key: 'view.patents.subtitle' },

    // Sections / panels
    { sel: '#newsSectionTitle', key: 'news.recentTitle' },
    { sel: '#teamSourcesSection .section-header h2', key: 'section.teamSources' },
    { sel: '#teamSourcesSection .team-sources-sub', key: 'section.teamSourcesSub' },
    { sel: '#useCaseCatalogueSection .use-case-results-header h2', key: 'useCases.catalogueTitle' },
    { sel: '#risksCompaniesSection .section-header h2', key: 'risks.companyProfiles' },
    { sel: '#risksCategoriesSection .section-header h2', key: 'risks.categories' },
    { sel: '#readerSplitView .reader-split-title', key: 'reader.splitTitle' },
    { sel: '#readerOriginalLink', key: 'reader.openOriginal' },
    { sel: '#tencentProductsDetailLink', key: 'common.visitProductPage' },
    { sel: '#statsRow .stat-card:first-child .stat-label', key: 'common.articlesTracked' },
    { sel: '#competitorMonitorCard .stat-label', key: 'common.competitorsMonitored' },
    { sel: '#aiTransparencyText', key: 'footer.aiTransparency' },
    { sel: '#apiStatus .status-label', key: 'status.checkingApi' },

    // Reader / review panel
    { sel: '.reader-summary-pane .reader-pane-label', key: 'reader.summaryLabel' },
    { sel: '#readerIntegrate', key: 'reader.integrate' },
    { sel: '#readerSave', key: 'reader.saveBack' },
    { sel: '#readerBack', key: 'reader.back' },
    { sel: '#readerRefresh', key: 'reader.refresh' },
    { sel: '#summaryPrintBtn', key: 'common.printPdf' },
    { sel: '#reviewPanelTitle', key: 'modal.review.title' },
    { sel: '#reviewPanelOverlay .modal-subtitle', key: 'modal.review.subtitle' },
    { sel: '#reviewPanelEmpty p', key: 'review.empty' },
    // Sidebar "Suggested updates" button keeps its count <span>, so target the
    // label span only.
    { sel: '#suggestedUpdatesBtn .i18n-label', key: 'common.suggestedUpdates' },

    // Q&A panel (summarise-view) static chrome
    { sel: '#summaryUseModel + span', key: 'common.includeInternet' },
    { sel: '#useMySources + span', key: 'common.mySources' },
    { sel: '#useTeamSources + span', key: 'common.teamSources' },
    { sel: '.summary-style-label > span', key: 'common.answerStyle' },
    { sel: '#summaryStyle option[value="full"]', key: 'common.full' },
    { sel: '#summaryStyle option[value="detailed"]', key: 'common.detailed' },
    { sel: '#summaryStyle option[value="bullets"]', key: 'common.bullets' },
    { sel: '#summaryStyle option[value="conclusion"]', key: 'common.conclusion' },
    { sel: '#mySourcesPanel .my-sources-title', key: 'common.mySources' },
    { sel: '#teamSourcesComposerPanel .my-sources-title', key: 'common.teamSources' },
    { sel: '#mySourcesEmpty', key: 'qna.noSavedArticles' },
    { sel: '#teamSourcesComposerEmpty', key: 'qna.noTeamSources' },
    { sel: '#summaryResult .summary-eyebrow', key: 'common.answer' },
    { sel: '#summaryResult .summary-evidence-section h3', key: 'qna.sources' },

    // Modals
    { sel: '#competitorModalTitle', key: 'modal.addCompetitors.title' },
    { sel: '#competitorModal .modal-subtitle', key: 'modal.addCompetitors.subtitle' },
    { sel: '#settingsModal h3', key: 'modal.settings.title' },
    { sel: '#settingsModal .modal-body .hint', key: 'modal.settings.hint' },

    // Buttons
    { sel: '#settingsBtn', key: 'btn.settings' },
    { sel: '#addCompetitorsBtn', key: 'btn.addCompetitors' },
    { sel: '#clearSearchBtn', key: 'btn.returnToDefault' },
    { sel: '#searchBtn', key: 'btn.search' },
    { sel: '#kbSearchBtn', key: 'btn.search' },
    { sel: '#kbClearBtn', key: 'btn.clear' },
    { sel: '#addTeamSourceBtn', key: 'btn.addSource' },
    { sel: '#applyCompetitorSelection', key: 'btn.applyRefresh' },
    { sel: '#cancelCompetitorSelection', key: 'btn.cancel' },
    { sel: '#selectAllCompetitors', key: 'btn.selectAll' },
    { sel: '#summarySubmitBtn', key: 'btn.ask' },
    { sel: '#addCustomCompetitorBtn', key: 'btn.add' },

    // Filters / sub-tabs (text-only only; icon-bearing filter buttons skipped)
    { sel: '.timeline-filter-btn[data-filter="all"]', key: 'filter.all' },
    { sel: '.timeline-filter-btn[data-filter="EU"]', key: 'filter.eu' },
    { sel: '.timeline-filter-btn[data-filter="UK"]', key: 'filter.uk' },
    { sel: '.timeline-filter-btn[data-filter="Both"]', key: 'filter.both' },
    { sel: '.risks-filter-btn[data-filter="all"]', key: 'filter.all' },
    // Severity filter buttons carry a <span class="sev-dot"> icon, so we must
    // target the label span (not the button) to avoid wiping the icon.
    { sel: '.risks-filter-btn[data-filter="critical"] .i18n-label', key: 'filter.critical' },
    { sel: '.risks-filter-btn[data-filter="high"] .i18n-label', key: 'filter.high' },
    { sel: '.risks-filter-btn[data-filter="medium"] .i18n-label', key: 'filter.medium' },
    { sel: '.timeline-filter-btn[data-filter="Critical Deadline"] .i18n-label', key: 'filter.critical' },
    { sel: '#news-view .sub-tab-btn[data-news-mode="recent"]', key: 'news.recentTab' },
    { sel: '#spider-web .sub-tab-btn[data-target="spiderContainerSection"]', key: 'spider.networkTab' },
    { sel: '#tencent-products .sub-tab-btn[data-target="tencentProductsContainerSection"]', key: 'tencent.productMap' },
    { sel: '#regulatory-timeline .sub-tab-btn[data-target="regulatoryTimelineContentSection"]', key: 'timeline.timelineTab' },
    { sel: '#gaming-trends .sub-tab-btn[data-target="trendsEcosystemSection"]', key: 'gaming.ecosystemTab' },
    { sel: '#gaming-trends .sub-tab-btn[data-target="trendsCurrentUsesSection"]', key: 'gaming.currentUsesTab' },
    { sel: '#gaming-trends .sub-tab-btn[data-target="trendsPatentsSection"]', key: 'gaming.patentsTab' },
    { sel: '#gaming-trends .sub-tab-btn[data-target="trendsGridSection"]', key: 'gaming.analysisTab' },
    { sel: '#current-use-cases .sub-tab-btn[data-target="useCasePatternsSection"]', key: 'useCases.patternsTab' },
    { sel: '#current-use-cases .sub-tab-btn[data-target="useCaseCatalogueSection"]', key: 'useCases.catalogueTab' },
    { sel: '#risks .sub-tab-btn[data-target="risksCompaniesSection"]', key: 'risks.profilesTab' },
    { sel: '#risks .sub-tab-btn[data-target="risksCategoriesSection"]', key: 'risks.categoriesTab' },

    // Placeholders
    { sel: '#searchInput', key: 'ph.newsSearch', attr: 'placeholder' },
    { sel: '#kbSearchInput', key: 'ph.kbSearch', attr: 'placeholder' },
    { sel: '#teamSourceUrl', key: 'ph.teamSourceUrl', attr: 'placeholder' },
    { sel: '#teamSourceTitle', key: 'ph.teamSourceTitle', attr: 'placeholder' },
    { sel: '#competitorPickerSearch', key: 'ph.competitorPicker', attr: 'placeholder' },
    { sel: '#customCompetitorInput', key: 'ph.customCompetitor', attr: 'placeholder' },
    { sel: '#summaryQuestion', key: 'ph.qnaQuestion', attr: 'placeholder' },
    { sel: '#useCaseSearch', key: 'ph.useCaseSearch', attr: 'placeholder' },
    { sel: '#readerManualUrl', key: 'ph.readerUrl', attr: 'placeholder' },
    { sel: '#readerManualText', key: 'ph.readerText', attr: 'placeholder' },
  ];

  // ---------------------------------------------------------------------------
  // Core helpers
  // ---------------------------------------------------------------------------
  let currentLang = 'en';

  function getLang() {
    try {
      if (typeof localStorage !== 'undefined') {
        const s = localStorage.getItem('LANG');
        if (s) return s;
      }
    } catch (e) { /* ignore */ }
    return currentLang;
  }

  function setLang(lang) {
    currentLang = (lang === 'zh-CN') ? 'zh-CN' : 'en';
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('LANG', currentLang);
    } catch (e) { /* ignore */ }
    applyLang();
    // Signal data-driven views (KB, News, Patents, Risks, …) so they can
    // re-fetch/re-render in the chosen language WITHOUT a page refresh.
    // Kept decoupled: locales.js only broadcasts; app.js owns the reload.
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('langchange', { detail: { lang: currentLang } }));
    }
  }

  function t(key, vars) {
    const lang = getLang();
    let str = (LOCALES[lang] && LOCALES[lang][key] != null) ? LOCALES[lang][key]
      : (LOCALES.en && LOCALES.en[key] != null) ? LOCALES.en[key]
      : key;
    if (vars && typeof vars === 'object') {
      str = String(str).replace(/\{(\w+)\}/g, (m, n) => (vars[n] != null ? vars[n] : m));
    }
    return str;
  }

  function applyLang() {
    if (typeof document === 'undefined') return;
    const lang = getLang();
    document.documentElement.lang = (lang === 'zh-CN') ? 'zh-CN' : 'en';
    for (const item of I18N_MAP) {
      const el = document.querySelector(item.sel);
      if (!el) continue;
      if (item.attr === 'placeholder') el.setAttribute('placeholder', t(item.key));
      else el.textContent = t(item.key);
    }
    const sw = document.getElementById('langSwitch');
    if (sw) {
      sw.querySelectorAll('[data-lang]').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-lang') === lang);
      });
    }
  }

  function init() {
    if (typeof document === 'undefined') return;
    const sw = document.getElementById('langSwitch');
    if (sw) {
      sw.addEventListener('click', (e) => {
        const b = e.target.closest('[data-lang]');
        if (!b) return;
        setLang(b.getAttribute('data-lang'));
      });
    }
    applyLang();
  }

  const api = { LOCALES, I18N_MAP, t, getLang, setLang, applyLang, init };

  if (typeof window !== 'undefined') {
    window.LOCALES = LOCALES;
    window.t = t;
    window.getLang = getLang;
    window.setLang = setLang;
    window.applyLang = applyLang;
    window.i18nInit = init;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', init);
  }
})(typeof window !== 'undefined' ? window : globalThis);
