# Prompt caching

A provider prompt cache stores the tokenized prefix of a request so the next request that
starts with the same bytes skips prefill. You pay a write premium once and a large discount
after. Two things make it work: the prefix has to be byte-identical, and the provider has to be
told where the prefix ends.

Veyyon does both, and it does them differently on each transport. This page is what the code
actually does, per provider, with the budget arithmetic and the failure modes.

Related pages: [System prompt architecture](system-prompt-architecture.md) owns the block model
that produces the cacheable prefix, and [Provider endpoint constraints](provider-endpoint-constraints.md)
owns per-endpoint wire rules.

## The one request-level knob

`cacheRetention` is a **per-request** option, not a per-block one:

```ts
// packages/ai/src/types.ts:107
export type CacheRetention = "none" | "short" | "long";
```

`resolveCacheRetention` (`packages/ai/src/utils.ts:291`) defaults it to `short`, and
`VEYYON_CACHE_RETENTION=long` raises it. `short` means the provider's ordinary ephemeral window;
`long` asks for the extended one where the model supports it. `none` places no markers at all,
which is the only way to opt out of paying a cache-write premium.

On the Anthropic path there is one extra default: an OAuth token implies `long`.

```ts
// packages/ai/src/providers/anthropic.ts:492
function getCacheControl(model, cacheRetention, isOAuthToken) {
	const retention = cacheRetention ?? (isOAuthToken ? "long" : resolveCacheRetention(undefined));
	if (retention === "none") return { retention };
	const ttl = retention === "long" && model.compat.supportsLongCacheRetention ? "1h" : undefined;
	return { retention, cacheControl: { type: "ephemeral", ...(ttl && { ttl }) } };
}
```

Note the second gate: asking for `long` on a model whose `compat.supportsLongCacheRetention` is
false yields a marker with no `ttl`, which is the five-minute window. Retention is a request,
not a guarantee.

## Anthropic: four breakpoints, spent deliberately

`applyPromptCaching` (`packages/ai/src/providers/anthropic.ts:3160`) is the whole placement
policy. The budget is a constant:

```ts
// anthropic.ts:3163
const MAX_CACHE_BREAKPOINTS = 4;
let cacheBreakpointsUsed = countCacheControlBreakpoints(params);
if (cacheBreakpointsUsed >= MAX_CACHE_BREAKPOINTS) return;
```

`countCacheControlBreakpoints` (`anthropic.ts:3344`) counts markers already on the wire across
**tools, system blocks and message content blocks**. So a marker that arrived on the request
from somewhere else spends budget, and the function declines to add more rather than exceeding
the limit.

### How the four are spent

There are two layouts, and which one you are in is detected from the first system block:

```ts
// anthropic.ts:3172
isCCLayout =
	params.system.length >= 3 &&
	params.system[0].text?.startsWith(CLAUDE_BILLING_HEADER_PREFIX) === true;
```

| | API-key layout | Claude Code (OAuth) layout |
| --- | --- | --- |
| Trailing system block | 1 (`applyCacheControlToLastBlock`) | 1 (`applyClaudeCodeSystemCache`) |
| Stable system prefix anchor | 1, at `system[0]` | 1, at `system[2]` |
| Trailing messages | 2 (last two) | 1 (last one) |
| **Total** | **4 of 4** | **3 of 4** |

The anchor index is positional and depends on the layout, which is why the layout is detected
rather than assumed:

```ts
// anthropic.ts:3196
const stablePrefixIndex = isCCLayout ? 2 : 0;
```

Under OAuth the provider prepends a billing header block and a Claude Code instruction block,
so Veyyon's own first block sits at index 2. Under an API key it is index 0. That first block is
block 0 from the [system prompt architecture](system-prompt-architecture.md): the static harness
prefix shared between a parent session and its subagents. Anchoring it means a changing suffix
(project context, the argot handle table, the secret inventory) cannot invalidate the shared
prefix.

