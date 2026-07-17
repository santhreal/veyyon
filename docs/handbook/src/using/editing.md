# Editing and repair

Editing reliably is the core of a coding agent. Veyyon's **default** edit surface is **hashline**:
numbered lines from `read`/`grep`, snapshot tags, and `edit` with `SWAP`/`DEL`/`INS` operations.

For design background see [Edits that land the first time](../benefits/first-attempt-edits.md) and
[The hashline edit engine](../edit/engine.md).

## Why this matters

Models often emit slightly wrong tool JSON or stale line anchors. Hashline detects stale `[path#TAG]`
tags and returns recovery hints. **General schema repair** runs on all tool calls before validation —
see [Repair overview](../repair/overview.md).

## Write path vs edit path

| Path | Applier | Role |
| --- | --- | --- |
| `edit` | `@veyyon/hashline` (default) | Surgical edits via snapshot tags and hashline ops |
| `write` | Whole-file writer | Create or overwrite files; mints new snapshot tags in hashline mode |
| `apply_patch` / `patch` / `replace` | Mode-specific parsers | Compatibility modes via `edit.mode` |

There is one **hashline edit applier** for anchored edits; `write` is intentionally separate for whole-file
creation. Both honor the same approval policy.

## Tools

| Tool | What the model sends | Use for |
| --- | --- | --- |
| `edit` | Hashline `input` (default) or mode-specific payload | Surgical edits |
| `write` | `path` + full `content` | New files or full rewrites |
| `apply_patch` | V4A envelope | When `edit.mode: apply_patch` |

Set `edit.mode` to `hashline`, `apply_patch`, `patch`, or `replace` in `config.yml`, or
`PI_EDIT_VARIANT` for one-shot overrides.

## Hashline workflow

1. **`read`** (or **`grep`**) returns `[relative/path#TAG]` and `LINE:text` rows.
2. Model calls **`edit`** with sections anchored on the same `TAG`.
3. On success, output includes a fresh `[path#NEW_TAG]` and a compact diff.

`write` strips pasted hashline prefixes when appropriate and can mint new tags after whole-file writes.

## Safety

Edits honor the approval mode like `bash`. Denied tools are removed from the model's tool
list via `disallowed_tools` / plan mode.

Veyyon uses hashline as the primary write path; `apply_patch` is a compatibility mode. There is no
single V4A applier that routes every mutation through a `make_update_patch` envelope.
