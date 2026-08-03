#!/usr/bin/env python3
"""Search helper using DuckDuckGo — free, no API key, no sign-in."""

import sys
import json
from ddgs import DDGS


def search(query, max_results=10):
    results = []
    try:
        for r in DDGS().text(query, max_results=max_results):
            results.append(
                {
                    "title": r.get("title", ""),
                    "url": r.get("href", ""),
                    "description": r.get("body", ""),
                }
            )
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
    return results


if __name__ == "__main__":
    query = sys.argv[1] if len(sys.argv) > 1 else ""
    limit = int(sys.argv[2]) if len(sys.argv) > 2 else 10

    if not query:
        print(json.dumps({"error": "No query provided"}))
        sys.exit(1)

    results = search(query, limit)
    print(json.dumps({"success": True, "data": results, "total": len(results)}))