The unspent fourth slot in the Claude Code layout is deliberate. The number of `cache_control`
markers is wire-visible, and that layout exists to mirror the request shape of the client it
cloaks, so spending the slot would be a difference for the sake of a fallback anchor.

### Two guards on the anchor

`applyCacheControlToStableSystemPrefix` (`anthropic.ts:3125`) refuses two cases:

```ts
if (index < 0 || index >= blocks.length - 1) return false;
if (blocks[index].cache_control != null) return false;
```

The first prevents anchoring the last block, which the trailing marker already covers, so the
anchor would spend a slot to cache a prefix that is cached anyway. The second prevents
double-marking a block that already carries a marker.

### Marking the trailing messages

```ts
// anthropic.ts:3207
const start = isCCLayout
	? Math.max(0, params.messages.length - 1)
	: Math.max(0, params.messages.length - 2);
```

The loop walks forward from `start` and marks each message it can. A string content is promoted
to a one-element text array carrying the marker. An array content goes through
`applyCacheControlToLastTextBlock` (`anthropic.ts:3136`), which walks backwards for a `text`
block and, failing that, for any block that is not `thinking` or `redacted_thinking` — those
reject `cache_control` with a 400.

Marking the tail is what makes intra-session caching work: the previous turn's tail is this
turn's prefix, so the conversation stays cached as it grows.

### Two post-passes that must run in this order

```ts
// anthropic.ts:3642
applyPromptCaching(params, cacheControl);
enforceCacheControlLimit(params, 4);
normalizeCacheControlTtlOrdering(params);
```

`enforceCacheControlLimit` (`anthropic.ts:3365`) is the backstop for markers Veyyon did not
place. It strips in a deliberate order: system blocks except the last marked one, then tool
blocks except the last marked one, then message markers, then everything remaining. The point is
that the *last* marker in each group survives longest, because that is the one covering the
largest prefix.

`normalizeCacheControlTtlOrdering` (`anthropic.ts:3244`) enforces Anthropic's ordering rule that
longer TTLs must precede shorter ones. It walks tools, then system, then messages, and once it
has seen a five-minute marker it deletes `ttl: "1h"` from every later one. This is a
downgrade, not an error: a mixed-TTL request that would have been rejected becomes a request
whose later breakpoints use the short window.

## Bedrock: `cachePoint` blocks, same idea, separate code

Bedrock Converse does not use `cache_control`. It uses `cachePoint` blocks interleaved into the
content array, and a cache point caches the prefix that **ends at** that block. The system-side
placement is `buildSystemPrompt` in `packages/ai/src/providers/amazon-bedrock.ts:773`:

```ts
for (let index = 0; index < prompts.length; index++) {
	blocks.push({ text: prompts[index] });
	// A single-block system prompt needs no anchor: the trailing checkpoint
	// below already ends at that same block, and a duplicate would spend a
	// slot to cache a prefix that is cached anyway.
	if (index === 0 && prompts.length > 1) blocks.push(cachePoint());
}
blocks.push(cachePoint());
```

Two checkpoints on system, one anchoring block 0 and one closing the whole prompt.
`convertMessages` adds a third on the last user message (`amazon-bedrock.ts:934-941`), so three
of Claude's four are spent and one is unused.

The comment above that function records why the anchor was added: a single trailing
`cachePoint` caches a prefix ending at the last system block, so any edit to a later block
invalidates all of it. The Anthropic provider anchored its own first block for that reason and
Bedrock did not, so the two transports disagreed about the same conversation.

Three Bedrock-specific facts worth keeping straight:

- **An undersized prefix is free, not fatal.** AWS documents that a checkpoint below the token
  minimum still succeeds, it just does not cache. So the anchor costs an unused slot when
  block 0 is under the floor (1024 tokens on Sonnet 4.6, 4096 on the 4.5 generation) and
  nothing else.
