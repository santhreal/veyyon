# Execution-order prompts

> **Status: Built.** The harness assembles system and developer prompts and adapts them per provider.

The harness encodes control-flow discipline in base instructions: **explore → plan → edit → verify →
STOP**. Plan mode (`/plan`) and goal mode (`/goal`) add gating on top of the default prompt stack.

## Delivery

- A default system prompt plus per-tool prompts
- Per-provider streaming and tool wire format
- Skills and rules inject additional context via discovery

Edit tool prompts switch with `edit.mode` (the hashline prompt when hashline is active).

There is no `backends.toml`-driven catalog or per-backend prompt tuning, and `apply_patch` is not the
default edit surface — Veyyon uses hashline by default.
