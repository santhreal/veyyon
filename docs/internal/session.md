# Session Storage and Entry Model

This document is the source of truth for how coding-agent sessions are represented, persisted, migrated, and reconstructed at runtime.

## Scope

Covers:

- Session JSONL format and versioning
- Entry taxonomy and tree semantics (`id`/`parentId` + leaf pointer)
- Migration/compatibility behavior when loading old or malformed files
- Context reconstruction (`buildSessionContext`)
- Persistence guarantees, failure behavior, text + image blob externalization
- Storage abstractions (`FileSessionStorage`, `MemorySessionStorage`) and related utilities
- Session instrumentation: the graded per-turn and per-tool-call study records that make a stored run measurable and backtest-reproducible, and how to grep/analyze them

Does not cover `/tree` UI rendering behavior beyond semantics that affect session data.

## Implementation Files

- [`src/session/session-manager.ts`](../../packages/coding-agent/src/session/session-manager.ts): orchestration: tree/leaf, appends, persistence, blobs, lifecycle factories
- [`src/session/session-entries.ts`](../../packages/coding-agent/src/session/session-entries.ts): entry/header types, `SessionEntry` union, `CURRENT_SESSION_VERSION`
- [`src/session/session-migrations.ts`](../../packages/coding-agent/src/session/session-migrations.ts): version migrations
- [`src/session/session-loader.ts`](../../packages/coding-agent/src/session/session-loader.ts): file load + blob-ref resolution
- [`src/session/session-entry-shape.ts`](../../packages/coding-agent/src/session/session-entry-shape.ts): the shape check every decoded record passes before it is treated as a `FileEntry`
- [`src/session/session-context.ts`](../../packages/coding-agent/src/session/session-context.ts): `buildSessionContext`
- [`src/session/session-persistence.ts`](../../packages/coding-agent/src/session/session-persistence.ts): large-text + image blob externalization, transient-field stripping
- [`src/session/session-title-slot.ts`](../../packages/coding-agent/src/session/session-title-slot.ts): fixed-width title-slot serialization/parsing
- [`src/session/session-paths.ts`](../../packages/coding-agent/src/session/session-paths.ts): on-disk layout, dir encoding, terminal breadcrumbs
- [`src/session/session-listing.ts`](../../packages/coding-agent/src/session/session-listing.ts): discovery (list/recent/resolve)
- [`src/session/session-storage.ts`](../../packages/coding-agent/src/session/session-storage.ts): storage abstractions
- [`src/session/messages.ts`](../../packages/coding-agent/src/session/messages.ts): custom-message transformers
- [`src/session/blob-store.ts`](../../packages/coding-agent/src/session/blob-store.ts): content-addressed blob store
- [`src/session/history-storage.ts`](../../packages/coding-agent/src/session/history-storage.ts): prompt history (separate subsystem)
- [`src/session/operator-notices.ts`](../../packages/coding-agent/src/session/operator-notices.ts): the one channel for a non-fatal problem the operator has to see (separate subsystem, see below)

## Operator notices

`OperatorNotices` is where a subsystem says "this is degraded, carry on" and reaches a person. Use it instead of `logger.warn` for anything an operator needs to act on. The default transport set is `{ file: true }` with no console transport (`logger.ts:219`), and a TUI cannot write to the console without corrupting its render, so a `logger.warn` at startup lands in a file nobody opens. Before this existed, refusing to start was the only reliably loud mechanism in the codebase.

The contract, in the order it matters:

- A notice **buffers until a sink attaches**, because notices are raised while a session is being built and the TUI does not exist yet. That is the normal case, not an edge one: startup is exactly when skills fail to load and secrets turn out to be unprotectable.
- The **default sink is stderr**, so a caller that attaches nothing gets its notices in the wrong place rather than losing them. Interactive mode passes a sink-less collector to `createSession` and attaches its own after the first render; every other mode takes the default.
- Identical notices **collapse** on severity, source and text, keeping the first timestamp. A problem detected once per turn would otherwise train the operator to ignore the channel, which ends in the same silence by another route.
- Two severities only, `warning` and `error`. A third is never used honestly.
- `all()` is the record, so a diagnostic or a test can read what was raised without a sink ever having been attached.

Raise one with `session.operatorNotices.warn(source, text)`, where `source` is the subsystem in one lowercase word. `secrets`, `skills` and `filesystem` are the current callers. `AgentSession.skillWarnings` was the previous attempt: a getter that collected skill-loading problems and was read by no production code at all, which is worse than no channel, because the next person to need one reuses it and inherits the silence. The secrets subsystem's use of this channel is documented in [`secrets.md`](../secrets.md).

### Reaching the channel from a lower layer

