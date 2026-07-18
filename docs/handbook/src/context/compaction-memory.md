# Compaction and project memory

Long sessions need three records: the **goal** (when enabled), the **recent transcript**, and
**compacted history**. Compaction compresses older history instead of truncating it, keeping
task-critical context.

## Context compaction

Primary compaction knobs (settings → Models → Compaction, or `config.yml`):

- **Threshold** (`compaction.thresholdPercent`) — percent of the
  context window at which auto-compaction runs. Also on demand with `/compact`.
  Optional fixed trigger: `compaction.thresholdTokens` when set `> 0`.
- **Type** (`compaction.strategy`) — how history is compressed:
  - `handoff` — writes a structured handoff summary that preserves the task, pending questions, and
    recent decisions, then continues from it (LLM transfer path).
  - `snap` — archives history via the snapcompact engine (dense image snapshot path; schema default).
- **Model** (`compaction.model`) — the model that performs LLM compaction / handoff. Unset uses your
  interactive model. See [Models, roles, and profiles](../using/roles-and-profiles.md).

`/compact <focus>` steers a run with an "Additional focus:" directive. Recent user messages are
retained verbatim up to the type's budget.

## Memory backends

When `memory.backend` is `mnemopi` or `local`, compaction can request **pre-compaction context**
from the active memory backend so summaries retain project facts. See [Memory](../features/memory.md).

## Goals

Goal cards and budgets: `/goal`, `/guided-goal`, and the `goal` tool. Structure: [Goal state and long sessions](./goal-state.md). Operator surface: [Plan mode and goals](../features/plan-mode.md).
