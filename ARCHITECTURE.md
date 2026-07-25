# Architecture

The entry point for understanding how veyyon fits together. For subsystem depth, see
[`docs/internal/`](docs/internal/) (mapped by
[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md)); for
user-facing behavior, see the [handbook](docs/handbook/src/).

## What it is

veyyon is a terminal coding agent — a fork of
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT; see `UPSTREAM.md`). It ships as a
single CLI binary, `veyyon` (alias `vey`). The product is **Bun + TypeScript**; the
performance-critical hot paths are **Rust**, called from TS through a napi native
addon.

The split is deliberate: TypeScript holds the parts that change constantly — the agent
loop, TUI, provider integrations, tools — where iteration speed matters. Rust holds the
parts that must be fast — grep, PTY, shell, text scanning. Roughly 665k lines of TS
(plus ~427k of tests) to ~173k lines of Rust across nine crates.

## Request path

```text
prompt ──► veyyon (src/cli.ts)
              │  worker-host dispatch, arg parse, command registry
              ▼
         AgentSession turn loop        (packages/agent)
              │
              ▼
         model stream + tool calls     (packages/ai — providers, streaming)
              │
              ▼
         tool handlers                 (read, bash, edit, grep, …)
              │        └─► Rust natives via napi (grep, pty, shell, text)
              ▼
         results back to the model ──► TUI render (packages/tui)
```

Interactive use runs in the TUI; non-interactive use runs `veyyon` with a prompt or a
subcommand (`commit`, `grep`, `models`, `exec`, …).

## Packages

| Package | Responsibility |
| --- | --- |
| `packages/coding-agent` | The CLI application — commands, TUI modes, tools, setup, the entry point. The primary package. |
| `packages/agent` | Agent runtime: the turn loop, tool-calling, state. |
| `packages/ai` | Multi-provider LLM client with streaming; provider dialects. |
| `packages/catalog` | Model catalog: bundled `models.json`, provider descriptors, model identity/classification (generated — see `AGENTS.md`). |
| `packages/tui` | Terminal UI library with differential rendering. |
| `packages/natives` | JS bindings for the Rust native addon. |
| `packages/utils` | Shared utilities (logger, streams, env, dirs). |
| `packages/stats` | Local observability dashboard (`veyyon stats`). |
| `packages/argot` | Per-project shorthand vocabularies: a lossless substitution codec over an `AGENTS.dict` file. Published standalone, so it depends on nothing in this repo. |
| `packages/hashline` | The line-anchored patch language the edit tool applies, with a pluggable filesystem backend. |
| `packages/mnemopi` | Local SQLite memory engine: triples, embeddings, recall. |
| `packages/wire` | Dependency-free collab live-session wire types, so a browser or test client need not depend on `coding-agent`. |
| `packages/tool-render` | Shared React tool-call renderers for the HTML export and `collab-web`. |
| `packages/collab-web` | Browser guest client and local relay for collab live sessions (private). |
| `packages/swarm-extension` | Swarm orchestration extension. |
| `packages/metaharness` | Benchmark runners plus Harbor run storage, its REST/SSE API, and the live dashboard (private). |
| `packages/deepswe-bench` | DeepSWE bench runner for performance-affecting changes (private). |
| `packages/typescript-edit-benchmark` | Edit-tool benchmark built from TypeScript source mutations (private). |
| `crates/veyyon-natives` (+ siblings) | Rust hot paths: grep, PTY, shell, text/AST. |

`packages/tsconfig.workspace.json` is shared TypeScript configuration, not a workspace member — it
has no `package.json` and no sources. Tooling that enumerates packages skips entries without a
manifest.

## Generated directories

Some directories at the root and inside packages hold output, not source. They are gitignored and
nothing in them is tracked:

| Path | Written by |
| --- | --- |
| `runs/` | default artifact sink for the benchmark harnesses (`deepswe-bench`, `metaharness`) |
| `website-get/` | `website/build.mjs`, deployed to get.veyyon.dev by the `deploy_website` CI job |
| `relative-cache/` | Bun, at whatever directory it is invoked from |
| `packages/deepswe-bench/runs/` | benchmark trial output |
| `packages/deepswe-bench/repo-cache/` | cloned upstream task repositories (several gigabytes) |

`scripts/root-layout.test.ts` asserts each one carries a deliberate ignore entry and tracks zero
files, and that the `website-get/` staging step still exists — an ignore rule that outlives the build
step writing it is how an install endpoint starts deploying an empty directory.

## Cross-cutting rules

These are enforced conventions, documented in [`AGENTS.md`](AGENTS.md):

- **Layering** — domain logic never imports CLI/transport/UI. Catalog *values* come
  from `@veyyon/catalog`, not the `@veyyon/ai` barrel.
- **No silent fallbacks** — a control that can't do its job fails loudly, not quietly.
- **Bun first** — Bun APIs (`Bun.file`, Bun Shell, `bun:sqlite`, single-file
  `--compile`, the worker-reentry model) over `node:*` where they fit.
- **One home per value** — constants, parsers, and predicates have a single owner.
- **One home per dependency version** — third-party versions live in `workspaces.catalog`
  in the root `package.json`, and packages write `"react": "catalog:"` rather than a range.
  A dependency two or more packages use belongs in the catalog. Peer dependencies stay
  literal, because a consumer outside this workspace cannot resolve `catalog:`, but the
  range must name the version the catalog resolves. `scripts/workspace-catalog-pins.test.ts`
  enforces all three.

## Build, test, ship

- **Gate**: `bun run check` (types + lint) and the test buckets — see
  [`docs/internal/testing.md`](docs/internal/testing.md).
- **Release**: `bun run release` → tag → CI builds per-platform binaries and publishes —
  see [`docs/internal/releasing.md`](docs/internal/releasing.md).
- **Deploy** (website + install endpoints): [`docs/internal/deployment.md`](docs/internal/deployment.md).
