# Internal documentation

Implementation and contributor docs, how Veyyon works, ships, and is built, for the people changing
it. None of this is published to the website or needed to *use* Veyyon; the operator-facing manual is
the [handbook](../handbook/). For the map from `src/` subsystems to their authoritative doc, start at
[`packages/coding-agent/DEVELOPMENT.md`](../../packages/coding-agent/DEVELOPMENT.md); load-bearing
decisions are recorded as [ADRs](../adr/).

New here? Read [onboarding](onboarding.md) and [testing](testing.md) first.

## Conventions

- **One page per topic.** Extend the existing page instead of adding a second one on the same subject.
- **Match tests and code.** A claim here must be true of the code, or it is a bug in the doc. When a
  page describes a planned mechanism, label it and say what ships today.
- **Keep it navigable.** Every new internal doc gets a row in the relevant table below.
- **Verification stamps.** A doc whose claims have been checked against the code ends with
  `*Verified against \`<commit-sha>\` on YYYY-MM-DD.*` as its last line. `scripts/check-doc-freshness.ts`
  (a `docs.yml` gate) fails a stamped doc edited after its stamp date, re-verify and re-stamp in the
  same change. Stamping is earned by actually verifying, never backfilled blind; unstamped docs are
  reported loudly but do not fail.

## Getting started and process

| Doc | Covers |
| --- | --- |
| [onboarding.md](onboarding.md) | Clone, run from source (`bun setup` / `bun dev`), and the gate. |
| [testing.md](testing.md) | How the suites are organized and what to run. |
| [releasing.md](releasing.md) | Cutting a release: versioning, changelog, binaries, publish. |
| [deployment.md](deployment.md) | Website (Cloudflare Pages) and install-script deployment. |
| [agent-workflow.md](agent-workflow.md) | How an autonomous agent works this repo and ships updates. |

## Design and brand

| Doc | Covers |
| --- | --- |
| [design.md](design.md) | The full design & brand contract: naming, voice, wordmark, type, color, the sun motif. |
| [brand.md](brand.md) | Condensed identity contract: name, palette (the ember sun), and identity rules. |
| [tui-design-language.md](tui-design-language.md) | The terminal-UX conventions Veyyon follows. |
| [retained-patterns.md](retained-patterns.md) | Coordination and prompt patterns kept from upstream. |

## Native crates (Rust / N-API)

| Doc | Covers |
| --- | --- |
| [natives-architecture.md](natives-architecture.md) | How the `veyyon-natives` addon is structured and loaded. |
| [native-crates.md](native-crates.md) | The Rust crate layout under `crates/`. |
| [natives-binding-contract.md](natives-binding-contract.md) | The JS/TS ↔ native binding contract. |
| [natives-addon-loader-runtime.md](natives-addon-loader-runtime.md) | Runtime resolution and load of the native addon. |
| [natives-build-release-debugging.md](natives-build-release-debugging.md) | Building, releasing, and debugging the natives (incl. the robomp cache). |
| [natives-shell-pty-process.md](natives-shell-pty-process.md) | Shell, PTY, and process internals. |
| [natives-text-search-pipeline.md](natives-text-search-pipeline.md) | The in-process grep/walker text-search pipeline. |
| [natives-media-system-utils.md](natives-media-system-utils.md) | Media and system utility natives. |
| [natives-rust-task-cancellation.md](natives-rust-task-cancellation.md) | Rust task execution and cancellation. |
| [porting-to-natives.md](porting-to-natives.md) | Field notes on moving code into the N-API layer. |
| [fs-scan-cache-architecture.md](fs-scan-cache-architecture.md) | The filesystem scan-cache contract. |

## TUI

| Doc | Covers |
| --- | --- |
| [tui-core-renderer.md](tui-core-renderer.md) | The append-only renderer contract. |
| [tui-runtime-internals.md](tui-runtime-internals.md) | TUI runtime internals. |

## Tools and runtime

