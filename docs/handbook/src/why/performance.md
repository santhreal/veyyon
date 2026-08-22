# Performance

Agent execution latency is composed of model generation latency, tool execution I/O, validation failure retries, and harness runtime overhead.

## Retry bounds

Tool calls or edits that fail schema validation or patch application require additional model turns. Schema repair on tool arguments and patch validation on edits catch structural issues before execution. Implementation: `packages/coding-agent/src/repair/`, `@veyyon/hashline`.

## Edit path

Hashline edits reference surrounding anchor lines rather than full file rewrites. Application cost scales with patch size instead of total file length. See [Hashline engine](../edit/engine.md).

## Runtime architecture

The CLI, TUI, and session loop run as TypeScript on Bun. Native grep, PTY handling, shell support, and tree-sitter parsing execute via native addons. Rust crates provide glob matching, grep orchestration, key normalization, text indexing, diffing, and directory walking. Token streaming renders output incrementally as chunks arrive from provider streams.

## Related

- [Mechanisms](./innovations.md)
- [Getting started](../using/getting-started.md)
