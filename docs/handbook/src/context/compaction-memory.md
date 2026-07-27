# Compaction and project memory

A long session eventually fills the context window. The simple fix, dropping the oldest messages, loses
the decisions and constraints the model still needs. Compaction is the better fix: instead of
truncating old history, it compresses it into a summary and keeps working. At any moment a long session
holds three records: the goal (when enabled), the recent transcript verbatim, and the compacted history
behind it.

## Context compaction

Primary compaction knobs (settings → Models → Compaction, or `config.yml`):

- **Threshold** (`compaction.threshold`): when auto-compaction runs. The unit is
  part of the value, so one setting covers all three ways you might want to say
  it:
  - `auto` (the default) triggers at the model's context window minus the
    reserve, so it adapts to whatever model you are on.
  - `85%` is a percent of the current model's window, so the trigger moves with
    the model.
  - `170000` is an absolute token amount and triggers at the same point on every
    model. When the amount is larger than the current model's window it is
    honored up to one token below the window and you get a warning (once per
    model context window, so switching to a smaller-window model warns again).

  You can also compact on demand with `/compact`.
- **Type** (`compaction.strategy`): how history is compressed:
  - `summary`: rewrites old history into an in-place LLM summary on the current branch (the default).
  - `handoff`: writes a structured handoff summary that preserves the task, pending questions, and
    recent decisions, then continues from it (LLM transfer path).
- **Model** (`compaction.model`): the model that performs LLM compaction / handoff. Unset uses your
  interactive model. See [Models, roles, and profiles](../using/roles-and-profiles.md).

`/compact <focus>` steers a run with an "Additional focus:" directive. The most recent turns, user, assistant, and tool messages, are kept verbatim up to `compaction.keepRecentTokens` (default 20,000 tokens).

You can also pick the type for a single run by naming it first: `/compact summary` or
`/compact handoff`. The name is a one-off override, so it does not change
`compaction.strategy`. Anything after the name is focus text, as in
`/compact handoff keep the auth details`.

Two older names, `soft` and `remote`, are no longer types. `remote` selected a provider-native
compaction path and `soft` existed only to skip it; that path is removed, so there is nothing left
for them to select. If you type one, veyyon compacts with your configured type, treats the whole argument
as focus text, and says which name you used and what to use instead. Your text is passed
through exactly as you typed it, because a sentence that happens to start with "soft" is a
reasonable thing to ask for.

## Shake and duplicate elision

Shake is a lighter reducer than compaction. Instead of summarizing history, it drops heavy
content out of the live context and leaves a short placeholder in its place. Whole tool
results and large fenced or XML blocks are replaced with a marker such as
`[shaken ~1200 tokens; recover: artifact://42 (region 3)]`. The full text is saved as a
session artifact first, so you can always read it back with `read artifact://42`. Nothing is
lost, it just stops being resent on every turn. Run it on demand with `/shake`.

Shake also removes redundancy. When you read the same unchanged file twice, or run the same
command twice and get the same output, every copy but the newest carries no new information.
Shake finds each earlier tool result whose tool, arguments, and output exactly match a later
one, and elides the earlier copies through the same artifact path. The newest copy stays in
place. This runs even for recent results that the size-based pass would otherwise keep, because
a duplicate is redundant however recent it is. Results from a protected tool (such as `skill`),
error results, and results already elided are never deduplicated.

The match is exact. If a command's output changes between runs, both runs are kept, because the
later one is genuinely new information rather than a repeat.

This duplicate elision runs on its own, ahead of every strategy. Whenever auto-maintenance is about
to compact because the context crossed the threshold or overflowed, it first runs the lossless
dedup as a Tier-0 pass, whatever your `compaction.strategy` is. The pass is recall-preserving and
makes no model call, so it always runs before the heavier path and shrinks what that path has to
process. If dropping the duplicates alone brings a threshold trigger back under the bar, the
compaction is skipped entirely and your history is left intact apart from the elided copies. An
overflow recovery always finishes its compaction, because the prompt still has to be rebuilt to fit
the window, but it too starts from the smaller deduped history.

## Memory backends

When `memory.backend` is `mnemopi` or `hindsight`, compaction can request **pre-compaction context**
from the active memory backend so summaries retain project facts. See [Memory](../features/memory.md).

## Goals

Goal cards and budgets: `/goal`, `/guided-goal`, and the `goal` tool. Structure: [Goal state and long sessions](./goal-state.md). Operator surface: [Plan mode and goals](../features/plan-mode.md).
