# The repair cascade

Before argument validation, the agent loop runs `packages/coding-agent/src/repair/schema-repair.ts` in this order:

1. **Parse leniency**: trailing commas / relaxed JSON; stringified argument blobs.
2. **Ambiguity guard**: refuse when required string fields have multiple plausible donors.
3. **Alias / typo key rename**: unknown keys that match a common alias (`filepath` → `path`, `contents` → `content`) or a casing/separator typo of a declared property are renamed to the declared name. Refuse when the rename would be ambiguous (two unknown keys map to the same property, one unknown key matches more than one declared property, or the alias target already has a value).
4. **Strict unknown-key rejection**: when the tool schema declares `additionalProperties: false`, any key left after alias resolution is refused rather than dropped or passed through.
5. **Outcome**: `clean`, `repaired` (canonical args + hints), or `unrepairable` (error tool result, no dispatch).

Conformance suite: `packages/coding-agent/test/repair/schema-repair.test.ts` (alias renames, ambiguity refusals, strict-mode refusals, and a guard that strict rejection does not fire on ArkType/Zod wire schemas that synthesize `additionalProperties: false` for closed-object emission rather than authorial strictness).

Per-model enable/disable and tool allowlist hints: [Per-model posture](./per-model.md).

## Related

- [Why repair exists](./overview.md)
- [Repair on edits](../edit/edit-repair.md)