- **Both checkpoints carry the same TTL**, which satisfies the longer-before-shorter ordering
  rule by construction rather than by a normalization pass.
- **There is no Claude Code layout here.** Bedrock authenticates with AWS credentials and the
  function injects no blocks of its own, so index 0 is always the caller's first prompt and the
  anchor needs no offsetting.

## OpenAI Responses: an explicit breakpoint, tightly gated

`resolveOpenAIPromptCachePolicy` (`packages/ai/src/providers/openai-prompt-cache.ts:52`) decides
two independent fields, and both require a `promptCacheKey`:

| Field | Requires |
| --- | --- |
| `prompt_cache_breakpoint: { mode: "explicit" }` | a cache key, a generation that supports breakpoints, and `api.openai.com` as the host |
| `prompt_cache_retention: "24h"` | a cache key, `cacheRetention === "long"`, `compat.supportsLongPromptCacheRetention`, and a generation that does **not** support breakpoints |

The two are mutually exclusive by construction, because `24h` is deprecated from the 5.6
generation onward, where request-wide `prompt_cache_options.ttl` governs lifetime instead.

The host gate is not cosmetic. The ChatGPT Codex backend rejects `prompt_cache_breakpoint` with
`prompt_cache_breakpoint is not supported on this model (invalid_parameter)`, which fails the
whole turn. The `Model<"openai-responses">` parameter type is what keeps the Codex request path
from asking for a policy at all.

`formatOpenAIInputText` (`openai-prompt-cache.ts:91`) drops the marker for blank text: a
breakpoint marks the prefix ending at its own block, the platform floor is 1024 tokens, so a
blank block can never make its own marker eligible and would only risk a 400.

## OpenAI chat-completions: one Anthropic-shaped marker, OpenRouter only

`maybeAddAnthropicCacheControl` (`packages/ai/src/providers/openai-completions.ts:1687`) writes
one `cache_control` marker on the last non-empty text part of the last user, assistant or
developer message. It runs only when the compat layer asked for it:

```ts
if (compat.cacheControlFormat !== "anthropic") return;
if (cacheRetention === "none") return;
```

And that flag is set in exactly one place:

```ts
// packages/catalog/src/compat/openai.ts:494
cacheControlFormat: isOpenRouter && isAnthropicModel ? "anthropic" : undefined,
```

So this is the Claude-through-OpenRouter path and nothing else. The comment above that line
records what it was fixing: `startsWith("anthropic/")` is false for the aliased ids OpenRouter
actually serves, so no breakpoint was written and every turn re-prefilled the whole
conversation at full input rate.

## Cache identity: `promptCacheKey` and `sessionId`

Anthropic-family caching is content-addressed: the provider matches on prefix bytes, and no key
is involved. OpenAI-family caching is keyed, and without a key two requests with the same prefix
but different tails do not coalesce.

```ts
// packages/ai/src/types.ts:443-452 (abridged)
/** Optional session identifier … Providers may also use this as the prompt-cache key
 *  when `promptCacheKey` is not set. */
sessionId?: string;
/** Optional prompt-cache identity. OpenAI-family providers use this for
 *  `prompt_cache_key` payloads and cache-affinity headers such as `x-grok-conv-id`;
 *  when omitted, they fall back to `sessionId`. */
promptCacheKey?: string;
```

`getOpenAIPromptCacheKey` (`packages/ai/src/providers/openai-shared.ts:387`) returns
`undefined` when retention is `none`, then normalizes `promptCacheKey ?? sessionId`. So opting
out of caching also removes the identity, rather than leaving a key that identifies a
conversation for no benefit.

### The auth gateway derives one when a client does not send one

The gateway accepts requests in Anthropic, OpenAI-chat and OpenAI-Responses shapes and streams
them to whichever provider is configured, which means an Anthropic-shaped client can end up on
a keyed backend. `resolvePromptCacheKey` (`packages/ai/src/auth-gateway/http.ts:183`) reads the
body first, then these allow-listed headers:

