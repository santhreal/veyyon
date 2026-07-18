# Edit path and tool arguments

Edits and tool calls go through harness steps that reduce apply and schema failures before a full retry turn.

## Behavior

- Hashline edits anchor on `read` / `grep` / `write` snapshot tags
- `edit`, `write`, and compatibility modes share the approval gate
- Stale anchors fail verification with recovery context for the model
- Schema repair coerces unambiguous malformed tool JSON before dispatch; ambiguous input is refused

## Details

- [Editing and repair](../using/editing.md)
- [Repair overview](../repair/overview.md)
- [The hashline edit engine](../edit/engine.md)
