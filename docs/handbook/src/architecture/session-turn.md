# Session and turn

Sessions are JSONL conversation trees; each **turn** is one user prompt through model streaming,
tool calls, and the final assistant message.

## Responsibility

- Persist append-only session entries with `id` / `parentId` linkage
- Track the active **leaf** for branching (`/tree`, `/branch`, `/fork`)
- Drive compaction when context limits approach (`/compact`, auto-compact settings)
- Coordinate tool execution, approvals, and subagent spawns per turn

## Public boundary

- The `AgentSession` owns the turn loop.
- On-disk layout: `~/.veyyon/profiles/default/agent/sessions/<dir-encoded>/<timestamp>_<id>.jsonl`
- Blob store: `~/.veyyon/profiles/default/agent/blobs/<sha256>`

Sessions run in-process; there is no separate session daemon.

User guide: [Sessions](../using/sessions.md).
