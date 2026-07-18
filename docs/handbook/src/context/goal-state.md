# Goal state and long sessions

Long context fails when the objective is only buried in the transcript. Goal mode keeps a structured objective on the session, injects it outside the raw conversation tail, and pairs with compaction for history.

## Goal card (session-backed)

```text
id:
objective:
status:          # active | paused | budget-limited | complete | dropped
token_budget:    # optional
tokens_used:
time_used_seconds:
created_at / updated_at:
```

The harness persists this on the session. Updates come from `/goal` commands and the `goal` tool (`create`, `get`, `complete`, `resume`, `drop`). User objective text is escaped before prompt injection.

Token accounting includes input, output, and cache-write deltas used for provider billing.

## Context assembly

Each turn combines system rules, goal injection (when active), active instructions, recent transcript, compaction prefix, and other session context. Compaction settings: [Compaction and project memory](./compaction-memory.md). Operator commands: [Plan mode and goals](../features/plan-mode.md).

## What goal mode provides

- Objective visible across turns without rereading the full transcript
- Idle continuation toward the objective when `goal.continuationModes` allows
- Token budget and pause/complete/drop lifecycle
