# Non-compaction auto-retry policy

This document describes the standard API-error retry path in `AgentSession`.

It explicitly excludes context-overflow recovery via auto-compaction. Overflow is handled by compaction logic and is documented separately in [`compaction.md`](../compaction.md).

## Implementation files

- [`../src/session/agent-session.ts`](../../packages/coding-agent/src/session/agent-session.ts)
- [`../src/config/settings-schema.ts`](../../packages/coding-agent/src/config/settings-schema.ts)
- [`../src/modes/controllers/event-controller.ts`](../../packages/coding-agent/src/modes/controllers/event-controller.ts)
- [`../src/modes/controllers/input-controller.ts`](../../packages/coding-agent/src/modes/controllers/input-controller.ts)
- [`../src/modes/rpc/rpc-mode.ts`](../../packages/coding-agent/src/modes/rpc/rpc-mode.ts)
- [`../src/modes/rpc/rpc-client.ts`](../../packages/coding-agent/src/modes/rpc/rpc-client.ts)
- [`../src/modes/rpc/rpc-types.ts`](../../packages/coding-agent/src/modes/rpc/rpc-types.ts)

## Scope boundary vs compaction

Retry and compaction are checked from the same `agent_end` maintenance path, in this order:

1. A successful `yield` this run (or a pending yield termination) suppresses all retry/continuation; only an active goal still runs `#checkCompaction(...)`.
2. `#handleEmptyAssistantStop(...)` strips and self-retries empty tool-use stops before anything else.
3. With an active goal, `#checkCompaction(...)` runs as a **pre-empt** before retry; a deferred handoff / scheduled continuation ends the turn there.
4. `#handleUnexpectedAssistantStop(...)` handles anomalous stops.
5. `#isRetryableReasonlessAbort(...)` retries empty reason-less provider aborts (no model fallback).
6. A deliberate `aborted` stop settles the turn (no retry, no queued continuations).
7. `#isFireworksFastFallbackEligible(...)` degrades a Fireworks Fast variant to its base model: even for hard errors the generic classifier rejects, and even with `retry.enabled === false`.
8. `#isRetryableError(...)` drives the standard retry engine.
9. Otherwise, `#isHardErrorFallbackEligible(...)` gives a non-retryable hard error one fallback-chain consult (`hardErrorFallback: true`); if no model switch happens, the error surfaces instead of backoff-retrying the failing model.
10. If nothing retried, the bottom `#checkCompaction(...)` runs (unless the active-goal pre-empt already did).

Context-overflow errors are hard-excluded from retry classification (`AIError.isContextOverflow(...)` short-circuits `#isRetryableError`), so overflow always falls through to compaction recovery. Overload/rate/server/network-style failures use this retry policy.

## Retry classification

Classification is **typed**, not ad-hoc regex at the call site: `#classifyRetryMessage(...)` calls `AIError.classifyMessage(...)` (`packages/ai/src/error/flags.ts`), which folds the message's existing `errorId`, HTTP status, and text patterns into a bit-flag error id (re-classified against the *active session model's* API when a test shim or adapter reported a different one). `#isRetryableError(...)` then requires all of:

- assistant `stopReason === "error"`
- message is **not** context overflow (`AIError.isContextOverflow` checks the `ContextOverflow` flag, token usage vs the context window, and overflow text patterns)
- one of:
  - the stop is a classifier refusal (`stopDetails.type` is `"refusal"` or `"sensitive"`: checked first, from the typed field)
  - `AIError.retriable(id, { replayUnsafe })` is true

`AIError.retriable` semantics:

- retryable kinds: `Transient`, `Timeout`-tagged transients, `UsageLimit`, `ThinkingLoop`, `StaleResponsesItem`, `ProviderFinishError`
- `ContentBlocked` is never retryable
- `MalformedFunctionCall` is always retryable (even replay-unsafe)
- `replayUnsafe` kills retry for everything else. It is set by `#hasReplayUnsafeToolOutput(...)`: the failed assistant message contains a **tool call** block. Text/thinking-only partials are safe to discard and replay; a retained tool call is not, because its tool result may already exist and replaying can duplicate work.

The `Transient` patterns (in `flags.ts`) cover overload/rate-limit/429/5xx wording, provider-suggested-retry wording, network/socket/timeout failures, Anthropic stream-envelope failures before `message_start`, and unexpected socket closes. `StaleResponsesItem` (OpenAI Responses APIs only) matches `Item with id '…' not found` / invalid/expired `previous_response`. A deterministic llama.cpp/Ollama tool-call JSON parse failure strips `Transient` so it surfaces instead of looping.