`OperatorNotices` lives in `packages/coding-agent`, so `packages/utils` cannot import it, and the helpers that find most degradations there are free functions with no session handle. Those report through `reportFault` in `packages/utils/src/fault-sink.ts`, and the reporting direction is inverted: the low layer owns a sink, and whoever owns a surface attaches theirs. `sdk.ts` attaches one beside the `OperatorNotices` it builds, so every mode gets the reach without having to remember.

What you need to know before using it:

- Call `reportFault({ source, text, context })` from a low-layer helper that cannot throw and cannot reach a session. Use `OperatorNotices` directly whenever you do have a session.
- `text` is what a person reads, so it names the consequence and the remedy. `context` is the structured detail for the file log, kept out of `text` because a JSON blob mid-sentence is how a channel becomes noise.
- The **file log is written either way**, before any forwarding. Attaching a sink can only add reach, never remove the record, so no configuration reports a fault to fewer places than before.
- The sink is **module-level**, which is the opposite of the per-session rule above and deliberate. These faults are properties of the machine rather than of a session: a directory that cannot be listed affects both sessions in a process, and identical notices collapse anyway.
- A sink that throws does not break the caller, because these run inside helpers whose contract is to carry on. The throw is recorded on its own line.
- Call `setFaultSink(undefined)` in test teardown. A sink that outlives the test that installed it collects another test's faults and reports them against the wrong subject.

`fs-optional.ts` is the reason this exists. Its header promised that a directory that exists and cannot be listed "is not allowed to be silent", and it reported that with `logger.warn`, so an unreadable `~/.veyyon/agents` showed the operator "no subagents" and put the cause in a file nobody opens.

## On-Disk Layout

Default session file location:

```text
~/.veyyon/profiles/default/agent/sessions/<dir-encoded>/<timestamp>_<sessionId>.jsonl
```

`<dir-encoded>` depends on where the canonicalized cwd lives:

- inside the home directory: `-<relative-path>` with `/`, `\\`, and `:` replaced by `-` (bare `-` for home itself)
- inside the OS temp root: `-tmp-<relative-path>` with the same replacement
- anywhere else: legacy absolute form `--<cwd-without-leading-slash-with-same-replacement>--`

Old `--<home-encoded>-*--` directories are migrated to the new home-relative names once per sessions root on first access (best-effort).

Blob store location:

```text
~/.veyyon/profiles/default/agent/blobs/<sha256>
```

Terminal breadcrumb files are written under:

```text
~/.veyyon/profiles/default/agent/terminal-sessions/<terminal-id>
```

Breadcrumb content is two lines: original cwd, then session file path. `continueRecent()` prefers this terminal-scoped pointer before scanning most-recent mtime.

## File Format

Session files are JSONL: one JSON object per line.

- Physical line 1 of newly written files is a **fixed-width title slot** (`SESSION_TITLE_SLOT_BYTES = 256` bytes): `{"type":"title","v":1,"title":...,"source":"auto"|"user","updatedAt":...,"pad":"..."}` padded to exactly 256 bytes so the mutable current title can be overwritten in place (`storage.updateSessionTitle` writes the slot at offset 0) without rewriting the file. Titles too long for the slot are code-point-truncated to fit (`session-title-slot.ts`). Legacy files without a slot still load (`readTitleSlotFromFile` returns `undefined`); the slot is added on the next full rewrite.
- The session header (`type: "session"`) is the first *logical* entry: line 2 of slot-bearing files, line 1 of legacy files. Loaders strip the slot before entry parsing.
- Remaining lines are `SessionEntry` values.
- Entries are append-only at runtime; branch navigation moves a pointer (`leafId`) rather than mutating existing entries.

### Header (`SessionHeader`)

```json
{
  "type": "session",
  "version": 3,
  "id": "1f9d2a6b9c0d1234",
  "timestamp": "2026-02-16T10:20:30.000Z",
  "cwd": "/work/pi",
  "title": "optional session title",
  "titleSource": "auto",
  "parentSession": "optional lineage marker"
}
```

Notes:

- `version` is optional in v1 files; absence means v1.
- `parentSession` is an opaque lineage string. Current code writes either a session id or a session path depending on flow (`fork`, `forkFrom`, `createBranchedSession`, or explicit `newSession({ parentSession })`). Treat as metadata, not a typed foreign key.

### Entry Base (`SessionEntryBase`)

All non-header entries include:

```json
{
  "type": "...",
  "id": "8-char-id",
  "parentId": "previous-or-branch-parent",
  "timestamp": "2026-02-16T10:20:30.000Z"
}
```

`parentId` can be `null` for a root entry (first append, or after `resetLeaf()`).

## Entry Taxonomy

`SessionEntry` is the union of:

