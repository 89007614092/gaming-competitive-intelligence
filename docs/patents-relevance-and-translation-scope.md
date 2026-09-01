# Patents — relevance tuning + headline translation (SCOPE, for review)

> Status: DRAFT for review. No code written yet.
> Covers two asks: (1) narrow the CPC filters so the Patents tab only shows
> video-game / digital-gaming and genuinely relevant AI patents; (2) a small
> "translate headline" affordance for patents whose title is not in the UI language.
>
> Codes marked ✔ are **verified** against the USPTO CPC scheme, the WIPO IPCPUB
> scheme, or the front page of a real granted patent. Codes marked ⚠ are
> **believed correct but unverified** — see §5 for the cheap way to confirm them
> against OPS before we rely on them.

---

## 1. Answering the question directly

### "A63F is 'gaming' in general, correct?"

Correct, and it is **broader than video games**. The official subclass title is:

> **A63F** — CARD, BOARD, OR ROULETTE GAMES; INDOOR GAMES USING SMALL MOVING
> PLAYING BODIES; VIDEO GAMES; GAMES NOT OTHERWISE PROVIDED FOR

Its main groups:

| Code | Covers | Relevant? |
|---|---|---|
| A63F 1/00 | Card games | ✗ |
| A63F 3/00 | Board games; raffle games | ✗ |
| A63F 5/00 | Roulette games | ✗ |
| A63F 7/00 | Indoor games with small moving bodies (e.g. **pinball**) | ✗ |
| A63F 9/00 | Games not otherwise provided for | ✗ |
| **A63F 13/00** | **Video games** — "games using an electronically generated display having two or more dimensions" | **✓** |

So searching `A63F` today retrieves playing cards, chess sets, roulette wheels and
pinball tables. **A63F13/00 is the video-games subgroup** and is the single
highest-value change available here.

### "Are there G06N subcategories that focus on AI in digital content?"

Yes, but G06N is also much broader than "AI". Its title is "Computing arrangements
based on **specific computational models**", and it currently includes quantum
computing (G06N10/00), biomolecular/DNA computing (G06N3/002, 3/123) and
neuromorphic hardware (G06N3/06x). Those are noise for us. The relevant
sub-branches are listed in §3.

One important gap: **large language models have no G06N code.** Dialogue and
text-generation patents are classified in **G06F40** (natural language
processing), not G06N. If interactive LLM/NPC dialogue matters, we need a G06F40
code as well — see §3D.

---

## 2. Proposed filter set — Games (row 1)

All under **A63F13/xx**. ✔ = verified title.

| Code | Title (abridged) | Why it earns its place |
|---|---|---|
| **A63F13/00** ✔ | Video games (parent) | **The default.** Hierarchically covers every 13/xx subgroup. |
| A63F13/45 ✔ | Controlling the progress of the video game | Core game-loop / state logic |
| A63F13/55 ✔ | Controlling game characters or game objects based on the game progress | NPC behaviour, animation state |
| A63F13/57 ✔ | Simulating properties, behaviour or motion of objects in the game world | Physics, collision, motion |
| A63F13/60 ✔ | Generating or modifying game content before/while executing the game program (authoring tools, level editors) | Content pipeline, UGC |
| **A63F13/67** ✔ | …generating/modifying game content **adaptively or by learning from player actions**, e.g. skill-level adjustment | **The single best "AI in games" code.** |
| A63F13/70 ✔ | Game security or game management aspects | Anti-cheat, in-game economy, matchmaking |
| A63F13/80 ✔ | Special adaptations for executing a specific game genre or game mode | Genre-specific technique |
| A63F13/30 ✔ | Interconnection arrangements between game servers / game devices | **Online / multiplayer / netcode** |
| A63F13/40 ✔ | Processing input control signals | Controllers, gesture, eye-tracking |
| A63F13/20 / 13/25 ✔ | Input / output arrangements for video game devices | Hardware — *lower value, see note* |
| A63F13/90 ✔ | Constructional details of video game devices (housing, wiring, cabinets) | Hardware — *lowest value* |
| ⚠ A63F13/86 | Believed: additional services / adaptive difficulty | **Needs verification** |
| ⚠ A63F13/92 / 13/95 | Believed: VR/AR and cloud gaming | **Needs verification** — high value if real |

**Recommendation:** do **not** ship 13/20, 13/25 or 13/90. They are cabinet and
controller hardware — a large share of A63F13 volume and almost no competitive
intelligence for an AI-in-games product. Excluding them is a big relevance win.

---

## 3. Proposed filter set — AI (row 2)

### 3A. Core AI for games and interactive content ✔ all verified

