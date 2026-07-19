# Goal state and long sessions

On a long task, the model can drift. The objective was stated an hour ago, and now it is buried under a
thousand messages the model reads only the tail of. Goal mode fixes this. It pins a structured
objective to the session and injects it separately from the raw conversation tail, so the goal stays in
view no matter how long the transcript grows. It pairs with compaction, which handles the history
behind it.

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
