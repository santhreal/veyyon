# Retry loops

Every loop that sends a request again. A loop owns a budget and a backoff; none of them owns the
verdict. The verdict is the registry's, and the two functions that read it are
`retryResponse(response, body, policy)` for a response and `isProviderRetryableError(error, hooks)`
for a throw. Both classify and then ask `recover(id, "transport")`, so a loop that wants a different
answer changes a family's declaration in `packages/ai/src/error/domains/`, not its own condition.

## The transport stage

|Loop|Where|Budget|Reads|
|---|---|---|---|
|`fetchWithRetry`|`packages/utils/src/fetch-retry.ts`|`maxAttempts`, exponential backoff, `Retry-After`, HTTP/2 verdict|injected `shouldRetryResponse` / `shouldRetryError`. This package cannot classify: it is below `@veyyon/ai` and a status means something only next to a body.|
|`fetchProviderWithRetry`|`packages/ai/src/utils/provider-fetch.ts`|inherits `fetchWithRetry`|installs `retryResponse` for every provider in this package, so one verdict covers all of them. A provider that needs the loop without the verdict passes its own `shouldRetryResponse`.|
|`callWithCopilotModelRetry`|`packages/ai/src/utils/retry.ts`|one re-send, `retryBaseDelayMs`|`isCopilotTransientModelError`. Copilot's routing flap is a 400 whose meaning only Copilot knows, and a 400 is a wall to every other loop.|
|Anthropic stream retry|`packages/ai/src/providers/anthropic.ts` (`isAnthropicStreamRetryable`)|per-stream attempt count|`isProviderRetryableError` plus the Copilot hook, behind `activeAbortTracker.wasCallerAbort()`.|
|Devin stream retry|`packages/ai/src/providers/devin.ts`|per-stream attempt count|`isProviderRetryableError`, behind `isAbortError`.|
|OAuth retry and rotation|`packages/ai/src/auth-retry.ts`|one refresh-same then one sibling switch for an ordinary 401; a usage limit rotates straight through distinct siblings, capped by `AUTH_RETRY_MAX_ATTEMPTS`|`isAuthRetryableError` decides whether to retry at all, `isUsageLimit` decides refresh-same versus rotate. A dead grant is not a transport fault: the answer is a different credential, not another attempt, and `isDefinitiveOAuthFailure` in `packages/ai/src/error/domains/account.ts` states when the credential itself is spent, read by the refresh paths in `packages/ai/src/auth-storage.ts` rather than by this loop.|

## Above the transport

|Loop|Where|Budget|Reads|
|---|---|---|---|
|Turn retry|`packages/coding-agent/src/session/agent-session.ts`|`retry.maxRetries`, per-turn, exponential backoff through `calculateRetryBackoffDelayMs`|`retriable(id)`, which vetoes first, admits the families whose `turn` stage retries, and refuses a replay-unsafe failure that is not declared `replaySafe`.|
|Fallback chain|`packages/coding-agent/src/session/agent-session.ts`|one pass over the `retry.fallbackChains` entry for the active model or role|the same classification, after the turn's own attempts are spent. A model that cannot serve the request is answered by a different model, not by waiting.|

## What none of them decide

A cancellation. `interruptDomain` declares `vetoesRetry: true` and every reader asks `vetoesRetry(id)`
first, because every other rule reads the outermost message and a provider is free to compose a
transient-sounding sentence around the cause it wrapped.

A refusal. A named HTTP/2 code the RFC says a replay reproduces, and a framing violation, both carry
`Flag.TransportRefused` for the same reason: the next identical attempt fails the same way.

A stall. `iterateWithIdleTimeout` throws `StreamTimeoutError` on every deadline, so a stall is retried
on its own flag through the timeout family, and only a caller's cancel reaches the veto.

*Verified against `954eace449` on 2026-08-31.*
