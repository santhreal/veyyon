# Edit-path completeness: BOM/CRLF, multi-edit, hashline

This chapter covers the correctness properties an edit path must hold no matter which edit format the
model uses, and where Veyyon stands on each. The shipped edit engine is
[hashline](./engine.md) (`@veyyon/hashline`, TypeScript); `apply_patch`, `patch`, and `replace` remain
as compatibility modes.

## BOM and line-ending preservation — Built

An edit must not silently rewrite a file's encoding. Veyyon strips a leading UTF-8 BOM before matching
and restores it afterward, and it detects the file's dominant line ending (CRLF or LF) and restores it
on write. Matching only ever runs against a normalized-to-LF copy of the body. Without this, a single
edit rewrites a CRLF file to LF or eats a BOM, which surfaces as a spurious whole-file diff and breaks
Windows checkouts. *Lever: robustness.*

## Multi-edit in one call — Built

The `edit` tool applies several disjoint changes to a file in one call rather than one round-trip per
change. Every anchor is matched against the original file, not incrementally, and replacements are
applied so that a growing earlier edit cannot invalidate a later match. Ambiguous anchors, overlapping
regions, and no-op edits fail loudly with a message the model can act on, never a silently-wrong edit.
The tool description coaches the model to keep anchors small but unique and to merge nearby changes,
which measurably reduces wasted attempts. *Lever: edit format.*

## Hashline — the token-lean form — Built

The token cost of an edit is dominated by echoing the surrounding text. Hashline removes that cost: the
model references spans by the `[PATH#TAG]` snapshot anchors that `read`, `grep`, and `write` already
emit, then sends only the operations (`SWAP`, `DEL`, `INS`) and the new text. Stale anchors are caught
by the snapshot tag and drive recovery instead of a wrong edit. Hashline is the default edit mode
(`edit.mode: hashline` in `config.yml`). See [The hashline edit engine](./engine.md). *Lever: edit
format / output tokens.*

## Concurrent-edit serialization

Non-parallel tools take an exclusive lock, so file mutations from one turn are globally serialized. A
per-path mutation queue that lets independent files edit in parallel while still serializing same-file
writes matters once subagents edit concurrently. *Lever: robustness.*

Not shipped: a byte-exact write path that preserves a missing trailing newline on the final line. The
current write model normalizes by appending one; the case is documented and covered by a test.
