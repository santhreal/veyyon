# Model policy

Agent and helper machinery is configuration and spawn parameters, not a fixed pipeline. Model
policy chooses which model, prompt, and tool surface fits an agent or specialized pass.
Veyyon is provider-agnostic: no policy hard-codes a provider.

## What exists today

- **Agents** via the `task` tool (`packages/coding-agent/src/task/executor.ts`). `/agents` opens the
  live hub for active and persisted agent threads.
- **Explicit model policies**: the session model (`defaultModel`, `/model`), profile-wide agent
  defaults and per-agent overrides under `agent`, one row per feature helper under `agent.helpers`,
  plus `compaction.model`. An unset agent or helper runs the session's model and effort. Edit agents
  and helpers under Settings → Agents → Roster. See
  [Compaction & project memory](../context/compaction-memory.md) and
  [Models, helpers, and profiles](../using/roles-and-profiles.md).
- **Plan / goal modes** alter prompts and tool availability (`/plan`, `/goal`). The **advisor watchdog**
  (`advisor.enabled` and related settings, in `packages/coding-agent/src/advisor/`) is a background
  continuous-review mechanism rather than a mode you invoke; `/advisor` reports and configures it.
  See `docs/handbook/src/features/advisor.md`.
- **Addressed inter-agent messaging** via the `irc` tool (`packages/coding-agent/src/tools/agent/irc.ts`,
  `packages/coding-agent/src/task/irc-bus.ts`): `send`/`wait`/`inbox`/`list` ops over a process-global bus.
  `send` is fire-and-forget with delivery receipts; the bus wakes an idle recipient with a real turn,
  wakes an asleep one from its transcript, or injects a non-interrupting aside into a busy one, the shipped analogue of
  wake-now-vs-defer message routing. `wait` (or `send await:true`) observes the recipient's reply as a
  real turn. Controlled by `isIrcEnabled`: available to every agent and to a top-level session that can
  still spawn agents.

## No fixed pipeline

Veyyon does not enforce a staged plan → implement → verify → repair handoff. It uses lighter-weight
spawn, agent-policy, and `irc` messaging patterns instead; you compose the stages yourself.

Pair agent choice with [execution-order prompts](../models/prompts.md): explore → plan → edit → verify.
