# The hashline edit engine

Default edit mode is **hashline** (`edit.mode: hashline` in `config.yml`), implemented in
`@veyyon/hashline`.

Veyyon applies file changes through the **`edit`** tool (hashline patch language by default). The
model copies `[PATH#TAG]` anchors from `read` / `grep` / `write` output, then emits `SWAP`, `DEL`,
and `INS` operations against numbered lines. Snapshot tags detect stale anchors and drive recovery.

Alternate modes (`apply_patch`, `patch`, `replace`) exist for compatibility; hashline is the
default and the path Veyyon optimizes for.

## How a hashline edit works

1. **`read` or `grep`** records a whole-file snapshot and prints `[relative/path#TAG]` plus
   `LINE:content` rows (`TAG` is a four-hex snapshot id).
2. The model sends **`edit`** with an `input` string: one or more `[PATH#TAG]` sections and hashline
   ops (`SWAP N.=M:`, `DEL N.=M`, `INS.POST N:`, block ops `SWAP.BLK` / `DEL.BLK` / `INS.BLK.POST`,
   plus `INS.HEAD` / `INS.TAIL`).
3. **`@veyyon/hashline`** parses, verifies the tag against the snapshot store, applies ops, and
   returns a fresh `[path#TAG]` header plus a compact diff preview.
4. **`write`** can create or overwrite whole files; in hashline display mode it also mints snapshot
   headers for the next edit.

`edit.mode` and `VEYYON_EDIT_VARIANT` select among `hashline`, `apply_patch`, `patch`, and `replace`.

## Invariants

| Property | Behavior |
| --- | --- |
| Stale anchor | Mismatch errors name the tag; snapshot recovery can suggest the current file hash |
| Line numbers | 1-indexed; body rows use `+TEXT` prefix |
| Order | Non-overlapping hunks; overlapping regions fail with an error |
| Encoding | Applies to normalized content; BOM and dominant line ending preserved on write |

## Further reading

- User guide: [Editing and repair](../using/editing.md)
- Tool contract: [`docs/tools/edit.md`](../../../tools/edit.md)
- Read/grep anchors: [`docs/tools/read.md`](../../../tools/read.md), [`docs/tools/grep.md`](../../../tools/grep.md)
- Settings: `edit.mode` in [`docs/settings.md`](../../../settings.md)

There is no `veyyon-edit` Rust crate, no V4A-only write path, and no `make_update_patch` envelope
routing. General schema-based tool-call repair **is** shipped, see
[Repair overview](../repair/overview.md).
