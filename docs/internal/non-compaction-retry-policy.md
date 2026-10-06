# Non-compaction auto-retry policy

This document describes the standard API-error retry path of `AgentSession`. The session routes a settled stop; `RetryRuntime` holds the retry ladder, `RetryFallback` the model-fallback chains, and `StopRetries` the empty-stop and unexpected-stop retries.

It explicitly excludes context-overflow recovery via auto-compaction. Overflow is handled by compaction logic and is documented separately in [`../handbook/src/architecture/compaction.md`](../handbook/src/architecture/compaction.md).

## Implementation files

- [`../src/session/agent-session.ts`](../../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/runtime/retry-runtime.ts`](../../packages/coding-agent/src/session/runtime/retry-runtime.ts)
- [`../src/session/runtime/retry-fallback.ts`](../../packages/coding-agent/src/session/runtime/retry-fallback.ts)
- [`../src/session/runtime/stop-retries.ts`](../../packages/coding-agent/src/session/runtime/stop-retries.ts)
- [`../src/session/failed-turn.ts`](../../packages/coding-agent/src/session/failed-turn.ts)
- [`kernel/src/session/retry-policy.ts`](../../kernel/src/session/retry-policy.ts)
- [`packages/ai/src/error/registry.ts`](../../packages/ai/src/error/registry.ts)
- [`../src/config/settings-domains/model.ts`](../../packages/coding-agent/src/config/settings-domains/model.ts)
- [`../src/modes/terminal/controllers/event-controller.ts`](../../packages/coding-agent/src/modes/terminal/controllers/event-controller.ts)
- [`../src/modes/terminal/controllers/input-controller.ts`](../../packages/coding-agent/src/modes/terminal/controllers/input-controller.ts)
- [`../src/modes/rpc/rpc-commands.ts`](../../packages/coding-agent/src/modes/rpc/rpc-commands.ts)
- [`../src/modes/rpc/rpc-client.ts`](../../packages/coding-agent/src/modes/rpc/rpc-client.ts)
- [`../src/modes/rpc/rpc-types.ts`](../../packages/coding-agent/src/modes/rpc/rpc-types.ts)

## Scope boundary vs compaction

Retry and compaction are checked from the same `agent_end` maintenance path (`#runAgentEndMaintenance`, then `#settleStop` in `agent-session.ts`), in this order:

1. A successful `yield` this run (or a pending yield termination) suppresses all retry/continuation; only an active goal still runs `#trackedCompactionCheck(...)`.
2. `StopRetries.onEmptyStop(...)` strips and self-retries empty stops before anything else.
3. With an active goal, `#trackedCompactionCheck(...)` runs as a **pre-empt** before retry; a scheduled or blocked automatic continuation ends the turn there.
4. `StopRetries.onUnexpectedStop(...)` handles a reply that stopped short of an action it announced.
5. `RetryRuntime.recoverFailedTurn(...)` runs the failed-turn ladder:
   1. `#isRetryableReasonlessAbort(...)` retries empty reason-less provider aborts (no model fallback).
   2. A deliberate `aborted` stop settles the turn (no retry, no queued continuations).
   3. `RetryFallback.fireworksFastEligible(...)` degrades a Fireworks Fast variant to its base model: even for hard errors the generic classifier rejects, and even with `retry.enabled === false`.
   4. `#isRetryableError(...)` drives the standard retry engine.
   5. Otherwise, `RetryFallback.hardErrorEligible(...)` gives a non-retryable hard error one fallback-chain consult (`hardErrorFallback: true`); if no model switch happens, the error surfaces instead of backoff-retrying the failing model.
   6. `#continueAfterUnreplayableBatch(...)` continues a turn whose retry was refused only for replay safety (see [Unreplayable tool batches](#unreplayable-tool-batches)).
6. A classifier refusal that nothing retried is removed from active context.
7. If nothing retried, the bottom `#trackedCompactionCheck(...)` runs (unless the active-goal pre-empt already did), followed by the settle-time continuations and `session_stop`.

Context-overflow errors are hard-excluded from retry classification (`AIError.isContextOverflow(...)` short-circuits `RetryRuntime.#isRetryableError`), so overflow always falls through to compaction recovery. Overload/rate/server/network-style failures use this retry policy.

## Retry classification

Classification is **typed**, not ad-hoc regex at the call site: `RetryRuntime.#classify(...)` calls `AIError.classifyMessage(...)` (`packages/ai/src/error/flags.ts`), which folds the message's existing `errorId`, HTTP status, and text patterns into a bit-flag error id (re-classified against the *active session model's* API when a test shim or adapter reported a different one) and logs the rules that fired at debug level. `#isRetryableError(...)` then requires all of:

- assistant `stopReason === "error"`
- message is **not** context overflow (`AIError.isContextOverflow` checks the `ContextOverflow` flag, token usage vs the context window, and overflow text patterns)
- one of:
  - the stop is a classifier refusal (`stopDetails.type` is `"refusal"` or `"sensitive"`: checked first, from the typed field)
  - `AIError.retriable(id, { replayUnsafe })` is true

`AIError.retriable` semantics (`packages/ai/src/error/registry.ts`, derived from `ERROR_DOMAINS`):

- retryable kinds: every family whose turn-stage recovery is `retry`: `Transient` (`transport`), `UsageLimit` (`quota`), `ProviderFinishError` and `StaleResponsesItem` (`stream`), `ThinkingLoop` (`thinking-loop`), and `MalformedFunctionCall` (`tool-call`). The `timeout` family recovers by switching models, so a `Timeout` failure retries only when a retryable flag such as `Transient` is also set.
- vetoing kinds refuse a retry for the whole failure however the rest classified: `ContentBlocked` (`content`), `TransportRefused` (`refusal`), and `Abort` / `UserInterrupt` / `SilentAbort` (`interrupt`)
- `MalformedFunctionCall` is replay-safe: it retries even when `replayUnsafe` is set
- `replayUnsafe` kills retry for everything else. It is set by `hasReplayUnsafeToolOutput(message, context)` (`session/failed-turn.ts`). A tool call in a failed turn is not evidence that the tool ran: an `error` stop returns before `executeToolCalls` and pairs every retained call with a never-ran placeholder result. Two shapes are unsafe: a Cursor exec-channel block carrying `kCursorExecResolved`, which dispatched inside the provider stream, and a call answered in context by a result that is not a never-ran placeholder.

The `Transient` rules are the `transport` family in `packages/ai/src/error/domains/network.ts`: overload/rate-limit/429/5xx wording, named HTTP/2 codes, stream corruption, network/socket/timeout failures, and unexpected socket closes. `StaleResponsesItem` (`domains/turn.ts`, OpenAI Responses and Codex Responses APIs only) matches `Item with id '…' not found` / invalid/expired `previous_response`. A deterministic llama.cpp/Ollama tool-call JSON parse failure (`LLAMA_CPP_TOOL_CALL_PARSE_PATTERN` in `flags.ts`) strips `Transient` so it surfaces instead of looping.

Beyond `#isRetryableError(...)`, a narrower trigger feeds the same retry engine: `#isRetryableReasonlessAbort(...)` routes a **content-less** stop that classifies as `Abort` with `stopReason: "aborted"`, or carries the generic abort sentinel (`"Request was aborted"`) with `stopReason` `"aborted"` or `"error"`, into `#handleRetryableError(message, { allowModelFallback: false })`. It never fires while a user abort, dispose, or streaming-edit-guard abort is in progress; those are deliberate and settle the turn.

## Unreplayable tool batches

`#continueAfterUnreplayableBatch(...)` runs when a failed turn would have been retried but for replay safety: the failure is retriable with `replayUnsafe: false` and not with `replayUnsafe: true`, `hasReplayUnsafeToolOutput(...)` is true, and `toolBatchCanContinue(...)` reports that sending the turn now in context moves the work forward. Retry re-sends the turn; continuation sends the turn already in context, where every undispatched call is paired with a never-ran placeholder, so nothing is duplicated.

- Requires `retry.enabled` and no deliberate abort in progress.
- Counts on its own allowance (`#batchContinues`), sized by the resolved `maxRetries`, so a turn that already retried arrives with its continuation budget intact.
- Waits `unreplayableContinueDelayMs(policy, attempt)`: the retry backoff, capped by `retry.maxDelayMs` when that is positive.
- Warns through `operatorNotices` (`unreplayable-batch`), holds the retry gate, and emits `auto_retry_start` / `auto_retry_end` with `mode: "continue"`. Escape cancels the wait (`Continuation cancelled`).
- A landed turn resets the allowance; an empty turn does not. A prompt that accepts an empty completion as terminal closes the announced wait through `endAnnouncedContinuationWait(...)`.

## Retry lifecycle and state transitions

`RetryRuntime` state:

- `#attempt: number` (`0` means idle)
- `#gate: Promise<void> | undefined` (the retry gate: tracks the in-progress retry lifecycle and backs `isRetrying`)
- `#release: (() => void) | undefined` (resolves `#gate`)
- `#abortController: AbortController | undefined` (cancels the backoff sleep)
- `#batchContinues: number` (the unreplayable-batch continuation allowance spent this prompt)

Flow (`#handleRetryableError`, which wraps `#attemptRetry`):

1. Read the `retry` settings group, then resolve it against the active model through `#resolvePolicy(...)` (`resolveRetryPolicy` in `kernel/src/session/retry-policy.ts`). Precedence is a `retry.perProvider` entry, then a built-in `PROVIDER_RETRY_DEFAULTS` entry (`cursor`, `devin`), then the global settings; each layer overrides only the `maxRetries` / `baseDelayMs` / `maxDelayMs` fields it sets. Among `retry.perProvider` keys, `provider/model-id` outranks `provider/*` and a bare provider id.
2. If `retry.enabled === false`, stop immediately: **except** the Fireworks Fast→base degrade (`fireworksFastFallback: true`), which is an intrinsic model-selection safety net and runs even with retries disabled.
3. Increment `#attempt`.
4. Create the retry gate once (`#ensureGate()`, first attempt in a chain).
5. Exceeding `maxRetries` does **not** fail immediately: the fallback chain below gets one last consult (credential rotation can spend the whole budget without the fallback branch ever running). Only if no model switch happens does it persist the error message, emit the final failure event, and stop. A successful last-resort switch resets the counter to `1`: the fallback model gets a fresh retry budget.
6. Compute capped jittered local delay via `calculateRetryBackoffDelayMs` (`kernel/src/session/retry-policy.ts`): `min(baseDelayMs * 2^(attempt-1), RETRY_BACKOFF_MAX_DELAY_MS)`, with `RETRY_BACKOFF_MAX_DELAY_MS` = 8000 ms, reduced by up to `RETRY_BACKOFF_JITTER_RATIO` (25%). Stale OpenAI Responses replay errors skip the backoff entirely (delay `0`) after resetting the cached provider session.
7. For usage-limit errors, take the retry hint from the message or, absent one, the rate-limit backoff for the parsed reason, and call auth storage (`markUsageLimitReached(...)`); if credential switching succeeds, including spending a banked Codex reset via the opt-in auto-redeem, force delay to `0`. Otherwise wait for whichever comes first, the provider's retry-after/backoff hint, or the earliest moment a temporarily blocked sibling credential frees up (`retryAtMs` + `SIBLING_UNBLOCK_BUFFER_MS`, 1s) so the next attempt can pick it up.
8. If no credential switch occurred and `retry.modelFallback` is enabled, suppress the current model selector for cooldown (`RetryFallback.noteCooldown`) and try configured retry model fallback chains (`RetryFallback.tryChain`), forcing delay to `0` on model switch. Classifier refusals skip the cooldown, pin the fallback, and never use the exhausted-budget last resort; with no fallback applied, the chain ends without an `auto_retry_start`. `fireworksFastFallback` / `hardErrorFallback` entries that fail to switch also bail out here rather than backoff-retrying a model the generic classifier would not retry.
9. If the final delay exceeds `maxDelayMs` and no credential/model switch happened, persist the error message, emit final failure, and do not sleep.
10. Record the pending recovered-retry error (surfaced later in `auto_retry_end.recoveredErrors`) and emit `auto_retry_start` (includes the classified `errorId`).
11. Remove the trailing assistant error message from agent runtime state (kept in persisted session history). For a `ThinkingLoop`-classified error with `model.loopGuard.enabled`, inject a hidden redirect so the retried turn breaks the repeated pattern instead of re-sampling the same stalled reasoning.
12. Sleep with abort support. An abort that lands before the sleep starts cancels it.
13. Schedule `agent.continue()` through the post-prompt task scheduler (`delayMs: 1`) for the same prompt generation.

A step that throws (the auth store, a credential lookup, the session file) ends the sequence: `#handleRetryableError` resets the counter, emits `auto_retry_end { success: false, finalError: "Retry recovery failed: …" }`, and returns `false`, so the settle path closes the retry gate.

### What resets retry counters

`#attempt` resets to `0` in these cases:

- first landed assistant message after retries started: not an error, not aborted, not empty (`closeRecovered`, which emits `auto_retry_end { success: true }`)
- retry cancellation during backoff sleep
- max retries exceeded path
- max delay exceeded path
- classifier refusal with no fallback model applied (chain ends silently, no retry started)
- a Fireworks Fast or hard-error fallback entry that could not switch
- a throw inside the retry sequence
- the empty-stop retry cap (`failAtEmptyStopCap`)
- a manual `retry()` of the last failed turn (`retryLastFailedTurn`), which starts a fresh budget

The retry gate resolves and clears through `RetryRuntime.resolve()` when the chain ends: success (from the settle path), cancellation, max-exceeded, max-delay failure, classifier-refusal stop, or empty-stop cap.

## Backoff and max-attempt semantics

Settings:

- `retry.enabled` (default `true`)
- `retry.maxRetries` (default `10`)
- `retry.baseDelayMs` (default `500`)
- `retry.maxDelayMs` (default `300000`, 5 minutes; `<= 0` disables the fail-fast cap)

Attempt numbering:

- attempt counter is incremented before max-check
- start events use current attempt (1-based)
- max-exceeded end event reports `attempt: this.#attempt - 1` (last attempted retry count)

Backoff sequence with default settings, before jitter:

- attempt 1: 500 ms
- attempt 2: 1000 ms
- attempt 3: 2000 ms
- attempt 4: 4000 ms
- attempt 5+: 8000 ms

The actual local sleep is 75–100% of the nominal value (`RETRY_BACKOFF_JITTER_RATIO` removes up to 25% and never adds), so concurrent sessions do not retry in lockstep.

Delay override inputs come from a retry window stated in the error message, read by `extractRetryHint` (`@veyyon/utils/fetch-retry`) for each header form in `RETRY_HINT_HEADERS` (`retry-after-ms`, `retry-after`, `x-ratelimit-reset-ms`, `x-ratelimit-reset`, `x-ratelimit-reset-after`) and its prose phrasings, or from usage-limit backoff. A zero or elapsed window in the message states no wait. Credential/model fallback switches set delay to `0`; otherwise parsed hints can extend the capped local delay. If the computed delay is greater than `retry.maxDelayMs` and no switch succeeded, retry ends immediately with a final error instead of sleeping.

## Abort mechanics

### Explicit retry abort

`abortRetry()` calls `RetryRuntime.abort()`:

- aborts `#abortController` (if present)
- resolves the retry gate (`resolve()`) so awaiters are unblocked

If abort hits while sleeping, catch path emits:

- `auto_retry_end { success: false, finalError: "Retry cancelled" }` (`"Continuation cancelled"` with `mode: "continue"` for an unreplayable-batch wait)
- resets attempt/controller

### Global operation abort interaction

`abort()` calls `abortRetry()` before aborting the active agent stream, and `dispose()` calls it before draining post-prompt work. This guarantees retry backoff is cancelled when user issues a general abort.

### TUI interaction

On `auto_retry_start`, EventController (`#handleAutoRetryStart`):

- stops the working loader and clears the status container
- renders a `retryLoader` whose text is `formatRetryLine(...)` (`modes/retry-display.ts`): `Retrying (attempt/maxAttempts) in Ns` (`Continuing …` for `mode: "continue"`), then a plain-language reason derived from `errorId`/`errorMessage` (`timed out`, `usage limit`, `stream stalled`, …), then `policySource` when a non-global policy set the budget, joined by ` · ` and followed by `…` plus the maintenance esc-hint (e.g. `(esc to cancel)`)

`Esc` cancellation dispatches on live session state rather than a swapped handler: the input controller checks `viewSession.isRetrying` and calls `viewSession.abortRetry()` (alongside its compaction/handoff abort checks).

On `auto_retry_end` (`#handleAutoRetryEnd`), it stops and clears the `retryLoader` and status container. The session projection (`recordAutoRetryEnd` in `presentation/session-projection-engine.ts`) supplies the lines. On success it leaves a durable one-line summary from `formatRetrySummary(...)` (`Recovered after N retries (Xs waiting) · reason`), so a turn that recovered through retries does not read as a merely slow one.

## Streaming and prompt completion behavior

`prompt()` ultimately waits on `#waitForPostPromptRecovery()` after `agent.prompt(...)` returns; that loop awaits the retry gate (`RetryRuntime.gate`) alongside TTSR resume and deferred post-prompt tasks.

Effect:

- a prompt call does not fully resolve until any started retry chain finishes (success/failure/cancel)
- retry lifecycle is part of one logical prompt execution boundary

This prevents callers from treating a retrying turn as complete too early.

## Controls: settings and RPC

### Configuration knobs

Declared in `config/settings-domains/model.ts` under the retry group:

- `retry.enabled`
- `retry.maxRetries`
- `retry.baseDelayMs`
- `retry.maxDelayMs`
- `retry.modelFallback` (default `true`; gates retry model-fallback switching)
- `retry.fallbackChains`
- `retry.perProvider` (per-provider `maxRetries` / `baseDelayMs` / `maxDelayMs` overrides)
- `retry.fallbackRevertPolicy` (`"cooldown-expiry"` by default; `"never"` disables automatic restoration)

Programmatic toggles in session:

- `setAutoRetryEnabled(enabled)` writes `retry.enabled`
- `autoRetryEnabled` reads `retry.enabled`
- `isRetrying` reports whether the retry gate is held

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

- `auto_retry_start { attempt, maxAttempts, delayMs, errorMessage, errorId?, policySource?, mode? }`
- `auto_retry_end { success, attempt, finalError?, mode?, recoveredErrors? }`
- `retry_fallback_applied { from, to, role }`
- `retry_fallback_succeeded { model, role }`

`mode` is absent for the retry ladder and `"continue"` for an unreplayable-batch continuation.

Propagation:

- emitted through `AgentSession.subscribe(...)`
- forwarded to extension runner as extension events
- in RPC mode, forwarded directly as JSON event objects (`session.subscribe(event => output(event))`)
- in TUI, consumed by `EventController` for loader/error UI

Final failure surfacing:

- On max-exceeded, max-delay failure, recovery failure, empty-stop cap, or cancellation, `auto_retry_end.success === false`
- TUI shows: `Retry failed after N attempts: <finalError>` (`1 attempt` when N is 1; `Continuation failed after …` for `mode: "continue"`)
- Extensions/hooks receive `auto_retry_end` with same fields
- RPC consumers receive same event object on stdout stream

## Permanent stop conditions

Retry stops and will not auto-continue when any of these occur:

- `retry.enabled` is false
- error is not retry-classified
- error is context overflow (delegated to compaction path)
- max retries exceeded
- provider-requested delay exceeds `retry.maxDelayMs` and no credential/model switch is available
- the unreplayable-batch continuation allowance is spent
- user cancels retry (`abort_retry` or `Esc` during retry loader)
- global abort (`abort`) cancels retry first

A new retry chain can still start later on a future retryable error after counters reset.

## Operational caveats

- Classification produces typed `AIError` flag ids, but the inputs are still largely text patterns plus HTTP status; structural provider signals (`ProviderHttpError` codes, known error classes, `stopDetails`) are folded in where they exist.
- Retry strips the failing assistant error from **runtime context** before re-continue, but session history still keeps that error entry.
- `RpcSessionState` currently exposes `autoCompactionEnabled` but not an `autoRetryEnabled` field; RPC callers must track their own toggle state or query settings through other APIs.
- Model fallback changes append temporary `model_change` entries and may later restore the primary model when its cooldown expires, depending on `retry.fallbackRevertPolicy`. Restoration runs only between retry sequences (`maybeRestoreFallbackPrimary` returns while `#attempt > 0`).

*Verified against `9a035acb63` on 2026-09-30.*
