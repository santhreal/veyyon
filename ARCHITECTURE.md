# Architecture

The entry point for understanding how veyyon fits together. For subsystem depth, see
[`docs/internal/`](docs/internal/) (mapped by
[`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md)); for
user-facing behavior, see the [handbook](docs/handbook/src/).

## What it is

veyyon is a terminal coding agent — a source fork of
[oh-my-pi](https://github.com/can1357/oh-my-pi) (MIT; see `UPSTREAM.md`). It ships as a
single CLI binary, `veyyon` (alias `vey`). The product is **Bun + TypeScript**; the
performance-critical hot paths are **Rust**, called from TS through a napi native
addon.

The split is deliberate: TypeScript holds the parts that change constantly: the agent
loop, TUI, provider integrations, and tools, where iteration speed matters. Rust holds the
parts that must be fast: pattern matching, terminal text measurement, directory traversal,
shell execution, and filesystem isolation.

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
         results back to the model ──► TUI render (hosts/terminal/engine)
```

Interactive use runs in the TUI; non-interactive use runs `veyyon` with a prompt or a
subcommand (`commit`, `grep`, `models`, `exec`, …).

## Workspace layout

The repository layout and component responsibilities are documented in [`AGENTS.md`](AGENTS.md).
TypeScript members are under `contracts/`, `hosts/`, `packages/` and `kernel/`; first-party Rust is
grouped by purpose under `natives/`.
Vendored third-party Rust code is under `natives/vendor/`, and the whole-product conformance corpus
is under `tests/conformance/`.

`kernel/` (`@veyyon/kernel`) is the only workspace member that is not a plugin: it holds the
plugin loader, the contribution registry, and the session spine.

The kernel follows a strict dependency direction: it may name `contracts/`, the shared runtime
packages (`@veyyon/agent-core`, `@veyyon/ai`, `@veyyon/catalog`, `@veyyon/utils`), and the platform
(node and bun builtins). It may not name a tool, a host, a mode, or `@veyyon/coding-agent`. This
rule is enforced by `scripts/the-kernel-names-no-tool-and-no-host.test.ts`.

Its source is organized into three concern directories:
- `src/registry/` — contribution registry, tool proxies, host view types, widgets, and TypeBox schemas.
- `src/loader/` — plugin loader, plugin parser, manifest keys, runtime config, marketplace client, and compatibility shims.
- `src/session/` — session spine: storage backends (SQL, Redis, indexed storage), history, persistence, migrations, compaction policy, cgroups and machine budget accounting, artifacts, turn persistence, and queue management.

Two additional concern directories, `src/settings/` and `src/log/`, are named in the target architecture and not populated yet.

`kernel/` has no root barrel and exposes no `.` entry point: a barrel nobody imports is banned
(`scripts/barrel-files-are-imported.test.ts`), and a single entry point would republish 53 modules
as one surface. Consumers import deep module paths directly (`@veyyon/kernel/<concern>/<module>`).

## Generated directories

Some directories at the root and inside packages hold output, not source. They are gitignored and
nothing in them is tracked:

| Path | Written by |
| --- | --- |
| `runs/` | default artifact sink for the benchmark harnesses (`packages/evals`) |
| `website-get/` | `website/build.mjs`, deployed to get.veyyon.dev by the `deploy_website` CI job |
| `relative-cache/` | Bun, at whatever directory it is invoked from |
| `packages/evals/runs/` | benchmark trial output |
| `packages/evals/.cache/` | vendored dataset checkouts (Terminal-Bench and friends) |
| `packages/evals/datasets/repo-cache/` | cloned upstream task repositories (several gigabytes) |
| `packages/evals/datasets/deep-swe/corpus/` | vendored DeepSWE task corpus |

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
- **Release**: dispatch the `release` workflow from GitHub Actions. It drives
  `scripts/release.ts`, which refuses to release outside CI, then tags and builds the
  per-platform binaries. See [`docs/internal/releasing.md`](docs/internal/releasing.md).
- **Deploy** (website + install endpoints): [`docs/internal/deployment.md`](docs/internal/deployment.md).
