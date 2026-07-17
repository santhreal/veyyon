# Role policy

> **Status: Built (partial).** Role and subagent machinery is part of the harness. Roles are
> configuration and spawn parameters, not a fixed pipeline.

Intra-harness role policy chooses which model, prompt, and tool surface fits a subagent or
specialized pass. Veyyon is provider-agnostic: roles are configuration + spawn parameters, not
hard-coded provider assumptions.

## What exists today

- **Subagents** via the `task` tool (`packages/coding-agent/src/task/executor.ts`) and `/agents`
  thread switching.
- **Explicit model slots**, not a role→model matrix: the interactive model (`/model`), plus plain
  `subagent.model` and `compaction.model` fields in settings. `default` is not a model or a role. Named
  **roles** (`modelRoles`, scoped per profile) exist for anyone who wants specific work types pinned to
  specific models, but editing them lives in a settings group, not the model picker. See
  [Compaction & project memory](../context/compaction-memory.md) and
  [Models, roles, and profiles](../using/roles-and-profiles.md).
- **Plan / goal modes** alter prompts and tool gating (`/plan`, `/goal`). There is no `/advisor` slash
  command — the **advisor watchdog** (`advisor.enabled` and related settings, in
  `packages/coding-agent/src/advisor/`) is a background continuous-review mechanism, not a mode you
  invoke. See `docs/advisor-watchdog.md`.
- **Addressed inter-agent messaging** via the `irc` tool (`packages/coding-agent/src/tools/irc.ts`,
  `packages/coding-agent/src/irc/bus.ts`): `send`/`wait`/`inbox`/`list` ops over a process-global bus.
  `send` is fire-and-forget with delivery receipts; the bus wakes an idle recipient with a real turn,
  revives a parked one, or injects a non-interrupting aside into a busy one — the shipped analogue of
  wake-now-vs-defer message routing. `wait` (or `send await:true`) observes the recipient's reply as a
  real turn. Gated by `isIrcEnabled`: available to every subagent and to a top-level session that can
  still spawn subagents.

## No fixed role pipeline

Veyyon does not enforce a staged plan → implement → verify → repair handoff. It uses lighter-weight
spawn, model-slot, and `irc` messaging patterns instead; you compose the stages yourself.

Pair role choice with [execution-order prompts](../models/prompts.md): explore → plan → edit → verify.
