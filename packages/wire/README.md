# @veyyon/wire

Shared TypeScript wire contracts for veyyon collab live sessions.

The package contains JSON-safe protocol shapes, constants, and the shared seal/envelope helpers (`sealFrame`/`openFrame`, `packEnvelope`/`unpackEnvelope`, room-key utilities). It has no runtime dependencies and is consumed by the host CLI (`@veyyon/coding-agent`).

## Exports

```ts
import type { GuestFrame, HostFrame, WireSessionEntry } from "@veyyon/wire";
import { COLLAB_PROTO, DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH } from "@veyyon/wire";
```

Key groups:

- message and transcript entry shapes rendered by collab guests. Every one of them is a rendered
  SUBSET of a richer type the host owns, so each carries a `Wire` prefix and the bare name is not
  used: `WireSessionEntry`, `WireSessionHeader`, `WireUserMessage`, `WireDeveloperMessage`,
  `WireAssistantMessage`, `WireToolResultMessage`, `WireMessage`, `WireStopReason`, `WireUsage`.
  The old bare spellings (`SessionEntry`, `UserMessage`, `AssistantMessage`, `StopReason`, and the
  rest) still resolve, so existing imports keep working.

  Read the prefix as a promise about width. The host's `AssistantMessage` in `@veyyon/ai` carries
  provider payloads, sampling parameters, retry records, and context snapshots; the
  `WireAssistantMessage` declared here carries content, model, usage, stop reason, and a timestamp.
  Switch on `entry.type` and keep a tolerant `default:`, because the host persists variants no
  guest draws.

  A message can carry eleven roles, and all eleven are declared. Four are the model's own (`user`,
  `developer`, `assistant`, `toolResult`); the other seven come from the host's custom-message hook
  and cover what the user did rather than what the model said: `bashExecution`, `pythonExecution`,
  `custom`, `hookMessage`, `branchSummary`, `compactionSummary` and `fileMention`. A guest renders
  every one of them, because its replica transcript is drawn by the same renderer the host uses.

  Naming both ends the same thing is what caused the one real bug in this area. TypeScript
  assignability runs the permissive way: a value carrying MORE fields still satisfies a type
  declaring fewer, so a host header assigned to a wire-typed field shipped three undeclared fields
  to every guest, and guests persist what they receive. The prefix is what makes the compiler
  demand a projection instead of letting the wide value through.
- live agent event and task-subagent bus payload shapes,
- `GuestFrame`, `HostFrame`, and `WireFrame` unions for AES-GCM sealed payloads,
- relay control TEXT messages,
- link/envelope constants shared by host, guest, and local relay code.

## Projection is the host's job, and it is not optional

A `Wire` type says what a guest receives. It does not enforce it, because assignability runs the
permissive way: a host value carrying twenty extra fields satisfies a wire type declaring six. So
the host projects every session header, every transcript entry and every live event onto the
declared shape before it sends, field by field, and the projection functions live next to each other
in `packages/coding-agent/src/collab/protocol.ts`:

```ts
import { toWireAgentEvent, toWireModel, toWireSessionEntry, toWireSessionHeader } from "./protocol";
```

The event projection is the one to read first if you are adding a frame. `agent_end` is declared
here with no payload at all, and the host's own `agent_end` carries the entire message array of the
run, so the difference between the two types is the difference between a lifecycle ping and the
whole conversation.

Write a projection out field by field rather than as a destructuring rest. Both spellings compile
and produce the same value today, and only one of them keeps producing the right value after
somebody adds a field to the host's type: a rest pattern ships the new field the day it is added,
without a review, without a type error, and without anything in this package changing. That is
exactly how the header leak happened.

The rule this encodes is that a guest gets what it renders. Not what it might find useful, and not
what happens to be adjacent in the host's object. Two field groups make the reason concrete:

- `providerPayload` on an assistant message is the transport-native history used to replay a turn
  upstream, and `request` is the sampling and reasoning parameters exactly as sent. Neither is drawn
  anywhere, and both are large.
- `contextSnapshot`, `turnMetrics`, `retryRecovery`, `stopDetails` and `errorId` are host telemetry.
  A guest showing a transcript has no use for how many times the host retried the turn.

Guests persist what they receive into their own replica session file, so an undeclared field is not
a transient over-send: it lands on another machine's disk. When you add a field to a host type, the
question to answer is whether a guest DRAWS it. If it does, declare it here first. If it does not,
the projection already drops it and there is nothing to do.

`WireFileMentionMessage` is the case where the answer is easiest to get wrong. A `@path` mention
carries each file's full text, and it is tempting to keep it because a replica "should have
everything". A guest draws a path and a line count, so the body does not travel; what travels is
`hasContent`, so a guest exporting its replica can say the body was not replicated rather than print
an empty block. When you drop a field, check what would read it later, and give that reader a way to
tell absence from emptiness.

`WireModel` is the case where that question has a general answer. A guest never builds a provider
request: it renders a replica and forwards prompts to the host, which does the calling. So every
field on the host's catalog `Model` that exists to shape a request is absent from `WireModel` on
principle, not by inspection. That covers `baseUrl`, `api`, `requestModelId`, `headers`,
`maxTokens`, the `cost` table and the compatibility record. `baseUrl` is the one worth naming: on a
proxied or gateway-routed configuration it is an internal endpoint, and the `state` frame it rode on
re-broadcasts every couple of seconds while streaming.

Widening runs the other way with the same discipline. A guest's replica agent state holds a `Model`,
whose `baseUrl` is required, so `fromWireModel` fills it with `collab-guest://no-provider-endpoint`.
An empty string or a default endpoint would be a silent fallback, turning "we never send this" into
"we quietly send you somewhere else"; a scheme nothing dials fails immediately and says why. Zero
pricing is marked `"unknown"` for the same reason, because an all-zero `cost` is otherwise
indistinguishable from a genuinely free model.

## Protocol boundary

`@veyyon/wire` does not validate or route frames. It defines the shared contract used at those boundaries:

1. callers build a `GuestFrame` or `HostFrame`,
2. transport code serializes it as JSON inside an encrypted payload,
3. relay code routes opaque envelopes using the plaintext peer-id prefix,
4. receivers switch on `frame.t` and tolerate unknown future fields.

Keep protocol changes backward-aware: bump `COLLAB_PROTO` only when old hosts and guests must reject each other.
