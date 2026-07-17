# The repair cascade

> **Status: Mostly shipped — parse leniency, alias/typo rename, and strict unknown-key rejection all
> run at the tool-dispatch seam with a conformance suite. Per-model posture and telemetry remain
> Spec — not shipped.**

## Shipped today

Before argument validation, the agent loop runs argument repair
(`packages/coding-agent/src/repair/schema-repair.ts`), in this order:

1. **Parse leniency** — trailing commas / relaxed JSON; stringified argument blobs.
2. **Ambiguity guard** — refuse when required string fields have multiple plausible donors.
3. **Alias/typo key rename** — unknown keys that match a common alias (`filepath`→`path`,
   `contents`→`content`) or a casing/separator typo of a declared property are renamed to the
   declared name; refuses rather than guesses when a rename would be ambiguous (two unknown keys
   alias to the same property, a single unknown key matches more than one declared property, or the
   alias target already has a value).
4. **Strict unknown-key rejection** — when the tool's schema declares `additionalProperties: false`,
   any key left over after alias resolution is refused rather than silently dropped or passed
   through.
5. **Outcome** — `clean`, `repaired` (canonical args + hints), or `unrepairable` (error tool result, no dispatch).

Covered by the conformance suite in `packages/coding-agent/test/repair/schema-repair.test.ts`
(alias renames, ambiguity refusals, strict-mode refusals, and a regression guard that strict
rejection never fires on ArkType/Zod-authored tools whose wire schema synthesizes
`additionalProperties: false` for closed-object emission, not as an authorial strictness opt-in).

## Spec — not shipped

1. **Per-tool shape tables** — richer per-tool repair rules beyond the generic alias/strict rules above.
2. **Per-model posture** — strictness knobs aligned with [Per-model harness profiles](../using/models.md#per-model-harness-profiles-mvp).
3. **Telemetry** — per-`(model,tool,shape)` counters ([Soundness and telemetry](./soundness.md)).

The shipped TypeScript module at the single tool-dispatch seam
(`packages/coding-agent/src/repair/schema-repair.ts`) is a TS module in `packages/coding-agent`, not
a standalone Rust crate. Veyyon extends that capability incrementally at the same seam.

See [Why repair exists](./overview.md) and [Repair on edits](../edit/edit-repair.md).