- `message`
- `thinking_level_change`
- `model_change`
- `service_tier_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `title_change`
- `ttsr_injection`
- `session_init`
- `mode_change`
- `mcp_tool_selection`
- `subagent_spawn`
- `settings_snapshot`

### `message`

Stores an `AgentMessage` directly.

```json
{
  "type": "message",
  "id": "a1b2c3d4",
  "parentId": null,
  "timestamp": "2026-02-16T10:21:00.000Z",
  "message": {
    "role": "assistant",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": {
      "input": 100,
      "output": 20,
      "cacheRead": 0,
      "cacheWrite": 0,
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "total": 0
      }
    },
    "timestamp": 1760000000000
  }
}
```

### `model_change`

```json
{
  "type": "model_change",
  "id": "b1c2d3e4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:21:30.000Z",
  "model": "openai/gpt-4o",
  "role": "default"
}
```

`role` is optional; missing is treated as `default` in context reconstruction.

### `service_tier_change`

```json
{
  "type": "service_tier_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:21:45.000Z",
  "serviceTier": { "openai": "priority", "google": "flex" }
}
```

`serviceTier` is a per-family map keyed by `openai`/`anthropic`/`google` (each value `auto`/`default`/`flex`/`scale`/`priority`), or `null` when no tier is active. Legacy entries that stored a single string (`"flex"`, `"openai-only"`, `"claude-only"`, …) are normalized to this map on read.

### `thinking_level_change`

```json
{
  "type": "thinking_level_change",
  "id": "c1d2e3f4",
  "parentId": "b1c2d3e4",
  "timestamp": "2026-02-16T10:22:00.000Z",
  "thinkingLevel": "high"
}
```

### `compaction`

```json
{
  "type": "compaction",
  "id": "d1e2f3a4",
  "parentId": "c1d2e3f4",
  "timestamp": "2026-02-16T10:23:00.000Z",
  "summary": "Conversation summary",
  "shortSummary": "Short recap",
  "firstKeptEntryId": "a1b2c3d4",
  "tokensBefore": 42000,
  "details": { "readFiles": ["src/a.ts"] },
  "preserveData": { "hookState": true },
  "fromExtension": false
}
```

### `branch_summary`

```json
{
  "type": "branch_summary",
  "id": "e1f2a3b4",
  "parentId": "a1b2c3d4",
  "timestamp": "2026-02-16T10:24:00.000Z",
  "fromId": "a1b2c3d4",
  "summary": "Summary of abandoned path",
  "details": { "note": "optional" },
  "fromExtension": true
}
```

If branching from root (`branchFromId === null`), `fromId` is the literal string `"root"`.

### `custom`

Extension state persistence; ignored by `buildSessionContext`.

```json
{
  "type": "custom",
  "id": "f1a2b3c4",
  "parentId": "e1f2a3b4",
  "timestamp": "2026-02-16T10:25:00.000Z",
  "customType": "my-extension",
  "data": { "state": 1 }
}
```

### `custom_message`

Extension-provided message that does participate in LLM context. `content` can be a string or text/image content blocks, and `attribution` records whether the user or agent initiated it.

```json
{
  "type": "custom_message",
  "id": "a2b3c4d5",
  "parentId": "f1a2b3c4",
  "timestamp": "2026-02-16T10:26:00.000Z",
  "customType": "my-extension",
  "content": "Injected context",
  "display": true,
  "details": { "debug": false },
  "attribution": "agent"
}
```

### `label`

```json
{
  "type": "label",
  "id": "b2c3d4e5",
  "parentId": "a2b3c4d5",
  "timestamp": "2026-02-16T10:27:00.000Z",
  "targetId": "a1b2c3d4",
  "label": "checkpoint"
}
```

`label: undefined` clears a label for `targetId`.

### `title_change`

Append-only audit record of a session title change (`setSessionName`). The mutable *current* title lives in the fixed-width title slot / header; this entry preserves the history.

```json
{
  "type": "title_change",
  "id": "b9c8d7e6",
  "parentId": "b2c3d4e5",
  "timestamp": "2026-02-16T10:27:30.000Z",
  "title": "New title",
  "previousTitle": "Old title",
  "source": "user",
  "trigger": "optional origin marker"
}
```

`source` is `"auto"` (generated) or `"user"` (explicit rename); auto titles are ignored once a user title is set. Persistence appends the entry and overwrites the title slot in place; if that fails (or the file has no slot yet), it falls back to a fenced atomic full rewrite (`#persistTitleChangeEntry`).

### `ttsr_injection`

```json
{
  "type": "ttsr_injection",
  "id": "c2d3e4f5",
  "parentId": "b2c3d4e5",
  "timestamp": "2026-02-16T10:28:00.000Z",
  "injectedRules": ["ruleA", "ruleB"]
}
```

### `mcp_tool_selection`

```json
{
  "type": "mcp_tool_selection",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:28:30.000Z",
  "selectedToolNames": ["server.tool"]
}
```

### `session_init`

```json
{
  "type": "session_init",
  "id": "d2e3f4a5",
  "parentId": "c2d3e4f5",
  "timestamp": "2026-02-16T10:29:00.000Z",
  "systemPrompt": "...",
  "task": "...",
  "tools": ["read", "edit"],
  "outputSchema": { "type": "object" },
  "spawns": "*",
  "readSummarize": false
}
```

