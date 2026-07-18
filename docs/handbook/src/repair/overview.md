# Tool-call repair

Models often emit tool arguments that are almost valid JSON or almost match the tool schema: stringified objects, trailing commas, truncated payloads, or misnamed fields. Without a repair step those calls fail validation and cost a full turn.

Repair runs in the agent loop **before** argument validation. Clear malformations are coerced into a schema-valid object; ambiguous cases are refused and returned to the model as an error tool result (no dispatch).

## Behavior

| Step | What it does |
| --- | --- |
| Seam | Runs at tool dispatch, before schema validation |
| Fix-if-clear | Trailing commas, parse sentinels (`__parseError` / `__rawJson`), stringified JSON objects |
| Refuse-if-ambiguous | Missing required strings with multiple plausible sources → unrepairable |
| Alias / typo rename | Unknown keys that clearly map to a declared property are renamed; ambiguous renames refuse |
| Strict unknown keys | Schemas with `additionalProperties: false` refuse leftover keys after alias resolution |
| Size bound | Inputs over 1 MiB refuse repair |
| Disable | `VEYYON_REPAIR_DISABLE=1`, or per-model `harness.profiles` with `repair: false` |

Implementation: `packages/coding-agent/src/repair/schema-repair.ts`  
Tests: `packages/coding-agent/test/repair/schema-repair.test.ts`

## Related

- [The repair cascade](./cascade.md) — ordered rules
- [Per-model posture](./per-model.md) — harness profiles
- [Soundness and telemetry](./soundness.md)
- [The hashline edit engine](../edit/engine.md) — edit path (separate from argument repair)