| Doc | Covers |
| --- | --- |
| [bash-tool-runtime.md](bash-tool-runtime.md) | The `bash` tool's execution runtime. |
| [notebook-tool-runtime.md](notebook-tool-runtime.md) | Notebook file runtime internals. |
| [resolve-tool-runtime.md](resolve-tool-runtime.md) | The `resolve` tool runtime. |
| [slash-command-internals.md](slash-command-internals.md) | How slash commands are registered and dispatched. |
| [handoff-generation-pipeline.md](handoff-generation-pipeline.md) | The `/handoff` generation pipeline. |
| [ttsr-injection-lifecycle.md](ttsr-injection-lifecycle.md) | Time-traveling stream-rule injection lifecycle. |
| [task-agent-discovery.md](task-agent-discovery.md) | How `task` subagents are discovered and selected. |

## MCP

| Doc | Covers |
| --- | --- |
| [mcp-protocol-transports.md](mcp-protocol-transports.md) | MCP protocol and transport internals. |
| [mcp-runtime-lifecycle.md](mcp-runtime-lifecycle.md) | MCP client/server runtime lifecycle. |
| [mcp-server-tool-authoring.md](mcp-server-tool-authoring.md) | Authoring MCP servers and tools. |

## Providers and models

| Doc | Covers |
| --- | --- |
| [adding-a-provider.md](adding-a-provider.md) | Wiring a new provider end to end. |
| [provider-endpoint-constraints.md](provider-endpoint-constraints.md) | Per-provider endpoint constraints. |
| [provider-streaming-internals.md](provider-streaming-internals.md) | Streaming decode/encode internals. |
| [ai-schema-normalize.md](ai-schema-normalize.md) | Tool-schema normalization across providers. |
| [non-compaction-retry-policy.md](non-compaction-retry-policy.md) | The non-compaction auto-retry policy. |
| [local-tiny-models.md](local-tiny-models.md) | Embedded local tiny-model experiments. |

## Sessions and memory

| Doc | Covers |
| --- | --- |
| [session.md](session.md) | Session storage and the entry model. |
| [session-tree-plan.md](session-tree-plan.md) | The session-tree architecture. |
| [session-operations-export-share-fork-resume.md](session-operations-export-share-fork-resume.md) | export / dump / share / fresh / fork / resume. |
| [session-switching-and-recent-listing.md](session-switching-and-recent-listing.md) | Switching sessions and the recent-list. |
| [mnemosyne-memory-backend.md](mnemosyne-memory-backend.md) | The mnemopi memory backend. |

## Extensions, plugins, and rules

| Doc | Covers |
| --- | --- |
| [extension-loading.md](extension-loading.md) | Loading TypeScript/JavaScript extension modules. |
| [plugin-manager-installer-plumbing.md](plugin-manager-installer-plumbing.md) | Plugin install/link state and runtime wiring. |
| [gemini-manifest-extensions.md](gemini-manifest-extensions.md) | The `gemini-extension.json` manifest. |
| [rulebook-matching-pipeline.md](rulebook-matching-pipeline.md) | How rule files are discovered and matched. |

## Auth, security, and release ops

| Doc | Covers |
| --- | --- |
| [auth-broker-gateway.md](auth-broker-gateway.md) | The auth-broker and auth-gateway services. |
| [macos-signing-notarization.md](macos-signing-notarization.md) | Signing and notarizing the macOS binaries. |
| [install-id.md](install-id.md) | The install-ID mechanism. |
| [blob-artifact-architecture.md](blob-artifact-architecture.md) | Blob and artifact storage. |

## Porting and errata

| Doc | Covers |
| --- | --- |
| [porting-from-pi-mono.md](porting-from-pi-mono.md) | Merging changes from the upstream pi-mono. |
| [arktype-guide.md](arktype-guide.md) | Migrating Zod → ArkType in this repo. |
| [ERRATA-GPT5-HARMONY.md](ERRATA-GPT5-HARMONY.md) | GPT-5 Harmony-header leakage erratum. |

## Packaging

| Doc | Covers |
| --- | --- |
| [user-facing-packages.md](user-facing-packages.md) | The published packages and their bins. |

## Tool-call conversion notes

Per-model tool-call wire-format notes live in [toolconv/](toolconv/) (Anthropic, DeepSeek, Gemini, Gemma, Harmony, Kimi, Qwen, GLM, pi-native).

## Operations

Step-by-step runbooks for when something breaks live in [runbooks/](runbooks/).

*Verified against `d3e3db30` on 2026-07-23.*