| Code | Title | Relevance |
|---|---|---|
| **G06N3/006** | Artificial life — based on **simulated virtual individual or collective life forms**, e.g. social simulations, particle swarm optimisation. The official CPC definition names "metaverse, virtual reality, virtual world, virtual society, social simulations, autonomous/learning agents or bots". | **Highest-value AI code for us.** This is literally AI for virtual worlds and agents. |
| G06N3/092 | Reinforcement learning | Agents, NPC policy, GameNGen-style work |
| G06N3/0475 | Generative networks | GAN/diffusion — generative art, assets, world models |
| G06N3/0455 | Auto-encoder / encoder-decoder networks | Transformer-family sequence models |
| G06N3/094 | Adversarial learning | GAN training |
| G06N3/0442 | Recurrent networks characterised by memory or gating (LSTM/GRU) | Dialogue/sequence state |
| G06N3/0895 | Weakly supervised (semi-/self-supervised) learning | Modern pre-training |
| G06N5/01 | Dynamic search techniques; heuristics; dynamic trees; branch-and-bound | **Classical game AI** — minimax, pathfinding, planning |
| G06N5/02 | Knowledge representation; symbolic representation | Behaviour trees, state machines, knowledge graphs |
| G06N5/04 | Inference or reasoning models | NPC reasoning |
| G06N5/045 | Explanation of inference; **explainable AI [XAI]** | Ties directly to the app's EU AI Act / transparency angle |
| G06N20/00 | Machine learning (general) | Broad catch-all under G06N |

### 3B. Suggested exclusions (currently swept in by `G06N`)

G06N10/xx quantum computing · G06N3/002 biomolecular · G06N3/123 DNA computing ·
G06N3/126 evolutionary algorithms · G06N3/06x hardware realisation ·
G06N3/12 genetic models · G06N7/0x mathematical models.

### 3C. On "accessible online"

Ambiguous — two readings, and I'd rather ask than guess:
- **AI delivered as an online/cloud service** → that is a *deployment* attribute,
  not a CPC class. Best handled by a keyword (`ta all "cloud"`) or by
  G06N3/098 (distributed/federated learning), not a classification filter.
- **Accessibility for disabled players** → that lives in G06F3/01 (user–computer
  interaction) and A63F13/40 (input processing), not G06N.

### 3D. On "interactive LLMs"

Needs a **G06F40** code, not G06N. Likely candidates (⚠ **unverified — must
confirm before use**): G06F40/30 (semantic analysis), G06F40/35 (discourse /
dialogue), G06F40/40 (machine translation), G06F40/58 (…). I will not guess
these into the PR; I'll verify them in the same pass as §5.

---

## 4. UX: how to present this

A flat row of 20 chips is unusable. Proposal:

```
Games   [All video games A63F13/00] [Game AI & adaptation 13/67] [Procedural content 13/60]
        [Characters & physics 13/55,13/57] [Online & multiplayer 13/30] [Game management 13/70]

AI      [Virtual worlds & agents G06N3/006] [Reinforcement learning 3/092]
        [Generative networks 3/0475] [Classical game AI G06N5/01] [Explainable AI 5/045]
```

- **Grouped rows with a header** (`Games` / `AI`), chips carrying a short human
  label plus the code in a `<span>`.
