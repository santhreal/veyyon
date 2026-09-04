# @veyyon/wire

TypeScript wire protocol contracts for Veyyon collab live sessions.

Provides protocol types, AES-GCM envelope serialization helpers, and constants shared across `@veyyon/coding-agent`, `@veyyon/collab-web`, and relay services without external runtime dependencies.

## Exports

```ts
import type { GuestFrame, HostFrame, WireSessionEntry } from "@veyyon/wire";
import { COLLAB_PROTO, DEFAULT_RELAY_URL, ENVELOPE_HEADER_LENGTH } from "@veyyon/wire";
```

### Type categories

- **Transcript entries:** Protocol-safe message subsets rendered by guest clients (`WireSessionEntry`, `WireSessionHeader`, `WireUserMessage`, `WireDeveloperMessage`, `WireAssistantMessage`, `WireToolResultMessage`, `WireMessage`, `WireStopReason`, `WireUsage`).
- **Custom entry roles:** Custom message hooks rendered in guest transcripts (`bashExecution`, `pythonExecution`, `custom`, `hookMessage`, `branchSummary`, `compactionSummary`, `fileMention`).
- **Frames:** `GuestFrame`, `HostFrame`, and `WireFrame` payload unions for encrypted communication.
- **Relay messages:** Text-based WebSocket control messages.
- **Constants:** `COLLAB_PROTO`, `DEFAULT_RELAY_URL`, `ENVELOPE_HEADER_LENGTH`.

## Projection model

Host implementations project full internal data structures into `Wire*` shapes before serializing:

```ts
import {
  toWireAgentEvent,
  toWireModel,
  toWireSessionEntry,
  toWireSessionHeader,
} from "@veyyon/coding-agent/collab/protocol";
```

Transport shapes omit provider internal payloads, telemetry fields (`contextSnapshot`, `turnMetrics`), and internal configuration details not required for client rendering.

## Protocol boundary

1. Participants construct typed `GuestFrame` or `HostFrame` payloads.
2. Frames are encrypted via AES-256-GCM.
3. Relay nodes route opaque envelopes by peer identifier prefix.
4. Receivers decrypt and dispatch on `frame.t`.
