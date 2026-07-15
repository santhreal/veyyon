# The repair cascade

> **Status: Partial — basic seam shipped; full cascade is Spec — not shipped.**

## Shipped today

Before argument validation, the agent loop runs argument repair:

1. **Parse leniency** — trailing commas / relaxed JSON; stringified argument blobs.
2. **Ambiguity guard** — refuse when required string fields have multiple plausible donors.
3. **Outcome** — `clean`, `repaired` (canonical args + hints), or `unrepairable` (error tool result, no dispatch).

## Spec — not shipped

When built out, repair will add an ordered rule set:

1. **Schema rules** — coerce types, fill defaults, map alias field names, reject unknown keys when strict.
2. **Per-model posture** — strictness knobs aligned with [Per-model harness profiles](../using/models.md#per-model-harness-profiles-mvp).
3. **Telemetry** — per-`(model,tool,shape)` counters ([Soundness and telemetry](./soundness.md)).

The target design extends the shipped TypeScript module at the single tool-dispatch seam
(`packages/coding-agent/src/repair/schema-repair.ts`) with a large conformance suite — this is a TS
module in `packages/coding-agent`, not a standalone Rust crate. Veyyon adds that capability
incrementally at the same seam.

See [Why repair exists](./overview.md) and [Repair on edits](../edit/edit-repair.md).
