# Providers

The providers subsystem connects Veyyon to model APIs and normalizes their
auth, request, and response formats.

## Responsibility

- Maintain the catalog of supported model providers and their capabilities.
- Resolve a model slug to a provider and its `ModelInfo`.
- Authenticate requests with API keys, access tokens, or OAuth credentials.
- Translate between the provider-specific wire format and the engine's
  protocol types.

## Implementation

The provider stack lives in the `@veyyon/ai` package.

| Component | Role |
| --- | --- |
| Provider adapters | Per-provider connection and wire-format adapters |
| API client registry | OpenAI-compatible API client registry |
| Provider details | Provider metadata, auth mode, and endpoints |
| Model catalog | Model catalog and per-model capabilities |
| Model registry | Slug resolution to provider + model info |

## Key concepts

- Provider metadata: a provider's auth mode and endpoint configuration.
- Model info: per-model capabilities such as context window and vision support.
- Auth material: resolved from API keys, access tokens, or OAuth credentials.

See [Models and providers](../using/models.md) and
[Provider stack and bring-your-own-key](../models/providers.md) for how to add
your own keys and choose models.

## Prompt caching

Each provider adapter also decides where the request's cache markers go, and the shapes differ:
Anthropic places up to four `cache_control` breakpoints, Bedrock interleaves `cachePoint` blocks,
the OpenAI Responses path sends an explicit `prompt_cache_breakpoint`, and everything else caches
implicitly or not at all. Two settings under **Settings → Context → Prompt Cache** report and
optionally block on a cache the provider demonstrably did not use. The full per-provider account,
including the breakpoint budget and what invalidates what, is
[`docs/internal/prompt-caching.md`](../../../internal/prompt-caching.md).

## The first-event budget

A caller declares `streamFirstEventTimeoutMs`. It is one attempt's deadline, and
it also bounds how many stalled attempts a turn may pay for: the phase before
the first event ends after two of them. The first stall is retried, because a
single connect that never produces an event is common and recovering it is what
makes a provider feel smooth. A second consecutive stall is a dead endpoint, and
re-spending the deadline there is what turned a declared 100s into minutes of
silence.

The phase ends at the first of these:

- the first event arrives, after which `streamIdleTimeoutMs` owns the turn;
- the phase budget is spent and the turn fails with the deadline as its reason.

`utils/first-event-budget.ts` in `@veyyon/ai` owns the shape:

| Function | Use |
| --- | --- |
| `openFirstEventBudget(totalMs)` | Open a budget for the declared number. A non-positive or absent total is unbounded, matching `streamFirstEventTimeoutMs: 0`. |
| `openStallLadderBudget(perAttemptMs)` | A phase budget for a retry ladder: the per-attempt deadline times `PRE_RESPONSE_STALL_ATTEMPTS` (two). What Anthropic and Codex open. |
| `openBoundedFirstEventBudget(declaredMs, ceilingMs)` | The smaller of the caller's number and a provider's own ceiling. It can only tighten a deadline. |
| `budget.spent()` | True once nothing is left. A retry ladder asks before retrying a stall. |
| `budget.fence(callerSignal)` | A signal covering what remains, plus the `cancel()` that clears its timer. A setup chain fences once and passes that signal to every call. |
| `isPreResponseStall(error)` | True when no byte of a response ever arrived. |

Two rules keep this narrow.

**A stall is bounded; a server-directed retry is not.** A 429 or 503 carrying
`retry-after` means the server answered and asked for a later attempt. Honoring
that is what makes a rate limit survivable, so those failures keep their own
budget (`CODEX_RATE_LIMIT_BUDGET_MS`, and the Anthropic header hint). Only a
failure where nothing arrived at all is refused once the budget is gone, which
is why the guard is a veto predicate rather than a fence around a retry loop.

**A deadline that fires ends the phase.** A helper that degrades on its own
timeout — GitLab Duo's settings PUT, its project lookup, its model list, and the
catalog namespace reader behind them — must rethrow when the caller's deadline is
what fired. Reporting it as "nothing found" and continuing spends time nobody
granted, and it reaches the user as a configuration remedy for a network fault.

### Where each provider's deadline sits

| Provider | Bound before the first event |
| --- | --- |
| OpenAI completions, Responses, OpenRouter, Azure | Pre-response fence plus the stream watchdog. |
| Anthropic | The same, and the retry ladder retries one stall and refuses the next once the phase budget is spent. |
| Codex | The same, on both ladders: `fetchWithRetry` (no response) and the provider-error reopen (a retryable envelope that is itself a stall). |
| GitLab Duo | One setup deadline over the whole REST chain: the caller's number, or 90s (three REST timeouts), whichever is smaller. |
| Bedrock, Google, Vertex, Gemini CLI, Ollama, Cursor, Devin | The registered lazy-stream limits and each transport's own abort. |

`packages/ai/test/no-api-outlives-the-budget-its-caller-declared.test.ts` drives
every API in the union against a silent endpoint and pins the observed class per
API, so a provider that stops honoring the number turns that suite red.
