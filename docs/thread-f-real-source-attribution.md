# Thread F — Real-Source Attribution ("Source: news.google.com")

> Status: **IMPLEMENTED** (label-only override, zero extra network requests).
>
> Shipped as `applyRealSource()` in `server.js`, wired into both `/api/reader` paths,
> plus a `publisher` query param threaded from the proposal card in `public/app.js`.
> Covered by `test/reader-attribution.test.cjs` (10 tests).

## 1. The bug

In **Suggested Updates**, opening an article in the split-screen reader showed:

```
Source: news.google.com
```

…for essentially every item — never the actual publisher (Reuters, AP, Bloomberg, …).

## 2. Root cause (verified in code)

Google News RSS does not hand out publisher URLs. Every `<link>` is an opaque
aggregator redirect:

```
https://news.google.com/rss/articles/CBMi<base64-ish blob>
```

The chain that produces the wrong label:

| Step | Where | What happens |
|---|---|---|
| 1 | `runSourceScan` → RSS parse | Item URL is the `news.google.com` redirect. The **real publisher NAME** is captured separately from the feed's `<source>` tag → `prop.publisher` (server.js:757 reads it back) |
| 2 | `/api/reader` → `resolveGoogleNewsUrl` | Tries to turn the redirect into a real URL. Google serves a **consent/interstitial wall** to Render's datacentre IP, so this **frequently fails** (falls through Jina → DDG/GDELT) |
| 3 | `fetchReaderContent` → `extractViaJina` | With no resolved URL, Jina reads the `news.google.com` URL itself |
| 4 | `buildAttribution` (lib/extractor.js) | Derives `attribution.source` from the URL **hostname** → `"news.google.com"` |
| 5 | `renderReaderAttribution` (app.js:3854) | Renders `a.source` verbatim → `Source: news.google.com` |

**The key insight:** we already knew the answer at step 1. The publisher name was
captured, stored, and even rendered on the proposal card (`app.js:4099` renders
`p.publisher || p.source`) — it was simply never used for the reader credit.

So this is **not** a resolution problem. It is a plumbing problem. No extra
network request, no new API, no quota spend is required to fix it.

## 3. The fix

### `applyRealSource(obj, publisher)` — server.js

A **label-only** override:

- No-ops when `publisher` is empty/whitespace, or `obj` is not an object.
- Overrides `attribution.source` **only** when:
  - the attribution host / source string is `news.google.com` (the aggregator), **or**
  - there is **no attribution object at all** (older stored proposals).
- Leaves a genuinely-resolved publisher (`reuters.com`, `The Verge`) untouched —
  a real resolution always wins over the feed's display name.
- **Preserves `attribution.url`** so the credit link still opens the article
  (the Google redirect does forward correctly in a real browser, which has cookies
  and a consumer IP — the failure at step 2 is server-side only).
- **Preserves `licenseClass`** — governance (`lib/licenseGate.js`) depends on it.

### Wiring

| Path | Change |
|---|---|
| `/api/reader` store path (server.js:766) | `applyRealSource(storeObj, storeObj.publisher \|\| req.query.publisher)` — scan-time publisher first, client hint as fallback for items ingested before the field existed |
| `/api/reader` live path (server.js:798) | `applyRealSource({...result, licenseClass}, req.query.publisher)` before `applyLicenseGate` |
| `fetchReaderContent` opts | now receives `publisher` (available to the resolver, harmless if unused) |
| `openReaderSplit` (app.js:3697) | reads the card's `.proposal-source` text (= `p.publisher`) and sends `&publisher=…`; also stores it on `split.dataset.readerPublisher` |
| `refreshReader` (app.js:3907) | re-sends `publisher` so a manual refresh keeps the correct credit |

Note the deliberate split from the pre-existing `domain` param: `domain` is only
sent when the string looks like a host (`includes(".")`) because it feeds *source
resolution*, and a name like "Reuters" would break it. `publisher` is the raw
human-readable name and feeds *display only*.

## 4. Tests — `test/reader-attribution.test.cjs`

Pure (7): aggregator override; resolved-publisher untouched; no-attribution
population; no-op on empty/whitespace/undefined publisher; no-op on a non-aggregator
source; safe on non-objects; aggregator detected from `obj.url` when the
attribution has no url.

Route (3), all with `globalThis.fetch` stubbed — **no network**:
1. Jina extraction succeeds from the aggregator URL → credit is `Reuters`, not `news.google.com`.
2. Same scenario with **no** `publisher` param → still reports `news.google.com`
   (pins the original behaviour; proves we never invent a source).
3. Every outbound fetch fails → `{unresolved:true}` **and** the publisher is still
   threaded into `attribution` so the credit is right once the user pastes the text.

> **Test-harness gotcha (cost ~40 min):** the stub installer must return the
> **restore** closure, not the stub itself. Returning the stub means
> `globalThis.fetch` is never replaced, the test silently hits **live** Google News
> (which really does fail), and you get a confusing `unresolved` result plus a
> mystery `fetch(undefined)` from the `finally` block. `stubFetch()` in this file
> is the correct pattern; `realFetch` must be captured at module load.

## 5. Deliberately NOT done

- **Resolving + storing the real publisher URL at scan time** (via the existing
  resolver or GDELT). That would also fix the credit *link*, not just the label —
  but it costs one extra outbound request per scanned item and the resolver is
  exactly the thing that fails from Render's IP. The label fix delivers ~all of
  the user-visible value for zero cost. Revisit only if the credit *link* itself
  becomes a complaint.
- **Client-side hostname prettifying.** Rejected: it would mask genuine resolution
  successes and invent names we cannot verify.
