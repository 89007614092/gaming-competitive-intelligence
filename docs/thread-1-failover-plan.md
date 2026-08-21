# Thread #1 — Same-Account Groq Two-Model Failover (BUILD PLAN, for review)

Status: **PLANNED, NOT BUILT.** Molly to review before implementation.

## Goal
If the primary Groq model fails (network error, timeout/abort, 5xx, daily-cap 429, or empty/degenerate response), automatically retry the *same request* on a second Groq model. Same account, same API key + base URL — only the **model name** differs. **No new account, no new dependency, no schema change, no architectural fork.**

## New env var
- `OPEN_MODEL_NAME_FALLBACK` — default `""` (unset = failover disabled, today's behavior preserved).
  - **Recommended value: `qwen/qwen3-32b`** (Alibaba, Groq-hosted, OpenAI-compatible, same account/key/base). Chosen because it is a **different model family** from the `openai/gpt-oss-120b` primary — a gpt-oss-specific outage/rate-limit/deprecation does NOT also take down the fallback. (gpt-oss-20b is a same-family fallback and is weaker against a family-wide incident, so it is NOT the recommended default.)
  - Confirmed active on Groq as of 2026-08-21 (catalog lists `qwen/qwen3-32b`, 128K context). **`llama-*` is NOT recommended** — llama models are being disabled on Groq (llama-3.3-70b-versatile unavailable), which defeats the purpose of failover.
- Reuses existing `OPEN_MODEL_API_KEY` + `OPEN_MODEL_BASE_URL`.

## Code changes — `summarise-engine.js`
1. Add near the top (after `DEFAULT_MODEL`):
   ```js
   const OPEN_MODEL_NAME_FALLBACK = process.env.OPEN_MODEL_NAME_FALLBACK || "";
   const QA_FAILOVER_ENABLED = !!OPEN_MODEL_NAME_FALLBACK && OPEN_MODEL_NAME_FALLBACK !== DEFAULT_MODEL;
   ```
2. Add a shared low-level helper `postQaChatCompletions({ body, timeoutMs = 60000 })` that:
   - Iterates models `[DEFAULT_MODEL]` then (if `QA_FAILOVER_ENABLED`) `[OPEN_MODEL_NAME_FALLBACK]`.
   - Per model, performs the `fetch(`${OPEN_MODEL_BASE_URL}/chat/completions`, …)` with `Bearer ${OPEN_MODEL_API_KEY}`.
   - **Preserves existing 429 semantics:** a short-throttle 429 (small `Retry-After` ≤ `QA_RETRY_AFTER_CAP_MS`) is retried *on the same model* (current in-request retry); a long/daily-cap 429 still sets `qaRateLimitedUntil` cooldown. Only *other* failures (network err, abort, 5xx, empty parse) advance to the next model.
   - Returns `{ content, model }` on success; throws after all models fail.
3. Refactor the two **user-facing (QA)** call sites to use it:
   - `runApiModelGeneration` (line 363): replace its inner `fetch` loop's model with the helper's outer model loop; keep the 429 short-throttle + `qaRateLimitedUntil` cooldown logic intact inside. On total failure it still throws → server.js falls back to the extractive answer as today.
   - `nudgeForUserSources` (line 313): route its `fetch` through `postQaChatCompletions` (its current degrade-to-`currentAnswer` behavior is preserved; failover just makes a successful nudge more likely).
4. **Reasoning-token suppression (Qwen3 gotcha):** Qwen3 emits `<think>` reasoning blocks by default, which would bloat the answer and burn quota on the failover path. Extend the current gpt-oss handling:
   - `postQaChatCompletions` sends `reasoning_effort:"low"` when the model matches `/gpt-oss/` (existing behavior) AND `thinking:{type:"disabled"}` when the model matches `/qwen3?|qwen-3/` (best-effort, provider-dependent).
   - **Safety net:** always strip any `<think>…</think>` span from the returned `content` before returning, so a reasoning model that ignores the disable flag still yields clean text.
5. **Out of scope for #1:** the background scan lane (`runModelChat` / `OPEN_MODEL_NAME_SCAN`) is intentionally left untouched. This keeps #1 a pure QA-shim, matching the original "add QA shim" scope.

## Tests — `test/model-failover.test.cjs` (node --test, matches `test/**/*.test.cjs`)
- Primary success → **no** second call (failover never fires on success).
- Primary throws (mock `fetch` rejection) → fallback called → success returned.
- Primary + fallback both fail → throws (server.js extractive fallback still engages).
- 429 short-throttle → waits `Retry-After`, retries same model (no premature model switch).
- Daily-cap 429 → sets `qaRateLimitedUntil` (cooldown honored).

## Rollout
- Behavior is **identical** when `OPEN_MODEL_NAME_FALLBACK` is unset → zero risk on deploy.
- Optional: set `OPEN_MODEL_NAME_FALLBACK=openai/gpt-oss-20b` in Render env to activate (no restart beyond normal deploy).
- Ships via normal PR + manual deploy (Auto-Deploy OFF).

## Risk / reversible
Fully additive; guarded by the env var. If the fallback model behaves oddly, unset the var → instant revert.
