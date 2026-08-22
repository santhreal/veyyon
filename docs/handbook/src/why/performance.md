# Performance

Agent execution latency is composed of model generation latency, tool execution I/O, validation failure retries, and harness runtime overhead.

## Retry bounds

Tool calls or edits that fail schema validation or patch application require additional model turns. Schema repair on tool arguments and patch validation on edits catch structural issues before execution. Implementation: `packages/coding-agent/src/repair/`, `@veyyon/hashline`.

## Edit path

Hashline edits reference surrounding anchor lines rather than full file rewrites, so a patch carries the changed lines and their anchors instead of a new copy of the file. Applying one costs `O(file bytes + output bytes + patch)`. The applier splits the body into lines once, walks it once, and joins the result once, so cost tracks file length rather than patch length: about 1ns per input byte, or 3ms for a 100,000-line file on a Ryzen 9 9950X. A file with CRLF endings costs roughly twice that, because the body is normalized to LF before the edit and restored after it. Run `bun bench/hot-paths.bench.ts` in `packages/hashline` to reproduce the curve. It prints the cost per byte at 10,000, 100,000 and 1,000,000 lines for a single edit and for a range delete, and fails when that cost stops being flat. See [Hashline engine](../edit/engine.md).

## Session persistence

Entries append to the session JSONL through an open writer. Compaction, elision, a title change and a recovered write fault republish the whole file instead. The body is produced in chunks of about a megabyte and written chunk by chunk, so the transient copy is bounded by the chunk rather than by the transcript. A republish reads the file back first only when what is at the path is no longer the file this session published, compared by inode and by length: a second window writing the same transcript changes both, and reading it back is what keeps its entries. Republishing a 253MiB transcript of 118,000 entries costs 509ms, 44MiB of peak resident memory above the session, and no single pause longer than 3ms, on a Ryzen 9 9950X.

## Runtime architecture

The CLI, TUI, and session loop run as TypeScript on Bun. Native grep, PTY handling, shell support, and tree-sitter parsing execute via native addons. Rust crates provide glob matching, grep orchestration, key normalization, text indexing, diffing, and directory walking. Token streaming renders output incrementally as chunks arrive from provider streams.

## Related

- [Mechanisms](./innovations.md)
- [Getting started](../using/getting-started.md)