### `mode_change`

```json
{
  "type": "mode_change",
  "id": "e2f3a4b5",
  "parentId": "d2e3f4a5",
  "timestamp": "2026-02-16T10:30:00.000Z",
  "mode": "plan",
  "data": { "planFile": "/tmp/plan.md" }
}
```

### `subagent_spawn`

A navigable parent to child index entry: one per subagent a session spawned. It lets a study enumerate every subagent of a run ("including subagents, everything") without scraping tool-result prose or scanning the artifacts directory. The authoritative per-subagent record is the child transcript at `sessionFile`; this entry is the index over them.

```json
{
  "type": "subagent_spawn",
  "id": "f3a4b5c6",
  "parentId": "e2f3a4b5",
  "timestamp": "2026-02-16T10:31:00.000Z",
  "agentId": "1f9d2a6b9c0d5678",
  "agentName": "task",
  "task": "Audit the GC retention paths and report findings.",
  "sessionFile": "/home/u/.veyyon/profiles/default/agent/sessions/-work-pi/20260216_parent/1f9d2a6b9c0d5678.jsonl",
  "isolation": "none",
  "status": "completed",
  "exitCode": 0,
  "durationMs": 42130,
  "usage": {
    "input": 1200,
    "output": 640,
    "cacheRead": 0,
    "cacheWrite": 0,
    "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 }
  },
  "error": "optional, present only when status is failed"
}
```

- `agentId` matches the child transcript filename stem and the `history://<agentId>` reference.
- `sessionFile` is the child's durable transcript path (`<parentArtifactsDir>/<agentId>.jsonl`). That file, its externalized blobs, and this index entry are retained together; GC never archives the child independently and moves it with the parent (proven in `gc-cli.test.ts`).
- `status` is `"completed" | "failed" | "cancelled"`; `usage`/`error` are optional.

### `settings_snapshot`

The complete resolved Tier-A config that governed the run, keyed by dotted setting path. Written once at session start (`kind: "full"`), so a later study can reproduce the exact configuration a run used rather than guessing from current defaults. A later `kind: "diff"` snapshot may carry only keys that changed.

```json
{
  "type": "settings_snapshot",
  "id": "a3b4c5d6",
  "parentId": "f3a4b5c6",
  "timestamp": "2026-02-16T10:20:31.000Z",
  "kind": "full",
  "values": {
    "compaction.strategy": "summary",
    "subagent.maxConcurrency": 4,
    "thinkingBudgets.high": 8000,
    "session.instrumentation": "ultra"
  }
}
```

- `values` is the sorted `getEffectiveSnapshot()` of every schema setting at capture time (hundreds of keys); the example is abridged.
- Settings that change mid-run and already have dedicated change entries (model, thinking level, service tier, mode, MCP selection) are not re-captured here; this snapshot fills the gap for the static governing config.
- The per-turn `request` record (below) captures the effective, possibly-overridden sampling/reasoning values a specific turn actually sent; this snapshot captures the session-level defaults. Read them together to reproduce a turn.

## Session Instrumentation (structured analysis)

Instrumentation is the graded, machine-readable study layer of the session file. It records enough structured data to explain lifecycle, task state, context weight, tool execution, model turns, and agent communication. Every added field is policy-gated and content-minimized by `session.instrumentation`.

Owner: [`packages/ai/src/instrumentation.ts`](../../packages/ai/src/instrumentation.ts) defines the closed telemetry categories and the minimum level for each category. Producers call `sessionTelemetryDetail` at the persistence boundary. Raw secrets, unredacted tool arguments, and IRC message bodies are forbidden in telemetry at every level.

### Richness levels (`session.instrumentation`)

One setting grades how densely a run records. Each level includes the previous level:

| Level | What it adds | Cost |
| --- | --- | --- |
| `off` | No added telemetry. Normal conversation and tool history is still stored and remains fully resumable. | none |
| `basic` | Lifecycle sequence, running/ended state and checkpoints; task-state transitions; tool timing/status; model request timing. | cheap timestamps and counters |
| `rich` | Context attribution; sent/received agent-message weight and outcomes; tool scheduling and result weight; model token throughput; richer session rollups. | bounded result tokenization and structured counters |
| `ultra` | Tool argument fingerprints and collision-resistant digests, abort state, context-to-compaction links, directional agent routes, per-task transitions, cache/reasoning detail, and provider provenance. | bounded hashing and provenance fields |

The category policy is explicit: lifecycle, tool spans, and goal/task telemetry begin at `basic`; context breakdown, agent communication, and analytics rollups begin at `rich`. `ultra` permits the complete structured payload for every category. Unknown levels fail closed as `off`.

