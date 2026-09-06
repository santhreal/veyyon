# Session and turn

Sessions are JSONL conversation trees; each **turn** is one user prompt through model streaming,
tool calls, and the final assistant message.

## Responsibility

- Persist append-only session entries with `id` / `parentId` linkage
- Track the active **leaf** for branching (`/tree`, `/branch`, `/fork`)
- Drive compaction when context limits approach (`/compact`, auto-compact settings)
- Coordinate tool execution, approvals, and subagent spawns per turn

## Public boundary

- The `AgentSession` runs the turn loop.
- On-disk layout: `~/.veyyon/profiles/default/agent/sessions/<dir-encoded>/<timestamp>_<id>.jsonl`
- Blob store: `~/.veyyon/profiles/default/agent/blobs/<sha256>`

Sessions run in-process; there is no separate session daemon.

## Input during startup

Type or paste into the launch composer before session initialization finishes.
Typed input repaints before runtime initialization continues.
Submitted prompts and slash commands execute in order after initialization, without
a second Enter. Each submission retains its text and attachments; subsequent typing
remains in a separate draft.

Model-selector shortcuts use the configured keybindings during startup. The selectors
open after initialization and preserve the draft. See [Keybindings](../reference/keybindings-config.md).

User guide: [Sessions](../using/sessions.md).
