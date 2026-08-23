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
|OAuth retry and rotation|`packages/ai/src/auth-retry.ts`|one forced refresh, then one rotation per sibling credential|`isAuthRetryableError` and `isDefinitiveOAuthFailure`. A dead grant is not a transport fault: the answer is a different credential, not another attempt.|

## Above the transport

|Loop|Where|Budget|Reads|
|---|---|---|---|
|Turn retry|`packages/agent/src/agent-loop.ts`|`retry.maxAttempts`, per-turn|`retriable(id)`, which vetoes first, admits the families whose `turn` stage retries, and refuses a replay-unsafe failure that is not declared `replaySafe`.|
|Fallback chain|`packages/agent/src/agent-loop.ts`|one pass over the configured models|the same classification, after the turn's own attempts are spent. A model that cannot serve the request is answered by a different model, not by waiting.|

## What none of them decide

A cancellation. `interruptDomain` declares `vetoesRetry: true` and every reader asks `vetoesRetry(id)`
first, because every other rule reads the outermost message and a provider is free to compose a
transient-sounding sentence around the cause it wrapped.

A refusal. A named HTTP/2 code the RFC says a replay reproduces, and a framing violation, both carry
`Flag.TransportRefused` for the same reason: the next identical attempt fails the same way.

A stall. `iterateWithIdleTimeout` throws `StreamTimeoutError` on every deadline, so a stall is retried
on its own flag through the timeout family, and only a caller's cancel reaches the veto.