Changing the setting takes effect live. Each enabled-level change closes the current lifecycle interval and starts a new interval tagged with the new level. A turn already in flight cannot be upgraded retroactively. Persistence uses the lower of the dispatch level and the current level, so turning instrumentation off before completion strips its study fields. Forked and branched child sessions start fresh lifecycle intervals; source lifecycle and checkpoint entries stay with the source identity.

Agent-message telemetry is gated independently for each participant. A rich recipient can record its `received` event while an off sender records nothing, and the reverse also holds.

The `dev` profile sets `ultra`. Every telemetry payload records enough level or source information for older and lower-detail entries to remain readable.

### Where each record attaches

- **`session_lifecycle` and `session_checkpoint` entries** record ordered lifecycle state and immutable prefix checkpoints at `basic` and above.
- **`message.metrics` on a `toolResult`** records one tool call's span and result weight.
- **`message.turnMetrics` and `message.request` on an assistant message** record model-turn timing and effective request parameters.
- **`message.contextSnapshot` on a successful assistant message** adds stored-message and tail attribution at `rich`, then the governing compaction link at `ultra`.
- **`details.telemetry` on a successful `todo` result** records aggregate task state at `basic`, before-state and affected references at `rich`, and per-task transitions at `ultra`.
- **`irc:delivery-telemetry` custom entries** record content-free sent and received delivery facts at `rich`, then routes and participant detail at `ultra`. Matching message IDs correlate the two sessions without storing the body.

`veyyon session stats [id]` reduces these records in one pass. Missing fields are never guessed, so an `off` or older session still produces normal message and provider-usage totals.

### `ToolCallMetrics` (`message.metrics` on a tool result)

Times are Unix epoch milliseconds; durations are milliseconds.

```json
{
  "type": "message",
  "message": {
    "role": "toolResult",
    "toolName": "bash",
    "content": [{ "type": "text", "text": "..." }],
    "metrics": {
      "level": "ultra",
      "timeUnit": "ms",
      "startedAt": 1760000000000,
      "endedAt": 1760000000450,
      "durationMs": 450,
      "status": "ok",
      "queuedMs": 12,
      "concurrency": "shared",
      "batchId": "b7",
      "batchIndex": 0,
      "batchSize": 3,
      "resultBytes": 2048,
      "resultBlocks": 1,
      "resultImages": 0,
      "resultTokens": 512,
      "argsBytes": 96,
      "argsHash": "1a2b3c4d",
      "argsDigest": "0123456789abcdef0123456789abcdef",
      "argsDigestAlgorithm": "sha256-128",
      "interruptible": true,
      "signalAborted": false
    }
  }
}
```

| Field | Tier | Meaning |
| --- | --- | --- |
| `level` | basic | Level this record was captured at. |
| `timeUnit` | basic | Declares milliseconds for every timestamp and duration in this record. |
| `startedAt` / `endedAt` | basic | When `tool.execute()` began / when the result was emitted. |
| `durationMs` | basic | Execution wall-clock (`endedAt - startedAt`). |
| `status` | basic | `ok` \| `error` \| `aborted` \| `blocked` \| `skipped`. |
| `uselessReason` | basic | Why a successful result was classified as contextually useless. Currently `tool-declared`. |
| `queuedMs` | rich | Time waited between batch dispatch and execution start. |
| `concurrency` | rich | `shared` \| `exclusive`: how the scheduler ran it. |
| `batchId` / `batchIndex` / `batchSize` | rich | Which tool batch it ran in, its position, and the batch size. |
| `resultBytes` / `resultBlocks` / `resultImages` | rich | UTF-8 bytes of textual content, number of content blocks, number of image blocks. |
| `resultTokens` | rich | Tokens the result adds to context (the weight the model pays). |
| `argsBytes` / `argsHash` | ultra | Serialized-args byte size and the legacy 32-bit FNV-1a fingerprint retained for compatibility. |
| `argsDigest` / `argsDigestAlgorithm` | ultra | Collision-resistant digest used for current repeated-call and unique-argument aggregation. Legacy-only and digest-backed records use separate namespaces because old records cannot be upgraded without raw arguments. |
| `interruptible` / `signalAborted` | ultra | Whether the tool declared itself interruptible, and whether its abort signal fired. |

### `AssistantTurnMetrics` (`message.turnMetrics` on an assistant message)

```json
{
  "type": "message",
  "message": {
    "role": "assistant",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "content": [{ "type": "text", "text": "Done." }],
    "usage": { "input": 100, "output": 300, "cacheRead": 0, "cacheWrite": 0, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0 } },
    "turnMetrics": {
      "level": "ultra",
      "startedAt": 1760000000000,
      "endedAt": 1760000002000,
      "durationMs": 2000,
      "status": "ok",
      "ttftMs": 500,
      "outputTokens": 300,
      "inputTokens": 100,
      "totalTokens": 400,
      "generationMs": 1500,
      "outputTokensPerSec": 200,
      "cacheReadTokens": 0,
      "cacheWriteTokens": 0,
      "reasoningTokens": 40,
      "upstreamProvider": "anthropic"
    }
  }
}
```

