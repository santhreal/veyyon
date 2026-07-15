# Role policy

> **Status: Built (partial).** Role and subagent machinery is part of the harness. Roles are
> configuration and spawn parameters, not a fixed pipeline.

Intra-harness role policy chooses which model, prompt, and tool surface fits a subagent or
specialized pass. Veyyon is provider-agnostic: roles are configuration + spawn parameters, not
hard-coded provider assumptions.

## What exists today

- **Subagents** via the `task` tool and `/agents` thread switching
- **Role model overrides** in settings (`subagent_model`, compaction model, experimental multi-agent
  overrides)
- **Plan / goal / advisor** modes alter prompts and tool gating (`/plan`, `/goal`, `/advisor`)
- **IRC** messaging between agents (`irc` tool)

## Target pipeline (Spec — not shipped)

A fixed role pipeline (plan → implement → verify → repair) is the target shape. Today Veyyon uses
lighter-weight spawn and tool patterns instead of a fixed pipeline.

Pair role choice with [execution-order prompts](../models/prompts.md): explore → plan → edit → verify.
