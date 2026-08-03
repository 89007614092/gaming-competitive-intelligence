#!/usr/bin/env python3
"""Generate initial news cache using DuckDuckGo search."""
import json, sys, os

# Keywords matching server.js COMPETITOR_KEYWORDS
KEYWORDS = [
    "NetEase gaming technology Tencent",
    "miHoYo HoYoverse gaming technology",
    "Sony PlayStation gaming AI",
    "Microsoft Xbox gaming AI",
    "Epic Games Unreal Engine AI",
    "Unity game engine AI",
    "Roblox gaming platform AI",
    "Electronic Arts gaming AI",
    "Ubisoft gaming technology",
    "Take-Two Interactive gaming",
    "Valve Steam gaming",
    "ByteDance gaming AI",
    "Nintendo gaming technology",
    "Krafton gaming AI",
    "Netmarble gaming AI",
    "NCSoft gaming AI",
    "Nexon gaming AI",
    "Sea Limited Garena gaming",
    "Kakao Games AI",
    "Infold Games AI",
    "Google DeepMind gaming",
    "Meta gaming AI VR",
    "Mistral AI"
]

try:
    from ddgs import DDGS
except ImportError:
    from duckduckgo_search import DDGS

articles = []
seen_urls = set()

for kw in KEYWORDS[:12]:  # Use first 12 for diversity, avoid rate limits
    query = f"{kw} 2026"
    print(f"Searching: {query}")
    try:
        with DDGS() as ddgs:
            for r in ddgs.text(query, max_results=3):
                url = r.get("href", "")
                if url and url not in seen_urls:
                    seen_urls.add(url)
                    articles.append({
                        "title": r.get("title", ""),
                        "url": url,
                        "description": r.get("body", ""),
                        "competitorKeyword": kw,
                    })
    except Exception as e:
        print(f"  Error: {e}")
        continue

# Deduplicate by URL
unique = []
seen = set()
for a in articles:
    if a["url"] not in seen:
        seen.add(a["url"])
        unique.append(a)

# Sort by description length (more substantive first)
unique.sort(key=lambda a: len(a.get("description", "")), reverse=True)

cache = {
    "generatedAt": __import__("datetime").datetime.now().isoformat(),
    "source": "Python DuckDuckGo search",
    "count": len(unique),
    "articles": unique[:30]
}

outpath = os.path.join(os.path.dirname(__file__), "data", "news-cache.json")
with open(outpath, "w") as f:
    json.dump(cache, f, indent=2, ensure_ascii=False)

print(f"\nSaved {len(unique[:30])} articles to {outpath}")
