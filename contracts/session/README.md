# @veyyon/session

What a session file is made of.

A session is an append-only file of entries; each entry names its parent, so the file is a tree
and a branch is a path through it. This package is the vocabulary of those entries and of the
messages they record. It imports only types from `@veyyon/model`.

## Exports

```ts
import type { AgentMessage, SessionEntry, SessionMessageEntry, CompactionEntry } from "@veyyon/session";
```

## Model

- `SessionEntryBase` — `type`, `id`, `parentId`, `timestamp`, optional `sequence`.
- `SessionEntry` — the union over every entry kind: `message`, `thinking_level_change`,
  `model_change`, `service_tier_change`, `compaction`, `branch_summary`, `custom`,
  `custom_message`, `label`, `title_change`, `ttsr_injection`, `mcp_tool_selection`,
  `session_init`, `mode_change`, plus every member of `CustomCompactionSessionEntries`.
- `AgentMessage` — an LLM `Message` or a member of `CustomAgentMessages`.

## Extending the vocabulary

A package that persists its own entry or message kinds augments the hook interface rather than
redeclaring the union:

```ts
declare module "@veyyon/session" {
	interface CustomCompactionSessionEntries {
		agentSpawn: AgentSpawnEntry;
	}
	interface CustomAgentMessages {
		notification: NotificationMessage;
	}
}
```
