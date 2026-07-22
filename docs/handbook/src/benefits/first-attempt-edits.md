# Why it helps

The model weights are the same ones you get anywhere. What Veyyon changes is how often a change
lands on the first attempt, and what a failed attempt costs when it happens. This chapter names the
concrete reasons, and each links the page that covers it in full.

## Fewer failed edits and tool calls

Edits and tool calls go through harness steps that catch apply and schema failures before they burn a
full retry turn.

- Hashline edits anchor on `read` / `grep` / `write` snapshot tags, so an edit that targets stale
  content fails verification with recovery context instead of writing a corrupt file.
- `edit`, `write`, and the compatibility apply modes share one approval gate.
- Schema repair coerces unambiguous malformed tool JSON before dispatch; ambiguous input is refused
  rather than guessed.

See [Editing and repair](../using/editing.md), [Repair overview](../repair/overview.md), and
[The hashline edit engine](../edit/engine.md).

## Less spent on context and retries

A run that avoids a retry turn, and that compacts instead of truncating, spends fewer tokens for the
same result. See [Context size and retries](./lower-cost.md).

## The right model for the job

Roles let a cheap model do the cheap work and a stronger one do the hard work, without you switching
by hand. See [Model and provider selection](./model-choice.md).

## Mistakes stop at the approval gate

Approval tiers and clear error returns keep a wrong tool call from cascading into more damage. See
[Approvals and errors](./safety-errors.md).