- Each chip maps to **one or more CPC codes** (OR'd), so "Characters & physics"
  can mean `13/55 OR 13/57`. This requires the chip model to hold an *array* of
  codes rather than a single string — a small data-model change.
- **Default when nothing selected:** `A63F13/00` alone. That is the tightest
  useful default and immediately fixes the pinball/roulette problem.
- Keep the existing free-text keyword box; it composes with the chips.

---

## 5. The one real technical risk: CPC hierarchy in OPS

Everything above assumes that searching a CPC **group** also returns its
**subgroups** — i.e. that `cpc = "A63F13/00"` retrieves patents classified in
`A63F13/67`.

Evidence it works at *subclass* level: the current `cpc = "A63F"` returns results.
Evidence it works at *group* level: **none yet.** This is the single assumption
most likely to break the feature, and if it is false, every group-level code
silently returns zero — exactly the failure mode we just spent two PRs fixing.

**Proposed safeguard (do this first, not last):**

1. Extend `buildCql` to accept group/subgroup codes
   (`A63F13/00`, `A63F13/67`, `G06N3/092`). The current validator is
   `/^[A-Z][0-9]{2}[A-Z]$/` — subclass-only, so this **must** change anyway.
2. Add a dev/admin probe `GET /api/patents/validate-cpc` (admin-gated) that runs
   one search per configured code and returns `total-result-count` for each.
3. Run it once after deploy. Any code returning 0 is either wrong or
   non-hierarchical → fix or drop it before exposing it as a chip.

Optionally, and I think worth it: **show live hit counts on the chips**
(`Showing X of Y matches` already exists in the results header). It doubles as
permanent verification and as a usability signal. Cost: one cached OPS call per
chip.

---

## 6. Headline translation

### What happens today

`normaliseDocument()` runs `pickEnglish()`, which prefers the `@lang="en"` title
and otherwise takes the **first** variant. The chosen language is then **thrown
away**. So a CN-only patent shows a Chinese title and the UI has no way to know
it is Chinese — which is why you are seeing this.

### Proposed design

**Server**
1. Return `titleLang` (from `@lang`) on every card, and keep all title variants.
2. New `POST /api/patents/translate` (auth-gated, same as `/api/patents`):
   - body `{ pn, title, target }`
   - validate `pn` (`/^[A-Z]{2}[0-9A-Z]{1,15}$/`), `title` length ≤ 400,
     `target ∈ {en, zh-CN}` — the length cap is the abuse/cost guard
   - cache lookup → `mtService.translateText(title, { target })` → store → return
   - on any failure return a clean error and **leave the original title on screen**
3. New self-healing table, mirroring `news_translations`:

```sql
CREATE TABLE IF NOT EXISTS patent_translations (
  pn            TEXT NOT NULL,
  lang          TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  title_source  TEXT NOT NULL,
  title_target  TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (pn, lang)
);
```

4. Reuse `lib/mtService.js` as-is. It already provides exactly what is needed:
   `translateText`, DeepL→Google fallback, and chip-fidelity verification (it
   refuses a translation that mangles embedded codes — important for titles
   containing publication numbers). `/healthz` already reports
   `deeplWorking: true`, so the key is live.

**Client**
- Each card gains `titleLang`. If it differs from the UI language, render a small
  **Translate** button next to the title.
- Detection: use `titleLang` when present; otherwise fall back to existing
  helpers — `mtService.hasCjk()` for Chinese, and `isLikelyEnglish()` /
  `looksNonEnglish()` (already in `server.js`) for other scripts.
- On success, swap the title in place and flip the button to **Show original**
  (no refetch on toggle).
- Never auto-translate. Titles are short and DeepL quota is finite; make it opt-in
  per card. Batching a whole page is a possible follow-up.

**New locale keys:** `patents.translate`, `patents.showOriginal`,
`patents.translating`, `patents.translationFailed` (en + zh-CN).

---

## 7. File-by-file breakdown

| File | Change |
|---|---|
| `lib/epoOps.js` | `CPC_PRESETS` → richer structure: id, label, group, `codes[]`. Extend CPC validator to accept `A63F13/00`-style codes. |
| `server.js` | New `POST /api/patents/translate`; `patent_translations` table (self-healing); optional `GET /api/patents/validate-cpc` (admin-gated); expose `titleLang` (already flowing once normaliser keeps it). |
| `lib/epoOps.js` | `normaliseDocument`: keep all `invention-title` variants, set `titleLang`. |
| `public/index.html` | Grouped chip rows (`Games` / `AI`) instead of one flat row. |
| `public/app.js` | Render grouped chips with multi-code mapping; translate button + swap-original; re-render on `langchange`. |
| `public/locales.js` | New `patents.*` strings, en + zh-CN. |
| `public/styles.css` | Chip-group layout; translate button. |
| `test/epo-ops.test.cjs` | New CPC code forms; multi-code chips. |
| `test/patents-route.test.cjs` | Translate endpoint (cached/uncached/failure); `titleLang` present; validation rejects bad input. |

---

## 8. Test plan

- CPC: `A63F13/00`, `A63F13/67`, `G06N3/092` all emit valid CQL; malformed codes
  rejected; a multi-code chip ORs correctly.
- `titleLang` is returned and reflects `@lang`; falls back correctly when absent.
- Translate: cache hit skips DeepL; cache miss stores; DeepL failure leaves the
  original title and returns a clean error; input validation rejects
  over-length titles and bad `pn`/`target`.
- Full suite green (`node --test "test/**/*.test.cjs"`).

---

## 9. Decisions I need from you

1. **Scope of row 1** — include controller/cabinet hardware (13/20, 13/25, 13/90)?
   *My recommendation: exclude.*
2. **Default filter** — should `A63F13/00` be pre-selected, or start unfiltered?
   *Recommendation: pre-selected; it is the fix for the pinball problem.*
3. **"Accessible online"** — cloud-delivered AI, or accessibility for disabled
   players? (§3C)
4. **Interactive LLMs** — is dialogue/NPC conversation in scope? If yes I will
   verify and add G06F40 codes (§3D).
5. **Chip hit counts** — worth one cached OPS call per chip to show live counts?
   *Recommendation: yes, it doubles as verification.*
6. **Translation scope** — headline only (as asked), or headline + abstract?
   Abstracts are ~5× the characters, so ~5× the DeepL cost.

Nothing here is written to the app yet — say which options you want and I'll
build it.
