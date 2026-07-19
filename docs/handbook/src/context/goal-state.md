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
status:            # active | paused | budget-limited | complete | dropped
token_budget:      # optional
tokens_used:
time_used_seconds:
turns_completed:   # agent turns accounted to this goal
created_at / updated_at:
```

The harness persists this on the session. Updates come from `/goal` commands and the `goal` tool (`create`, `get`, `complete`, `resume`, `drop`). User objective text is escaped before prompt injection.

Token accounting includes input, output, and cache-write deltas used for provider billing. `turns_completed` counts each agent turn that ran under the goal, so it advances only while the goal is active.

## Status indicator

While a goal is set, the mode segment in the status line reads `Goal` with a live token count. When the goal has no budget, it shows the tokens used. When you set a token budget, it shows `used/budget` and a percent, for example `20K/50K 40%`. Once the goal has burned 90% or more of its budget, the segment turns to the warning color so you see the ceiling approaching before the goal hits `budget-limited`.

The goal icon animates through the theme spinner frames while the agent is streaming under the goal, and holds steady when the goal is paused or idle. The animation is driven by active processing time, so it moves only while work is happening.

The `goal.statusInFooter` setting no longer controls whether the token count appears (it always does). It now controls verbosity: turn it on to also render a compact `▰▱` progress bar next to the numbers.

To see the full goal card, press the down arrow while the composer is empty. This opens the goal detail menu (the same menu `/goal` opens): objective, status, tokens used against budget with the progress bar, completed turns, time spent, and the pause, resume, adjust-budget, and drop actions. The down arrow only opens this while a goal is active or paused, so it never interferes with normal editing.

## Context assembly

Each turn combines system rules, goal injection (when active), active instructions, recent transcript, compaction prefix, and other session context. Compaction settings: [Compaction and project memory](./compaction-memory.md). Operator commands: [Plan mode and goals](../features/plan-mode.md).

## What goal mode provides

- Objective visible across turns without rereading the full transcript
- Idle continuation toward the objective when `goal.continuationModes` allows
- Token budget and pause/complete/drop lifecycle
