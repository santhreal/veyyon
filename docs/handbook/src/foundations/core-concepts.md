# Core concepts

Veyyon is built around a few persistent units. This page defines the units that shape a conversation and explains how they fit together.

## Session

A **session** is the persisted unit of work. It holds a thread, a working directory, optional goal state, and a JSONL log on disk. When you run `veyyon` inside a repository, you start a new session. When you resume from the picker, you pick up an existing one.

Sessions are durable: they survive a TUI restart, a context compaction, or a machine reboot. The file on disk is the source of truth, not the in-memory state.

See [Sessions](../using/sessions.md) for operator commands and [File locations](../reference/file-locations.md) for where the files live.

## Thread

A **thread** is the conversation lineage inside a session. It is the sequence of turns from the start of the conversation to the current point. A session can contain more than one thread if you branch or fork.

The thread is the path the harness follows when it builds context for the next turn. It is not the same as the raw log file: the log file contains every entry, including branches you are no longer on.

## Turn

A **turn** is one model pass. It starts with a prompt, runs through model inference, tool calls, approvals, and edits, and ends with a final response. The TUI and CLI display each turn as one back-and-forth block.

During a turn, Veyyon can dispatch tools, apply edits, run verification, and wait for user approval. A single turn may contain many tool calls, but it is still one turn because it is one top-level model invocation with a single final response.

## How context history is preserved

Context history is preserved in two layers.

### Rollout / JSONL storage

Every event in a session is appended to a rollout file as a JSONL line. The rollout file lives under the sessions directory below the config home (`~/.veyyon/.../sessions/`). Each line is a rollout item: a user message, an agent response, a tool call, a compaction, a goal update, or a leaf move.

Rollout files are append-only. Nothing is ever rewritten. This property makes branching and resume safe and auditable. See [Sessions](../using/sessions.md) for operator commands and [Session and turn internals](../architecture/session-turn.md) for the persistence format.

### State database

Thread metadata, goal cards, and queued follow-ups are also mirrored into a local SQLite index so listing and resume do not require replaying the entire rollout log.

## How context history is updated

A turn updates the thread by appending new entries to the rollout file. The in-memory view is rebuilt from the thread's path through the log.

When a turn grows too long, the harness may **compact** the transcript. Compaction summarizes older turns into a smaller form while preserving the goal, recent user messages, file working sets, and verification facts. The compacted prefix is then used as the older context for later turns, while the recent tail remains intact. See [Compaction & project memory](../context/compaction-memory.md) for how summaries are built and what survives.

## Relationships

- A **session** owns one or more **threads** and stores them on disk.
- A **thread** is a path through the session's tree of turns.
- A **turn** is one step on that path.
- The **rollout** is the append-only log that contains every turn, branch, and system event.
- The **state database** is the runtime index for resume and active metadata.
- The **goal card** is a separate context slot that carries the current objective across turns and compactions. See [Goal state](../context/goal-state.md).

## Branching and forking

Because rollout files are append-only, branching does not delete or rewrite history. A branch is recorded as a new entry whose parent points to an earlier entry. The active leaf can be moved to any existing entry, and new turns start from there.

Use `/tree` to browse the session tree, `/fork` to copy history into a new session, `/branch` to fork from an earlier message, and `/btw` to ask a question on a short-lived side thread. See [Session branching](../features/branching.md) for commands and behavior.

## Plan mode

Plan mode is an engine mode: tool surface and prompts favor exploration and drafting a **plan file**. Finalization uses the **`resolve`** tool with plan-approval semantics. Toggle with `/plan`. See [Plan mode and goals](../features/plan-mode.md).

## What to remember

- A session is the saved work unit.
- A thread is the conversation path inside that session.
- A turn is one model pass with a beginning, middle, and end.
- Rollout files are append-only JSONL; the state database is the runtime index.
- Compaction preserves task-critical facts while shrinking the transcript.
- Branching and forking are safe because history is never rewritten.
