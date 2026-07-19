# Compaction and project memory

A long session eventually fills the context window. The simple fix, dropping the oldest messages, loses
the decisions and constraints the model still needs. Compaction is the better fix: instead of
truncating old history, it compresses it into a summary and keeps working. At any moment a long session
holds three records: the goal (when enabled), the recent transcript verbatim, and the compacted history
behind it.

## Context compaction

Primary compaction knobs (settings → Models → Compaction, or `config.yml`):

- **Threshold** (`compaction.thresholdTokens`): an absolute token amount,
  model-independent. Auto-compaction runs once context exceeds this many
  tokens, whatever the current model's window is. This is the primary knob.
  When the amount is larger than the current model's window, it is honored up
  to one token below the window and you get a one-time warning. Set it to
  `Default` (`-1`) to fall back to the legacy percent trigger
  (`compaction.thresholdPercent`), which is a percent of the current model's
  window. You can also compact on demand with `/compact`.
- **Type** (`compaction.strategy`): how history is compressed:
  - `handoff`: writes a structured handoff summary that preserves the task, pending questions, and
    recent decisions, then continues from it (LLM transfer path).
  - `snap`: archives history via the snapcompact engine (dense image snapshot path; schema default).
- **Model** (`compaction.model`): the model that performs LLM compaction / handoff. Unset uses your
  interactive model. See [Models, roles, and profiles](../using/roles-and-profiles.md).

`/compact <focus>` steers a run with an "Additional focus:" directive. Recent user messages are
retained verbatim up to the type's budget.

## Memory backends

When `memory.backend` is `mnemopi` or `local`, compaction can request **pre-compaction context**
from the active memory backend so summaries retain project facts. See [Memory](../features/memory.md).

## Goals

Goal cards and budgets: `/goal`, `/guided-goal`, and the `goal` tool. Structure: [Goal state and long sessions](./goal-state.md). Operator surface: [Plan mode and goals](../features/plan-mode.md).