```
x-prompt-cache-key
x-session-id
x-conversation-id
```

When none is present, `deriveSessionId` (`packages/ai/src/auth-gateway/server.ts:113`) hashes
the parts that do not change turn to turn: model id, system prompt, tool definitions, and the
first message. The first message is what scopes the key to one logical conversation, so two
different chats with the same system prompt do not share a bucket and trample each other's
prefix-tree entries.

The resolved value is mirrored into both fields:

```ts
// auth-gateway/server.ts:200
const promptCacheKey = options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
opts.promptCacheKey = promptCacheKey;
opts.sessionId = promptCacheKey;
```

The same value is also the sticky credential id passed to `storage.getApiKey`
(`auth-gateway/server.ts:442-452`), so cache affinity and credential affinity cannot drift
apart.

### Inbound per-block markers become one per-request retention

An Anthropic client annotates caching per block. Veyyon's model is per request, and its own
provider re-places breakpoints on the rebuilt outbound wire, so the server collapses the two
models by taking the strongest retention asked for:

```ts
// packages/ai/src/providers/anthropic-messages-server.ts:250-270 (abridged)
const visit = (cc) => {
	if (!cc) return;
	if (cc.ttl === "1h") strongest = "long";
	else strongest ??= "short";
};
```

Any `ttl: "1h"` anywhere promotes the whole request to `long`; any other ephemeral marker maps
to `short`. **The client's chosen positions are discarded.** That is the correct call for a
transport that re-derives placement anyway, but it does mean a client that carefully placed four
breakpoints gets Veyyon's placement, not its own.

## What invalidates what

Prefix caching is positional, so an edit invalidates everything **after** it, not just itself.

