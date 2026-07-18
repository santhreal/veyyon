# Harness design goals

Model quality depends on the agent harness: tool schemas, edit format, context handling, and control flow. The same weights can succeed or fail depending on those choices.

## Primary mechanisms

1. **Edit format.** Formats that are hard to emit cause apply failures and retries. Hashline (and model-specific edit prompts) is the main write path in `packages/coding-agent`.
2. **Control flow.** Stop when verification passes; bound retries; budget context and subagent fan-out. Plan mode, goal mode, and tool-approval tiers encode parts of this in the engine.

## Design consequences

- Hashline-aware `edit` / `write` with native verification (see [The hashline edit engine](../edit/engine.md)).
- Explicit model slots and optional roles (`modelRoles`, catalog selectors, thinking levels).
- Engine-enforced modes: plan file + resolve path, goal continuation, approval tiers.
- Schema-based tool-call repair before argument validation (see [Repair](../repair/overview.md)).

## Related

- [Mechanisms](../why/innovations.md)
- [Repair](../repair/overview.md)
- [The hashline edit engine](../edit/engine.md)
