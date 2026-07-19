# Editing and repair

Editing reliably is the core of a coding agent, so it is worth understanding how Veyyon does it. The default edit surface is hashline. In practice that means three things work together: numbered lines that come back from `read` and `grep`, snapshot tags that identify a known state of a file, and the `edit` tool with its `SWAP`, `DEL`, and `INS` operations.

For the design behind the edit and repair path, see [Edit path and tool arguments](../benefits/first-attempt-edits.md) and [The hashline edit engine](../edit/engine.md).

## Failure modes

Models often emit slightly wrong tool JSON, or line anchors that have gone stale. Hashline catches a stale `[path#TAG]` tag and returns recovery hints instead of writing the wrong bytes. On top of that, general schema repair runs on every tool call before validation. See [Repair overview](../repair/overview.md).

## Write path versus edit path

Veyyon keeps surgical edits and whole-file writes separate on purpose.

| Path | Applier | Role |
| --- | --- | --- |
| `edit` | `@veyyon/hashline` (default) | Surgical edits, anchored on snapshot tags and hashline ops |
| `write` | Whole-file writer | Create or overwrite a file, minting new snapshot tags in hashline mode |
| `apply_patch`, `patch`, `replace` | Mode-specific parsers | Compatibility modes selected by `edit.mode` |

There is one hashline edit applier for anchored edits, and `write` stays separate for whole-file creation. Both honor the same approval policy.

## Tools

| Tool | What the model sends | Use it for |
| --- | --- | --- |
| `edit` | A hashline `input` (default), or a mode-specific payload | Surgical edits |
| `write` | A `path` plus the full `content` | New files or full rewrites |
| `apply_patch` | A V4A envelope | When `edit.mode` is `apply_patch` |

You set `edit.mode` to `hashline`, `apply_patch`, `patch`, or `replace` in `config.yml`, or use `VEYYON_EDIT_VARIANT` for a one-shot override.

## Hashline workflow

The loop is short:

1. `read` (or `grep`) returns `[relative/path#TAG]` and `LINE:text` rows.
2. The model calls `edit`, anchoring each section on the same `TAG`.
3. On success, the output includes a fresh `[path#NEW_TAG]` and a compact diff.

`write` strips pasted hashline prefixes when appropriate, and can mint new tags after a whole-file write.

## Safety

Edits honor the approval mode, just as `bash` does. A denied tool is removed from the model's tool list through `disallowed_tools` or plan mode, so the model cannot call it at all.

Hashline is the primary write path, and `apply_patch` is a compatibility mode. There is no single V4A applier that routes every mutation through a `make_update_patch` envelope.