| Change | Invalidates |
| --- | --- |
| Model switch or terminal change | nothing behind block 0, because `<workstation>` is volatile-last inside `project` (see [system prompt architecture](system-prompt-architecture.md#ordering-rules)). It used to sit first, and cost 5,396 re-prefilled tokens |
| A statement's condition flipping (a setting change) | block 0 and everything after it |
| An argot dictionary loading | the `shorthand-handles` block and later blocks; block 0 survives, which is why the handle table is its own block |
| A new secret becoming spendable | the `available-secrets` block and later blocks |
| `set_cwd` / `/cd` | the `project` block and later blocks: the cwd line, context files, and workspace tree all change |
| `includeWorkspaceTree` on, plus any file edit | the `project` block, on every turn |
| Any compaction or history rewrite | every message-side marker from the rewrite point on |
| A pruned tool result | the message that held it and everything after |
| More than 5 minutes idle (`short`) or 1 hour (`long`) | the entry expires; the next turn is a cold write |

Compaction is written to preserve the prefix rather than to minimize tokens for its own sake.
[Compaction](../compaction.md) records the rule directly: a divergent prefix cold-misses the
provider prompt cache, so entries are rewritten through `rewriteEntries()` and a sub-floor tool
result is never blanked, because the `[Output truncated - N tokens]` placeholder costs about 8
tokens and pruning below that would grow the context and churn the cache for nothing.

## Verifying that it worked

Nothing used to check. `cacheRead` was summed, billed and displayed, and never compared against
what the request asked the provider to cache. `packages/ai/src/cache/` exists because four
defects shipped that way and were found by reading a bill:

- Codex Responses Lite stamped `prompt_cache_breakpoint` on a model that answers
  `invalid_parameter`, so every turn on that path cached nothing.
- Claude through OpenRouter under a `~anthropic/…` alias failed a `startsWith("anthropic/")`
  test, so no breakpoint was ever written.
- `prompt_cache_retention: "24h"` reached generations that reject it.
- `/branch` and `/btw` re-prefilled the entire retained transcript.

`verdict.ts` turns provider-reported usage into one of a small set of verdicts, using only
numbers the provider reported plus facts the caller already knows. It never estimates a prefix
size, because an estimate that drifts from the tokenizer would make this a source of false
alarms, and a check that cries wolf gets turned off.

Two constants govern the judgement:

```ts
// packages/ai/src/cache/verdict.ts:45
export const CACHE_TTL_MS = Object.freeze({ short: 5 * 60_000, long: 60 * 60_000 });
// verdict.ts:64
export const CACHE_WINDOW_GRACE = 0.8;
```

Past 80% of the nominal window the verdict is "cold", not "rejected". Anthropic refreshes the
window on every cache **hit** rather than on every request, so its start moves in a way a client
cannot observe, and entries can be evicted early under load. Giving up the claim early is the
price of never halting a session over a server-side eviction.

`policy.ts` decides what to do about a verdict. `rejected` is the only enforceable one: the
request carried anchors, the prompt was over the minimum, it was not the first turn on the key,
the window was open, and the provider reported neither a read nor a write. `degraded`,
`invalidated` and `unverifiable` all have innocent explanations.

The throw is deferred to the **next** request on the same key. A rejection is only knowable
after usage arrives, when the money is already spent, and throwing there would also destroy a
completed assistant turn: the operator would lose the work and the money instead of just the
money.

Two settings drive it, both in `packages/coding-agent/src/config/settings-domains/context.ts`
under **Settings → Context → Prompt cache**:

| Key | Default | Effect |
| --- | --- | --- |
| `cache.reportRejection` | `true` | warn on a rejection |
| `cache.blockOnRejection` | `false` | fail the next request after one; hidden unless reporting is on |

They compose into the provider-level option in `agent-session.ts:3017`: reporting off means
`off`, reporting on means `warn`, both on means `error`. `VEYYON_CACHE_ENFORCEMENT` sets the same
three values for a process, and `resolveCacheEnforcement`
(`packages/ai/src/cache/policy.ts:48`) defaults to `warn` when neither is set.

`display.cacheMissMarker` (default off) draws a divider above an assistant turn whose request
missed the cache, which is the in-session version of the same signal.

## What to avoid

**As an operator.** Turn on `includeWorkspaceTree` only when you need it: the tree lands in the
`project` block and any file edit changes it, so it re-prefills that block every turn. Expect a
cold turn after `/cd`, `/model`, a settings change, or a long pause; each of those is a real
invalidation, not a bug. Do not set `VEYYON_CACHE_ENFORCEMENT=error` on a provider other than
Anthropic and conclude your cache is healthy from the silence, because no other provider reports
a verdict at all.

**As a contributor.**

- Do not put session-varying text in a `template` section. Nothing checks it, and the cost is
  block 0 re-prefilled on every turn.
- Do not reorder anything ahead of a stable prefix for readability. `project-prompt.md` carries
  the measurement of the last time that happened.
- Do not add a `cache_control` or `cachePoint` in a new place without counting the budget. On
  Anthropic the budget is 4 including markers you did not place, and going over means
  `enforceCacheControlLimit` silently strips one of yours.
- Do not iterate a `Map` into a prompt section. `secrets.md` records why the secret inventory is
  sorted: insertion order shuffles between refreshes and invalidates the prefix without changing
  anything the section says.
- Do not mix TTLs and rely on the request surviving. Longer must precede shorter, and the
  normalization pass resolves a violation by downgrading, so you get a working request with a
  shorter window than you asked for.

## Known limitations

Named rather than fixed. Some of these are places where Nous Research's Hermes agent
([`agent/prompt_caching.py`](https://github.com/NousResearch/hermes-agent), Python) does more
than we do, and the comparison is included because it makes the gap concrete.

- **Verification is Anthropic-only.** `packages/ai/src/cache/policy.ts:41-46` says so directly:
  `providers/anthropic.ts` is the single production importer, so on Bedrock, OpenAI Responses
  and the chat-completions path the enforcement level resolves and then governs nothing. Two of
  the four defects that motivated the subsystem happened on providers it does not observe.
- **Marker positions are chosen positionally, not structurally.** The trailing loop marks the
  last one or two messages whatever they are. Hermes instead computes
  `_completed_transaction_endpoint_indexes`, selecting only the ends of completed tool runs and
  ordinary turns, and skips messages a provider will not honour a marker on. A marker Veyyon
  places on a message whose tool results have not arrived yet is a marker on a prefix that will
  not recur, so the slot is wasted. Hermes' approach is stronger here.
- **Inbound markers are clamped, not stripped and replanned.** `enforceCacheControlLimit`
  removes excess markers after the fact. Hermes strips every marker first
  (`strip_anthropic_cache_control`) and then builds a fresh plan for the resolved destination,
  so a marker can never survive into a layout that was not designed for it.
- **The per-provider decision is distributed across five modules.** `anthropic.ts`,
  `amazon-bedrock.ts`, `openai-prompt-cache.ts`, `openai-completions.ts` and
  `catalog/src/compat/openai.ts` each own part of "should this request be cached, and in which
  wire layout". Hermes answers that in one function, `anthropic_prompt_cache_policy`, returning
  `(should_cache, use_native_layout)`. Ours is harder to audit, and the OpenRouter alias bug
  above is exactly the class of defect a single decision point would have made visible.
- **Anthropic-style markers on OpenAI-wire endpoints stop at Claude.**
  `cacheControlFormat: "anthropic"` is set only for `isOpenRouter && isAnthropicModel`. Hermes
  also sends them for the Kimi/Moonshot and Qwen families on OpenAI-wire endpoints, reporting
  measured within-turn cache share climbing from 1% to 97% on a 64K prompt once markers are
  present. Whether those providers honour markers on our exact request shape is unverified here,
  so this is a gap to measure, not a change to make blind.
- **Block 0 cannot be split.** There is one static prefix and one anchor for it. A configuration
  where one static section changes far more often than the others cannot be expressed. Hermes
  splits its single stored system string in the outgoing request only, at a known
  `static_system_prefix`, to get two independently cacheable pieces; Veyyon gets the same effect
  structurally because the builder already returns an array, but with a fixed cut point.
- **`cacheRetention` is not exposed as a setting.** It is reachable through
  `VEYYON_CACHE_RETENTION` and the SDK option, and it is implied by OAuth on Anthropic. There is
  no `/settings` entry.

## Where the code is

| Concern | File |
| --- | --- |
| Retention type, request options | `packages/ai/src/types.ts` |
| Retention default, `$env` read | `packages/ai/src/utils.ts` |
| Anthropic placement, budget, post-passes | `packages/ai/src/providers/anthropic.ts` |
| Anthropic system-block construction | `buildAnthropicSystemBlocks`, `anthropic.ts:2851` |
| Bedrock `cachePoint` placement | `packages/ai/src/providers/amazon-bedrock.ts` |
| OpenAI Responses policy and serialization | `packages/ai/src/providers/openai-prompt-cache.ts` |
| OpenAI chat-completions marker | `packages/ai/src/providers/openai-completions.ts` |
| Which models get Anthropic-shaped markers | `packages/catalog/src/compat/openai.ts` |
| Cache-key resolution and derivation | `packages/ai/src/auth-gateway/http.ts`, `packages/ai/src/auth-gateway/server.ts` |
| Inbound per-block to per-request mapping | `packages/ai/src/providers/anthropic-messages-server.ts` |
| Verdicts, windows, floors | `packages/ai/src/cache/verdict.ts` |
| Enforcement levels and the deferred throw | `packages/ai/src/cache/policy.ts` |
| Per-key tracking state | `packages/ai/src/cache/tracker.ts` |
| Operator settings | `packages/coding-agent/src/config/settings-domains/context.ts` |

*Verified against `27538ffb` on 2026-08-05.*
