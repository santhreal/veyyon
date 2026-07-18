# Sessions, turns, and threads

A Veyyon run is a loop of user requests and agent responses. The session holds the whole run. Each turn is one request and the agent loop that answers it. A thread is one path through the session tree. These three ideas are the foundation for branching, plan mode, and long-running context.

## Lifecycle of a run

```text
start session (veyyon / veyyon "prompt" / resume)
        │
        ▼
compose prompt ──► turn begins
        │
        ├─ assemble context (instructions, goal card, recent history, tools)
        ├─ call model
        ├─ dispatch / repair tool calls (edit, exec, MCP, …)
        ├─ approval-mode gate
        └─ final reply ──► turn ends (or Esc abort)
        │
        ▼
append rollout entry ──► update active leaf
        │
        ├─ next user message ──► next turn
        ├─ /compact when the window is tight
        └─ /fork / /branch / /tree when exploring branches
```

Interactive `veyyon`, a non-interactive `veyyon "prompt"` run, and resume paths all share this loop.
The difference is who supplies the next prompt and whether a TUI is attached.

## What a session is

A session is the unit of interactive work. Start one with `veyyon` in the repository you want to change. The session records every turn, tool call, approval, edit, and verification result.

Sessions are stored as append-only rollout JSONL files. Each line is an entry with an `id` and a `parent_id`. Those two fields make the file a tree, not just a log. The session never rewrites history. It only appends new entries or pointer moves.

## What a turn is

A turn is one user request plus the agent loop that responds to it. The loop calls the model, dispatches any tool calls, and produces the final reply. A turn ends when the model stops or when the harness decides to stop it.

While a turn runs you can steer it with `Enter` or queue a follow-up with `Tab` or `alt+enter`. A queued follow-up becomes a new turn after the current one finishes. Interrupting with `Esc` aborts the turn and returns queued messages to the composer.

## Threads and the active leaf

At any moment, one path through the session tree is active. That path is the thread. The active leaf is the current entry at the end of that path.

Branching creates siblings in the tree. `/tree` browses every entry, including abandoned branches.
`/branch` copies history up to a chosen user message into a new session file. `/fork` duplicates the
**entire** current session into a new file (no entry picker). There is no `/clone` command. The
original session is never modified.

## Context pressure and compaction

Models have a finite token window. As a session grows, the raw transcript may no longer fit. Veyyon compacts history into a smaller, information-preserving summary instead of truncating it.

Compaction preserves the goal card, active user instructions, recent turns, and a deterministic working-set of files touched so a resumed session does not require the full raw transcript.

Prefer `/compact` when you need a summary to retain state. Prefer the `/new` command when prior transcript is no longer useful and you want a clean session without summarization. See [Slash commands](../reference/slash-commands.md).

## Where the details live

- For session commands and storage, see [Sessions](../using/sessions.md).
- For branching, forking, and cloning, see [Session branching](../features/branching.md).
- For plan mode and goal tracking, see [Plan mode and goals](../features/plan-mode.md).
- For how compaction works, see [Compaction and project memory](../context/compaction-memory.md).
- For goal state and long sessions, see [Goal state and long sessions](../context/goal-state.md).
- For contributor-facing internals, see [Session and turn internals](../architecture/session-turn.md).
