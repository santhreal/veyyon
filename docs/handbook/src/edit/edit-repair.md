# Repair on edits

Schema-based tool-call repair runs on all tools, including `edit`, before argument validation. Hashline parsing and verification inside `@veyyon/hashline` is a separate step.

When a model emits a malformed `edit` (or compatibility apply_patch) call:

1. **Schema repair** attempts JSON recovery and ambiguity refusal at the agent-loop seam.
2. If repair succeeds, arguments proceed to hashline / apply_patch validation and dispatch.
3. If repair cannot disambiguate, the loop returns an error tool result with hints (no dispatch).
4. Hashline still applies envelope stripping and bare-body handling inside `@veyyon/hashline`.

See [Repair overview](../repair/overview.md) and [The hashline edit engine](./engine.md).