| Field | Tier | Meaning |
| --- | --- | --- |
| `level` | basic | Level this record was captured at. |
| `startedAt` / `endedAt` | basic | Loop-measured request dispatch / turn finalize (equals the message timestamp). |
| `durationMs` | basic | Turn wall-clock (`endedAt - startedAt`). |
| `status` | basic | `ok` \| `error` \| `aborted`. |
| `ttftMs` | basic | Provider time-to-first-token. Kept only when `0 <= ttftMs <= durationMs`; a bogus value (clock skew) is dropped, not stored. |
| `outputTokens` / `inputTokens` / `totalTokens` | rich | Token counts from the turn's own usage. |
| `generationMs` | rich | Generation window after the first token (`durationMs - ttftMs`, or `durationMs` when ttft is unknown). |
| `outputTokensPerSec` | rich | Streaming throughput: `outputTokens / (generationMs / 1000)`. Set only when output and window are positive. |
| `cacheReadTokens` / `cacheWriteTokens` | ultra | Prompt-cache token buckets. |
| `reasoningTokens` | ultra | Reasoning/thinking tokens included in `outputTokens`, when the provider reports them. |
| `upstreamProvider` | ultra | The model provider that actually served the turn, when distinct from the gateway. |

### `AssistantTurnRequest` (`message.request` on an assistant message)

The exact request parameters as sent. These are the effective per-turn values (a harmony-retry temperature bump, a dynamically resolved reasoning effort, a one-turn forced tool choice), which is why they live on the turn and not only in the start-of-run settings snapshot. Every field is optional; an unset field means the provider default was used. Captured whole at any on level (no per-tier selection); an all-defaults turn writes no `request` at all rather than an empty object.

```json
{
  "type": "message",
  "message": {
    "role": "assistant",
    "request": {
      "temperature": 0.7,
      "topP": 0.95,
      "topK": 40,
      "maxTokens": 4096,
      "presencePenalty": 0.1,
      "reasoningEffort": "high",
      "disableReasoning": false,
      "toolChoice": { "type": "tool", "name": "bash" },
      "serviceTier": "priority"
    }
  }
}
```

The numeric thinking budget is not duplicated here: it derives deterministically from `reasoningEffort` plus the `thinkingBudgets.*` values in the settings snapshot.

### Analyzing a session file

Every record is a JSON object on its own line, so standard tools work directly. Examples against a session file:

```bash
# Per-turn streaming throughput (tokens/sec), one number per model turn.
jq -c 'select(.type=="message" and .message.role=="assistant" and .message.turnMetrics)
       | .message.turnMetrics.outputTokensPerSec' session.jsonl

# Slowest tool calls: name + duration, sorted descending.
jq -c 'select(.type=="message" and .message.role=="toolResult" and .message.metrics)
       | [.message.metrics.durationMs, .message.toolName]' session.jsonl | sort -rn | head

# Every turn that hit an error or was aborted.
jq -c 'select(.message.turnMetrics.status? and .message.turnMetrics.status!="ok")
       | {t: .timestamp, status: .message.turnMetrics.status}' session.jsonl

# Repeated identical tool calls (same args fingerprint); ultra only.
jq -r 'select(.message.metrics.argsHash) | .message.metrics.argsHash' session.jsonl \
  | sort | uniq -d

# The resolved config the run used.
jq -c 'select(.type=="settings_snapshot" and .kind=="full") | .values' session.jsonl

# Enumerate the run's subagents with outcome and cost.
jq -c 'select(.type=="subagent_spawn")
       | {agent: .agentName, status, exitCode, ms: .durationMs, out: .usage.output}' session.jsonl
```

Because the fields are stable and named, a raw `grep '"outputTokensPerSec"'` or `grep '"status":"error"'` is enough for a quick scan when `jq` is not handy. This grep-ability is the point: the instrumentation schema is meant for structured after-the-fact analysis, not just live display.

## Versioning and Migration

Current session version: `3`.

### v1 -> v2

Applied when header `version` is missing or `< 2`:

- Adds `id` and `parentId` to each non-header entry.
- Reconstructs a linear parent chain using file order.
- Migrates compaction field `firstKeptEntryIndex` -> `firstKeptEntryId` when present.
- Sets header `version = 2`.

### v2 -> v3

Applied when header `version < 3`:

- For `message` entries: rewrites legacy `message.role === "hookMessage"` to `"custom"`.
- Sets header `version = 3`.

### Migration Trigger and Persistence

- Migrations run during session load (`setSessionFile`).
- If any migration ran, the session is flagged for a full rewrite (`#rewriteRequired`) rather than rewritten immediately.
- Migration mutates in-memory entries first; the flagged rewrite persists the updated JSONL on the next write (a synchronous full rewrite on the next append).