Beyond `#isRetryableError(...)`, a narrower trigger feeds the same retry engine: `#isRetryableReasonlessAbort(...)` routes a **content-less** stop carrying the generic abort sentinel (`"Request was aborted"`), whether finalized as `stopReason: "aborted"` or leaked as `"error"`, into `#handleRetryableError(message, { allowModelFallback: false })`. It never fires while a user abort, dispose, or streaming-edit-guard abort is in progress; those are deliberate and settle the turn.

## Retry lifecycle and state transitions

Session state used by retry:

- `#retryAttempt: number` (`0` means idle)
- `#retryPromise: Promise<void> | undefined` (tracks in-progress retry lifecycle)
- `#retryResolve: (() => void) | undefined` (resolves `#retryPromise`)
- `#retryAbortController: AbortController | undefined` (cancels backoff sleep)

Flow (`#handleRetryableError`):

1. Read `retry` settings group.
2. If `retry.enabled === false`, stop immediately: **except** the Fireworks Fast→base degrade (`fireworksFastFallback: true`), which is an intrinsic model-selection safety net and runs even with retries disabled.
3. Increment `#retryAttempt`.
4. Create `#retryPromise` once (first attempt in a chain).
5. Exceeding `retry.maxRetries` does **not** fail immediately: the fallback chain below gets one last consult (credential rotation can spend the whole budget without the fallback branch ever running). Only if no model switch happens does it emit the final failure event and stop. A successful last-resort switch resets the counter to `1`: the fallback model gets a fresh retry budget.
6. Compute capped jittered local delay via `calculateRetryBackoffDelayMs`: `min(retry.baseDelayMs * 2^(attempt-1), 8000ms) * (75–100% jitter)`. Stale OpenAI Responses replay errors skip the backoff entirely (delay `0`) after resetting the cached provider session.
7. For usage-limit errors, parse retry hints and call auth storage (`markUsageLimitReached(...)`); if credential switching succeeds, including spending a banked Codex reset via the opt-in auto-redeem, force delay to `0`. Otherwise wait for whichever comes first, the provider's retry-after/backoff hint, or the earliest moment a temporarily blocked sibling credential frees up (`retryAtMs` + `SIBLING_UNBLOCK_BUFFER_MS`, 1s) so the next attempt can pick it up.
8. If no credential switch occurred and `retry.modelFallback` is enabled, suppress the current model selector for cooldown and try configured retry model fallback chains, forcing delay to `0` on model switch. Classifier refusals skip the cooldown, pin the fallback, and never use the exhausted-budget last resort; with no fallback applied, the chain ends without an `auto_retry_start`. `fireworksFastFallback` / `hardErrorFallback` entries that fail to switch also bail out here rather than backoff-retrying a model the generic classifier would not retry.
9. If the final delay exceeds `retry.maxDelayMs` and no credential/model switch happened, emit final failure and do not sleep.
10. Record the pending recovered-retry error (surfaced later in `auto_retry_end.recoveredErrors`) and emit `auto_retry_start` (includes the classified `errorId`).
11. Remove the trailing assistant error message from agent runtime state (kept in persisted session history). For a `ThinkingLoop`-classified error, inject a hidden redirect so the retried turn breaks the repeated pattern instead of re-sampling the same stalled reasoning.
12. Sleep with abort support.
13. Schedule `agent.continue()` through the post-prompt task scheduler (`delayMs: 1`) for the same prompt generation.

### What resets retry counters

`#retryAttempt` resets to `0` in these cases:

- first successful non-error, non-aborted assistant message after retries started (emits `auto_retry_end { success: true }`)
- retry cancellation during backoff sleep
- max retries exceeded path
- max delay exceeded path
- classifier refusal with no fallback model applied (chain ends silently, no retry started)

`#retryPromise` resolves/clears when retry chain ends (success, cancellation, max-exceeded, max-delay failure, or classifier-refusal stop), via `#resolveRetry()`.

## Backoff and max-attempt semantics

Settings:

- `retry.enabled` (default `true`)
- `retry.maxRetries` (default `10`)
- `retry.baseDelayMs` (default `500`)
- `retry.maxDelayMs` (default `300000`, 5 minutes; `<= 0` disables the fail-fast cap)

Attempt numbering:

- attempt counter is incremented before max-check
- start events use current attempt (1-based)
- max-exceeded end event reports `attempt: this.#retryAttempt - 1` (last attempted retry count)

Backoff sequence with default settings, before jitter:

- attempt 1: 500 ms
- attempt 2: 1000 ms
- attempt 3: 2000 ms
- attempt 4: 4000 ms
- attempt 5+: 8000 ms

The actual local sleep is 75–100% of the nominal value, matching Anthropic-style retry jitter so concurrent sessions do not retry in lockstep.

