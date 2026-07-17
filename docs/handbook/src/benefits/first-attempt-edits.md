# Edits that land the first time

The most visible difference in Veyyon is simple: fewer failed edit turns.

Most coding agents lose time in small, boring ways. A model sends a tool call with one field named
wrongly. It wraps a JSON array in a string. It emits a patch in the format the backend cannot carry. The
agent bounces the error back to the model, the model apologizes, and the same edit gets tried again.

Veyyon removes that waste at the harness layer.

## What improves

- Hashline edits anchor on `read`/`grep` snapshot tags for verifiable hunks.
- `edit`, `write`, and `apply_patch` modes share the same approval gate.
- Stale anchors fail with recovery hints instead of silent wrong edits.
- General schema repair coerces almost-right tool calls into shape before dispatch.

## Where the details live

- [Editing and repair](../using/editing.md) explains the user-facing behavior.
- [Why repair exists](../repair/overview.md) explains the repair seam.
- [The hashline edit engine](../edit/engine.md) explains the shipped edit path.
