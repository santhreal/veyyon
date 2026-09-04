# @veyyon/model

The vocabulary a provider implements and a host reads: what a model is, what a message is, and
the records a turn produces.

A provider adapter turns a request into a stream of `AssistantMessageEvent`s and a host draws the
`AssistantMessage` those events build. Both sides read the same shapes from here. The catalog that
resolves a model id, the client that streams it and the host that renders it are not named. The
package has no dependencies.

## Exports

```ts
import type { Api, Model, Provider, ThinkingConfig, Usage } from "@veyyon/model";
import type { AssistantMessage, AssistantMessageEvent, Message, ToolCall } from "@veyyon/model";
import type { AssistantTurnMetrics, ToolCallMetrics } from "@veyyon/model";
import { Effort, isEffort, isServiceTier, SERVICE_TIERS, THINKING_EFFORTS } from "@veyyon/model";
```

Each module is also a subpath: `@veyyon/model/effort`, `/model`, `/message`, `/instrumentation`,
`/service-tier`, `/stream-block`.

## Model

- `Model`, `Api`, `Provider`, `KnownApi` — a model row: id, provider, api, cost, context window,
  `ThinkingConfig`, `ThinkingBudgets`, `ModelCapabilities` and the compatibility flags.
- `Effort`, `THINKING_EFFORTS`, `isEffort`, `canonicalizeEfforts` — the user-facing thinking
  ladder, least to most intensive, listed once and guarded from that list.
- `THINKING_CONTROL_MODES`, `OPENAI_REASONING_DISABLE_MODES` — thinking transports and reasoning
  disable modes, as values so a test can enumerate them.
- `Usage` — token accounting a provider reports and a host displays.

## Message

- `UserMessage`, `DeveloperMessage`, `AssistantMessage`, `ToolResultMessage`, `Message` — the
  conversation envelope a provider consumes and produces.
- `TextContent`, `ThinkingContent`, `RedactedThinkingContent`, `ImageContent`, `ToolCall` — the
  content blocks a message holds.
- `AssistantMessageEvent` — the streamed event union: `start`, `text_*`, `thinking_*`,
  `toolcall_*`, `done`, `error`.
- `StopReason`, `StopDetails`, `ToolChoice`, `CacheRetention`, `CacheEnforcement`,
  `MessageAttribution`, `EMPTY_ERROR_TOOL_RESULT_TEXT`.
- `kStreamingPartialJson` with `getStreamingPartialJson`, `setStreamingPartialJson` and
  `clearStreamingPartialJson` — the symbol a streaming tool-call block carries its raw JSON under.

## Instrumentation

- `ToolCallMetrics`, `ToolCallStatus` — the study record attached to a tool result.
- `AssistantTurnMetrics`, `AssistantTurnStatus`, `AssistantTurnRequest` — the study record
  attached to an assistant message.
- `INSTRUMENTATION_LEVELS`, `InstrumentationLevel` — how much of each record a session keeps.

## Service tier

- `SERVICE_TIERS`, `ServiceTier`, `isServiceTier`, `OPENAI_WIRE_TIERS`, `ServiceTierFamily`,
  `ServiceTierByFamily` — the serving-tier vocabulary.
- `ProviderWireCapabilities`, `ProviderServiceTierCapability`,
  `ProviderAnthropicMessagesCapability` — what one provider realizes of that vocabulary.

## What stays behind

`StreamOptions`, `SimpleStreamOptions`, `ApiOptionsMap`, `StreamFunction` and `TokenTaskBudget` are
the request surface of `@veyyon/ai` and reference each provider's option type. `Tool`, `TSchema`, `Context` and
the tool examples are the tool vocabulary and reference a schema library. `PROVIDER_WIRE_CAPABILITIES`
and `KnownProvider` are the catalog's table of providers, not the vocabulary that table is written
in. `ProviderSessionState`, `ProviderResponseMetadata`, `RawSseEvent` and the Codex compaction
records are provider-side session state.