## Load and Compatibility Behavior

`loadEntriesFromFile(path)` behavior:

- Missing file (`ENOENT`) -> returns `[]`.
- A malformed line is skipped (via `parseJsonlLenient`, or the byte-buffer drain in `loadEntriesFromFileStream` for files >= 8 MiB) so one corrupt record cannot make a whole session unopenable — but the skip is never silent: each dropped record is logged with its offset and a final total is logged, so lost data is visible when studying the session rather than vanishing without a trace. Each malformed record is counted exactly once (the parser reports an error alongside the preceding good record, so counting is gated to the record's own head position).
- A line that DECODES but does not fit the shape is dropped the same way. Decoding is not validating, and a record whose fields are missing reaches readers that dereference them: an assistant entry written without `usage` used to throw while the transcript was being built, so the viewer died in its constructor and showed no rows at all. `checkSessionEntryShape` in [`session-entry-shape.ts`](../../packages/coding-agent/src/session/session-entry-shape.ts) is the one owner of that check, and both read paths call it. The record is dropped and reported with the reason, never repaired: a turn that claims `0` tokens it did not use is a wrong number in the transcript and in every total taken from it (Law 10).
- The shape check asks only for what a reader dereferences without guarding: a `message` object with a `role`, and, on an assistant turn, a `content` array and a `usage` record with four finite counters. `id`, `parentId` and `timestamp` are deliberately NOT required, because v1 sessions carry none of them and `migrateSessionEntries` fills them in after the loader returns.
- If first parsed entry is not a valid session header (`type !== "session"` or missing string `id`) -> returns `[]`.

`SessionManager.setSessionFile()` behavior:

- `[]` from loader is treated as empty/nonexistent session and replaced with a new initialized session file at that path.
- Valid files are loaded, migrated if needed, blob refs resolved, then indexed.

## Tree and Leaf Semantics

The underlying model is append-only tree + mutable leaf pointer:

- Every append method creates exactly one new entry whose `parentId` is current `leafId`.
- The new entry becomes the new `leafId`.
- `branch(entryId)` moves only `leafId`; existing entries remain unchanged.
- `resetLeaf()` sets `leafId = null`; next append creates a new root entry (`parentId: null`).
- `branchWithSummary()` sets leaf to branch target and appends a `branch_summary` entry.

`getEntries()` returns all non-header entries in insertion order. Existing entries are not deleted in normal operation; rewrites preserve logical history while updating representation (migrations, move, targeted rewrite helpers).

## Context Reconstruction (`buildSessionContext`)

`buildSessionContext(entries, leafId?, byId?, options?)` resolves what is sent to the model. Passing `options.transcript: true` instead builds the full-history display transcript (compactions emitted inline at the position they fired), display-only, never sent to a provider.

Algorithm:

1. Determine leaf:
   - `leafId === null` -> return empty context.
   - explicit `leafId` -> use that entry if found.
   - otherwise fallback to last entry.
2. Walk `parentId` chain from leaf to root and reverse to root->leaf path.
3. Derive runtime state across path:
   - `thinkingLevel` from latest `thinking_level_change` (default `"off"`)
   - `serviceTier` from latest `service_tier_change`
   - model map from `model_change` entries (`role ?? "default"`)
   - fallback `models.default` from assistant message provider/model if no explicit model change
   - deduplicated `injectedTtsrRules` from all `ttsr_injection` entries
   - selected MCP discovery tools from latest `mcp_tool_selection`
   - mode/modeData from latest `mode_change` (default mode `"none"`)
4. Build message list:
   - `message` entries pass through
   - `custom_message` entries become `custom` AgentMessages via `createCustomMessage`
   - `branch_summary` entries become `branchSummary` AgentMessages via `createBranchSummaryMessage`
   - if a `compaction` exists on path:
     - emit compaction summary first (`createCompactionSummaryMessage`)
     - emit path entries starting at `firstKeptEntryId` up to the compaction boundary
     - emit entries after the compaction boundary

`custom`, `session_init`, `service_tier_change`, `mcp_tool_selection`, `title_change`, and `ttsr_injection` entries do not inject model context directly.

## Persistence Guarantees and Failure Model

### Persist vs in-memory

- `SessionManager.create/open/continueRecent/forkFrom` -> persistent mode (`persist = true`).
- `SessionManager.inMemory` -> non-persistent mode (`persist = false`) with `MemorySessionStorage`.

### Write pipeline

Appends are written synchronously in-body through a `SessionStorageWriter` (from `storage.openWriter`), so an entry is durable the instant the append returns. Async disk work (flush, close, atomic rewrite) is serialized through an internal promise chain (`#diskTail`); appends bypass it.

- `append*` updates in-memory state immediately.
- Persistence is deferred until at least one assistant message exists.
  - Before first assistant: entries are retained in memory; no file append occurs.
  - When first assistant exists: full in-memory session is flushed to file.
  - Afterwards: new entries append incrementally.

Rationale in code: avoid persisting sessions that never produced an assistant response.

### Durability operations

- `flush()` drains the async disk chain and the open writer's queued appends (no `fsync`); `flushSync()` performs a synchronous full rewrite for exit paths that cannot await.
- Atomic full rewrites (`#rewriteAtomically`) delegate to `storage.writeTextAtomic`: temp-write then rename over the target (with an EPERM-safe move-aside fallback).
- Used for `rewriteEntries` (tool-output pruning/supersede passes) and move/fork operations. `setSessionName` instead appends a `title_change` entry and overwrites the fixed-width title slot in place, falling back to a fenced atomic rewrite on failure or when the file has no slot yet. Load-time migrations and other in-memory divergence (`#rewriteRequired`) instead trigger a synchronous full rewrite (`#rewriteSynchronously`) on the next persist.

### Error behavior

- Persistence errors are latched (`#diskFailure`) and rethrown on subsequent operations.
- First error is logged once with session file context.
- Writer close is best-effort but propagates the first meaningful error.

## Data Size Controls and Blob Externalization

Before persisting entries:

- Large strings over `MAX_PERSIST_CHARS` (500,000 chars) are externalized to the blob store, never truncated:
  - the full bytes are written content-addressed and the JSONL line keeps a short `blobtext:sha256:<hash>` ref
  - on load `resolveBlobRefsInEntries` restores the exact original string, so a huge tool result round-trips losslessly and stays fully readable when studying the session
  - signed/encrypted blocks (see the persistence pipeline) are exempt and persist verbatim
- Transient fields `partialJson` and `jsonlEvents` are removed.
- If an object has both `content` and `lineCount`, line count is recomputed from the inline content, but not when `content` is a `blobtext:` ref (the ref is one line; the real count is preserved).
- Image blocks in `content` arrays with base64 length >= 1024 are externalized to blob refs:
  - stored as `blob:sha256:<hash>`
  - raw bytes written to blob store (`BlobStore.put`)

On load, blob refs are resolved back: `blob:sha256:` image refs to base64 for message/custom_message image blocks, and `blobtext:sha256:` refs to the original string in place.

## Storage Abstractions

`SessionStorage` interface provides all filesystem operations used by `SessionManager`:

- sync: `ensureDirSync`, `existsSync`, `writeTextSync`, `statSync`, `listFilesSync`
- async: `exists`, `readText`, `readTextSlices`, `writeText`, `writeTextAtomic`, `rename`, `unlink`, `deleteSessionWithArtifacts`, `updateSessionTitle`, `openWriter`

Implementations:

- `FileSessionStorage`: real filesystem (Bun + node fs)
- `MemorySessionStorage`: map-backed in-memory implementation for tests/non-persistent sessions

`SessionStorageWriter` exposes `append`, `flush`, `isOpen`, `close`, `getError`.

## Session Discovery Utilities

Discovery helpers live in `session-listing.ts`; `SessionManager` re-exposes the project-scoped lists as thin static wrappers:

- `getRecentSessions(sessionDir, limit?)` -> lightweight metadata for UI/session picker, capped by `limit` (default 4)
- `findMostRecentSession(sessionDir)` -> newest by mtime
- `listSessions(sessionDir, storage)` (a.k.a. `SessionManager.list(cwd, sessionDir?)`) -> sessions in one project scope
- `listAllSessions(storage)` (a.k.a. `SessionManager.listAll()`) -> sessions across all project scopes under `~/.veyyon/profiles/default/agent/sessions`
- `resolveResumableSession(sessionArg, cwd, sessionDir?)` -> local then global resume/fork target lookup

Metadata extraction for `getRecentSessions` reads a prefix via `readTextSlices(..., 4096, 0)`. `listSessions`/`listAllSessions` read a 4KB prefix plus a bounded 32 KiB tail through one `readTextSlices(...)` call per file, using the prefix for metadata and the tail for lifecycle status. Resume matching is case-insensitive and accepts session id prefixes, full filename prefixes, or the id suffix after the timestamp in `<timestamp>_<sessionId>.jsonl`.

## Related but Distinct: Prompt History Storage

`HistoryStorage` (`history-storage.ts`) is a separate SQLite subsystem for prompt recall/search, not session replay.

- DB: `~/.veyyon/profiles/default/agent/history.db`
- Table: `history(id, prompt, created_at, cwd, session_id)`
- FTS5 index: `history_fts` with trigger-maintained sync
- Deduplicates consecutive identical prompts using in-memory last-prompt cache
- Inserts are batched through an async drain queue (~100 ms delay) so prompt capture does not block turn execution

Use session files for conversation graph/state replay; use `HistoryStorage` for prompt history UX.

*Verified against `ad7ede4a` on 2026-07-28.*
