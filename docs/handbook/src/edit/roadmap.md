# Edit-path properties

Correctness properties of the edit path. The default engine is hashline (`@veyyon/hashline`); `apply_patch`, `patch`, and `replace` remain as compatibility modes. See [The hashline edit engine](./engine.md).

## BOM and line endings

Edits must not silently rewrite encoding. The path strips a leading UTF-8 BOM before matching and restores it afterward, and restores the file’s dominant line ending (CRLF or LF) on write. Matching runs against a normalized LF body. Without this, one edit can rewrite CRLF to LF or drop a BOM.

## Multi-edit in one call

The `edit` tool can apply several disjoint changes in one call. Anchors match against the original file (not incrementally); replacements are ordered so earlier growth does not invalidate later matches. Ambiguous anchors, overlapping regions, and no-ops fail with an actionable error.

## Hashline

Hashline avoids re-echoing surrounding text: the model references spans by `[PATH#TAG]` snapshot anchors from `read` / `grep` / `write`, then sends operations (`SWAP`, `DEL`, `INS`) and new text. Stale tags fail verification instead of applying a wrong edit. Default: `edit.mode: hashline` in `config.yml`.

## Concurrency

Non-parallel tools take an exclusive lock so file mutations from one turn are serialized. Same-file concurrent edits from subagents still need care; independent files may proceed under the tool locking rules.

## Trailing newlines

The write path normalizes by ensuring a trailing newline on the final line when applying some write forms. Tests cover this behavior; see edit/write tool tests in `packages/coding-agent`.
