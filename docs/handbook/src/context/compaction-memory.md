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
- **Type** (`compaction.strategy`): `summary`, the sole strategy. It rewrites old
  history into an in-place LLM summary on the current branch.
- **Model** (`compaction.model`): the models that perform LLM compaction, tried
  in order. Unset uses your interactive model. See [Fallback models](#fallback-models)
  below and [Models, roles, and profiles](../using/roles-and-profiles.md).

`/compact <focus>` steers a run with an "Additional focus:" directive. The most
recent user, assistant, and tool messages stay verbatim up to
`compaction.keepRecentTokens` (default 10,000 tokens).

Use `/handoff <focus>` when you explicitly want a new session. Handoff is not a
compaction strategy, and automatic maintenance never selects it.

Compaction and handoff both write a machine-owned continuity record separate
from generated prose. It preserves the active objective, the original user
contract, goal and todo state, pending blockers, changed paths, verification
evidence, and checkpoint state. Handoff writes that record into the replacement
session before the next turn. Reopening either session restores exact state
instead of relying on generated prose to repeat every field.

Stored legacy strategy names such as `handoff`, `snap`, `soft`, and `remote`
migrate to `summary`. A legacy `off` value also disables compaction.

## Fallback models

`compaction.model` is an ordered list, not one model:

```yaml
compaction:
  model: anthropic/claude-opus-4-1,anthropic/claude-sonnet-4-5,anthropic/claude-haiku-4-5
```

Compaction tries the first entry. If you are not signed in to it, or its context window cannot
hold the history being summarized, veyyon moves on to the second, then the third. A single model
is still written the way you would expect (`model: anthropic/claude-sonnet-4-5`). In `/settings`,
the compaction model row is the same list: add a fallback, and press Enter on any entry to move it
up.

Falling back is never quiet. When compaction runs on anything other than your first choice, you get
a warning in the session naming both models and the reason:

```text
Compacted with anthropic/haiku-4-5. anthropic/opus-4-1 was skipped: it is not authenticated.
```

You see that once per distinct reason, not once per compaction.

`compaction.modelFallbackStrategy` decides what happens after your list runs out:

- `auto` (the default) stays on models you named: your main model, the same-provider compaction
  sibling its catalog row recommends, then each of your model roles.
- `any-model` keeps going past those to the largest context window you have credentials for,
  whichever provider that is. Compaction almost never fails, at the cost of summarizing on a
  provider you did not choose for this session and being billed for it there.
- `configured-only` stops at the models you listed. Compaction fails with the reason instead, which
  is what you want when the summary quality matters more than the session continuing.

With `compaction.model` unset, `configured-only` means your interactive model and nothing else.

Compaction fires unattended, so `any-model` is the one setting here that can spend money on an
account you were not using: a session on one provider can summarize on another provider's key and
report that provider's billing error as a compaction failure. That is why it is not the default.

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

Duplicate elision runs on its own before in-place compaction. Whenever automatic
maintenance runs because context crossed the threshold or overflowed, it first
runs this lossless Tier-0 pass. If dropping duplicates brings a threshold trigger
back under the bar, compaction is skipped and history stays intact apart from the
elided copies. Overflow recovery still finishes compaction because the prompt must
be rebuilt to fit the window, but it starts from the smaller deduplicated history.

## Memory backends

When `memory.backend` is `mnemopi` or `hindsight`, compaction can request **pre-compaction context**
from the active memory backend so summaries retain project facts. See [Memory](../features/memory.md).

## Goals

Goal cards and budgets: `/goal`, `/guided-goal`, and the `goal` tool. Structure: [Goal state and long sessions](./goal-state.md). Operator surface: [Plan mode and goals](../features/plan-mode.md).
