# Goal state and long sessions

> **Status:** Durable **goal mode** is shipped in Veyyon: per-session objective, token budget, continuation on idle, and `goal` tool ops. The richer goal card (verification ledger, working-set ledger, reviewer-finding carry-forward, retrieved-detail slots) below is **Spec — not shipped** — expansion layer only.

Long context fails when the agent loses the objective inside a large transcript. Veyyon's shipped answer is **goal mode**: a structured objective injected outside the raw conversation tail, plus compaction for history.

## Shipped goal card (session-backed)

```text
id:
objective:
status:          # active | paused | budget-limited | complete | dropped
token_budget:    # optional
tokens_used:
time_used_seconds:
created_at / updated_at:
```

The harness owns persistence on the session. The model updates via `/goal` commands and the `goal` tool (`create`, `get`, `complete`, `resume`, `drop`). User objective text is escaped before it is injected into the prompt.

Token accounting includes input, output, and cache-write deltas relevant to provider billing.

## Aspirational richer card (Spec — not shipped)

```text
constraints:
known_decisions:
blockers:
completion_criteria:
current_plan:
files_read / files_modified / commands_run:
verification_state:
reviewer_open_findings:
context_budget:
last_material_user_instruction:
retrieved_detail_handles:
```

Do not assume these fields exist in storage or prompts until a release note says otherwise.

## How it fits the context window (target model)

Each turn should eventually assemble named slots: system rules, goal card, active instructions, fresh tail, compaction prefix, retrieved detail. The 256k-class ceiling is a maximum, not a target. Required slots should fit or the harness should report overflow — not silently drop constraints.

Today, shipped slots are goal injection + compaction + standard session context.

## What goal mode buys today

- Objective visible across turns without rereading the entire transcript.
- Idle continuation toward the objective when `goal.continuationModes` allows.
- Token budget steering when `token_budget` is set.

## See also

- [Plan mode and goals](../features/plan-mode.md)
- [Compaction and project memory](./compaction-memory.md)
