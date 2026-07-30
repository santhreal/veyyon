# Performance

Agent wall time is the sum of model latency, tool I/O, retries after failed tool/edit validation, and harness overhead.

## Retry cost

A tool call or edit that fails schema or apply verification usually costs another model turn. Schema repair (tool arguments) and hashline verification (edits) reduce those failures. Implementation: `packages/coding-agent/src/repair/`, `@veyyon/hashline`.

## Edit path

Hashline avoids re-emitting large surrounding context when anchors are available. Apply cost scales with patch size, not with re-serializing the full file for every change. See [Hashline engine](../edit/engine.md).

## Harness overhead and provenance

The CLI, TUI, and session loop run as TypeScript on Bun. Native grep, PTY and shell support, and tree-sitter parsing came from the oh-my-pi fork foundation. Veyyon later extracted reusable Rust crates for glob matching, grep orchestration, key normalization, text indexing, diffing, and directory walking. The crate boundaries and their current contracts are post-fork work, but the inherited grep and tree-sitter mechanisms are not Veyyon inventions. Hashline apply remains TypeScript in `@veyyon/hashline`. Streaming returns tokens as they arrive.

## Measurement

Hot-path changes are covered by package tests and criteria where present. Do not treat marketing numbers as SLAs without the linked method and host.

## Related

- [Mechanisms](./innovations.md)
- [Getting started](../using/getting-started.md)
