# The thesis: the harness is the lever

Veyyon exists because **the same model weights score wildly differently depending on the agent harness around them.** The model is capable; scaffolding restricts or unlocks it.

## The evidence

Benchmarks and production traces show tool shape, edit shape, context handling, and control flow can swing outcomes dramatically. Veyyon's oh-my-pi lineage adds hashline editing, role-based models, compaction, and explicit modes (plan, goal, vibe) as harness levers, not only prompt text.

## The two dominant levers

1. **Edit format / first-attempt edits.** When the edit format is hard to emit, models burn turns on retries. Hashline and model-tuned edit prompts are the biggest swing in Veyyon.
2. **Control flow.** Stop when verification passes; do not loop on repeated failures; budget context and subagent fan-out. Goal and plan modes encode some of this in the engine.

## What this implies for the design

- **Hashline and native edit tools** as the primary write path in `packages/coding-agent` (see engine docs under `docs/`).
- **Per-model and per-role configuration** via `modelRoles`, thinking levels, and catalog selectors.
- **Engine-enforced modes** (plan file + approval, goal continuation, tool approval tiers).
- **Evidence discipline.** Claims in this book must match tests and engine docs, or be labeled **Spec — not shipped**.

## Harness improvements are runtime work

Dogfood traces, benchmark failures, and user corrections drive small runtime improvements: better tool hints, compaction, cache-stable prefixes, clearer progress, and bounded outputs. Name the lever each change moves.

## Where to go next

- [What makes Veyyon different](../why/innovations.md)
- [Repair](../repair/overview.md) (note: the full repair cascade is **Spec — not shipped**)
- [The hashline edit engine](../edit/engine.md)