Delay override inputs can come from parsed retry headers (`retry-after-ms`, `retry-after`, `x-ratelimit-reset-ms`, `x-ratelimit-reset`) or usage-limit backoff. Credential/model fallback switches set delay to `0`; otherwise parsed hints can extend the capped local delay. If the computed delay is greater than `retry.maxDelayMs` and no switch succeeded, retry ends immediately with a final error instead of sleeping.

## Abort mechanics

### Explicit retry abort

`abortRetry()`:

- aborts `#retryAbortController` (if present)
- resolves retry promise (`#resolveRetry()`) so awaiters are unblocked

If abort hits while sleeping, catch path emits:

- `auto_retry_end { success: false, finalError: "Retry cancelled" }`
- resets attempt/controller

### Global operation abort interaction

`abort()` calls `abortRetry()` before aborting the active agent stream. This guarantees retry backoff is cancelled when user issues a general abort.

### TUI interaction

On `auto_retry_start`, EventController (`#handleAutoRetryStart`):

- stops the working loader and clears the status container
- renders a `retryLoader` with text: `Retrying (attempt/maxAttempts) in Ns…` plus the maintenance esc-hint (e.g. `(esc to cancel)`)

`Esc` cancellation dispatches on live session state rather than a swapped handler: the input controller checks `viewSession.isRetrying` and calls `viewSession.abortRetry()` (alongside its compaction/handoff abort checks).

On `auto_retry_end` (`#handleAutoRetryEnd`), it stops and clears the `retryLoader` and status container.

## Streaming and prompt completion behavior

`prompt()` ultimately waits on `#waitForPostPromptRecovery()` after `agent.prompt(...)` returns; that loop awaits the retry lifecycle promise alongside TTSR resume and deferred post-prompt tasks.

Effect:

- a prompt call does not fully resolve until any started retry chain finishes (success/failure/cancel)
- retry lifecycle is part of one logical prompt execution boundary

This prevents callers from treating a retrying turn as complete too early.

## Controls: settings and RPC

### Configuration knobs

Defined in settings schema under retry group:

- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`
- `retry.maxDelayMs`
- `retry.modelFallback` (default `true`; gates retry model-fallback switching)
- `retry.fallbackChains`
- `retry.fallbackRevertPolicy` (`"cooldown-expiry"` by default; `"never"` disables automatic restoration)

Programmatic toggles in session:

- `setAutoRetryEnabled(enabled)` writes `retry.enabled`
- `autoRetryEnabled` reads `retry.enabled`
- `isRetrying` reports whether retry lifecycle promise is active

### RPC controls

RPC command surface:

- `set_auto_retry` → `session.setAutoRetryEnabled(command.enabled)`
- `abort_retry` → `session.abortRetry()`

Client helpers:

- `RpcClient.setAutoRetry(enabled)`
- `RpcClient.abortRetry()`

Both commands return success responses; retry progress/failure details come from streamed session events, not command response payloads.

## Event emission and failure surfacing

Session-level retry events:

- `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage, errorId? }`
- `auto_retry_end { success, attempt, finalError?, recoveredErrors? }`
- `retry_fallback_applied { from, to, role }`
- `retry_fallback_succeeded { model, role }`

Propagation:

- emitted through `AgentSession.subscribe(...)`
- forwarded to extension runner as extension events
- in RPC mode, forwarded directly as JSON event objects (`session.subscribe(event => output(event))`)
- in TUI, consumed by `EventController` for loader/error UI

Final failure surfacing:

- On max-exceeded, max-delay failure, or cancellation, `auto_retry_end.success === false`
- TUI shows: `Retry failed after N attempts: <finalError>`
- Extensions/hooks receive `auto_retry_end` with same fields
- RPC consumers receive same event object on stdout stream

## Permanent stop conditions

Retry stops and will not auto-continue when any of these occur:

- `retry.enabled` is false
- error is not retry-classified
- error is context overflow (delegated to compaction path)
- max retries exceeded
- provider-requested delay exceeds `retry.maxDelayMs` and no credential/model switch is available
- user cancels retry (`abort_retry` or `Esc` during retry loader)
- global abort (`abort`) cancels retry first

A new retry chain can still start later on a future retryable error after counters reset.

## Operational caveats

- Classification produces typed `AIError` flag ids, but the inputs are still largely text patterns plus HTTP status; structural provider signals (`ProviderHttpError` codes, known error classes, `stopDetails`) are folded in where they exist.
- Retry strips the failing assistant error from **runtime context** before re-continue, but session history still keeps that error entry.
- `RpcSessionState` currently exposes `autoCompactionEnabled` but not an `autoRetryEnabled` field; RPC callers must track their own toggle state or query settings through other APIs.
- Model fallback changes append temporary `model_change` entries and may later restore the primary model when its cooldown expires, depending on `retry.fallbackRevertPolicy`.

*Verified against `7ca44d3` on 2026-07-17.*
