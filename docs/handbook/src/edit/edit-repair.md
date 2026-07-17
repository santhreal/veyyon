# Repair on edits

> **Status: Partial.** General schema repair runs on **all** tools including `edit` before
> validation. Hashline-specific lenient parsing inside `@veyyon/hashline` remains separate.

When a model emits a malformed **edit** or **apply_patch** call:

1. **Schema repair** attempts JSON recovery and ambiguity refusal at the agent-loop seam.
2. If repair succeeds, arguments proceed to hashline / apply_patch validation and dispatch.
3. If repair cannot disambiguate, the loop returns a loud error with coaching hints (no dispatch).
4. Hashline still tolerates envelope stripping and bare-body piping inside `@veyyon/hashline`.

See [Repair overview](../repair/overview.md) and [The hashline edit engine](./engine.md).
