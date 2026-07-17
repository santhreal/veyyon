# Internal architecture index

A map of every document in `docs/internal/`, grouped by subsystem, with the one
sentence you need to pick the right one. Start here; each doc is self-contained.

Docs here may end with a verification stamp as the last line, in the form
"Verified against \`sha\` on YYYY-MM-DD" (italicized, sha in backticks),
meaning someone checked the doc against the code at that commit. Stamp a doc
only after actually verifying it; editing a stamped doc requires re-verifying
(the CI gate `scripts/check-doc-freshness.ts` fails stamps older than the
doc's last edit). An unstamped doc simply reads as unverified.
The code-layout map lives in
[packages/coding-agent/DEVELOPMENT.md](../../packages/coding-agent/DEVELOPMENT.md).
The big picture: **coding-agent** (TS, Bun) drives the session loop and tools,
**pi-ai** normalizes providers and streaming, **pi-tui** renders, **pi-natives**
(Rust N-API) backs the hot paths (grep, PTY, shell, fs-scan), and **mnemopi** is
the optional memory backend.

## Session engine

- [session.md](./session.md) — source of truth for how sessions are represented, persisted, migrated, and reconstructed.
- [session-tree-plan.md](./session-tree-plan.md) — the session tree architecture (branch/parent structure) on top of session.md.
- [session-operations-export-share-fork-resume.md](./session-operations-export-share-fork-resume.md) — operator-visible export/dump/share/fresh/fork/resume behavior.
- [session-switching-and-recent-listing.md](./session-switching-and-recent-listing.md) — recent-session discovery, `--resume` resolution, pickers, live switching.
- [handoff-generation-pipeline.md](./handoff-generation-pipeline.md) — `/handoff`: trigger, oneshot generation, session switch, context reinjection.
- [non-compaction-retry-policy.md](./non-compaction-retry-policy.md) — the standard API-error auto-retry path in `AgentSession`.
- [ttsr-injection-lifecycle.md](./ttsr-injection-lifecycle.md) — Time Traveling Stream Rules: rule discovery, stream interruption, retry injection.
- [blob-artifact-architecture.md](./blob-artifact-architecture.md) — large/binary payload storage outside session JSONL; `artifact://` / `agent://` internal URLs.

## Tools and execution

- [bash-tool-runtime.md](./bash-tool-runtime.md) — the `bash` tool path: command normalization, execution, truncation/artifacts, rendering.
- [notebook-tool-runtime.md](./notebook-tool-runtime.md) — `.ipynb` handling and its relationship to the kernel-backed Python runtime.
- [resolve-tool-runtime.md](./resolve-tool-runtime.md) — preview/apply workflows, the pending-invoker registry, `pushPendingAction`.
- [rulebook-matching-pipeline.md](./rulebook-matching-pipeline.md) — rule discovery across config formats, normalization to one `Rule` shape, precedence.
- [task-agent-discovery.md](./task-agent-discovery.md) — how the task subsystem discovers, merges, and resolves agent definitions.
- [slash-command-internals.md](./slash-command-internals.md) — slash command discovery, dedup, surfacing, prompt-time expansion.

## Providers and the AI layer

- [adding-a-provider.md](./adding-a-provider.md) — the two-halves contract for wiring a new provider.
- [provider-endpoint-constraints.md](./provider-endpoint-constraints.md) — why "OpenAI-compatible" endpoints are not interchangeable; per-endpoint quirks.
- [provider-streaming-internals.md](./provider-streaming-internals.md) — token/tool streaming normalization in pi-ai and propagation to session events.
- [ai-schema-normalize.md](./ai-schema-normalize.md) — the one unified tool-schema normalizer providers consume.
- [toolconv/](./toolconv/) — per-model-family tool-calling conventions (anthropic, gemini, harmony, kimi-k2, qwen3, …).
- [local-tiny-models.md](./local-tiny-models.md) — experiments behind the optional embedded local tiny-model paths.
- [ERRATA-GPT5-HARMONY.md](./ERRATA-GPT5-HARMONY.md) — historical research note on GPT-5 harmony-header leakage (not a runtime contract).
- [arktype-guide.md](./arktype-guide.md) — repo-specific ArkType (Zod-migration) guide, pinned to the installed version.

## Auth

- [auth-broker-gateway.md](./auth-broker-gateway.md) — the two cooperating HTTP services that move OAuth/provider tokens onto a broker host.
- [install-id.md](./install-id.md) — the persistent per-install UUID and what it correlates.

## MCP

- [mcp-protocol-transports.md](./mcp-protocol-transports.md) — JSON-RPC messaging and the protocol/transport split.
- [mcp-runtime-lifecycle.md](./mcp-runtime-lifecycle.md) — server discovery, connection, tool exposure, refresh, teardown.
- [mcp-server-tool-authoring.md](./mcp-server-tool-authoring.md) — how server definitions become `mcp__*` tools; invalid/duplicate/disabled config behavior.

## Extensibility

- [extension-loading.md](./extension-loading.md) — discovery and loading of `.ts`/`.js` extension modules at startup.
- [gemini-manifest-extensions.md](./gemini-manifest-extensions.md) — `gemini-extension.json` manifest discovery and parsing.
- [plugin-manager-installer-plumbing.md](./plugin-manager-installer-plumbing.md) — `plugin` npm/git/link operations and how installs become runtime capabilities.

## Memory

- [mnemosyne-memory-backend.md](./mnemosyne-memory-backend.md) — `@veyyon/pi-mnemopi` as the local long-term memory backend.

## TUI

- [tui-core-renderer.md](./tui-core-renderer.md) — the append-only render contract; read before touching the engine.
- [tui-runtime-internals.md](./tui-runtime-internals.md) — the non-theme runtime path from terminal input to rendered output.
- [tui-design-language.md](./tui-design-language.md) — the terminal-UX conventions Veyyon follows.
- [retained-patterns.md](./retained-patterns.md) — coordination/prompt patterns that are deliberate keepers; do not "clean up".
- [design.md](./design.md) — the identity contract: naming, voice, wordmark, type, color, the sun motif.

## Natives (Rust)

- [native-crates.md](./native-crates.md) — contributor-facing map of the crates under `crates/`.
- [natives-architecture.md](./natives-architecture.md) — the two-layer package around the ESM loader; start here for pi-natives.
- [natives-binding-contract.md](./natives-binding-contract.md) — the JS/TS contract between callers and the loaded N-API addon.
- [natives-addon-loader-runtime.md](./natives-addon-loader-runtime.md) — how `native/index.js` picks a `.node` file; compiled-binary payload extraction.
- [natives-rust-task-cancellation.md](./natives-rust-task-cancellation.md) — native work scheduling; `timeoutMs`/`AbortSignal` flow into Rust.
- [natives-shell-pty-process.md](./natives-shell-pty-process.md) — `shell`, `pty`, `ps`, and `keys` primitives.
- [natives-text-search-pipeline.md](./natives-text-search-pipeline.md) — the text/search/code surface from JS exports to Rust modules and back.
- [natives-media-system-utils.md](./natives-media-system-utils.md) — SIXEL encoding, HTML conversion, clipboard, token counting.
- [natives-build-release-debugging.md](./natives-build-release-debugging.md) — runbook for building `.node` addons and debugging loader/build failures.
- [porting-to-natives.md](./porting-to-natives.md) — field notes for moving hot paths into pi-natives.
- [fs-scan-cache-architecture.md](./fs-scan-cache-architecture.md) — the shared Rust filesystem scan cache contract.

## Build, release, and operations

- [releasing.md](./releasing.md) — what a release IS (tag + published GitHub release) and how to cut one.
- [deployment.md](./deployment.md) — how veyyon reaches users: the website (Cloudflare Pages) and CLI binaries (GitHub Releases).
- [agent-workflow.md](./agent-workflow.md) — how an autonomous coding agent works the repo and ships updates: queue → change → gate → ship → verify, and the approval boundary.
- [macos-signing-notarization.md](./macos-signing-notarization.md) — how the shipped macOS binaries are signed and notarized.
- [porting-from-pi-mono.md](./porting-from-pi-mono.md) — repeatable checklist for porting changes from pi-mono.
- [user-facing-packages.md](./user-facing-packages.md) — index of README-only package CLIs that still need root docs coverage.

## Contributing

- [onboarding.md](./onboarding.md) — from a clone to a merged change.
- [testing.md](./testing.md) — how to run the suites and write a test that earns its place.

*Verified against `11c84f4` on 2026-07-16.*
