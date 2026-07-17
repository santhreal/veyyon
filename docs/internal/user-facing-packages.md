# User-Facing Packages

This page indexes README-only user-facing package CLIs and features that need root docs coverage beyond package-local READMEs/manifests.

## Root-docs policy

- **Include** root docs coverage for package-local CLIs, extension features, dashboards, and benchmark runners that users can run directly or through `veyyon`.
- **Exclude explicitly** when a package/crate is internal implementation only; point to the architecture doc that owns it.
- Package READMEs and manifests remain the source of truth for package-local setup and flags; root docs make the feature discoverable and link to exact source paths.
- Internal Rust crates remain covered by native architecture docs unless promoted as standalone user-facing commands or APIs. The contributor-facing map lives at [`native-crates.md`](./native-crates.md); today every `crates/*` entry is internal to `@veyyon/pi-natives` and the embedded shell, so [`natives-architecture.md`](./natives-architecture.md) and the surrounding native docs own them.

## Package CLIs and features

### `packages/swarm-extension` — swarm orchestration

Sources: [`packages/swarm-extension/README.md`](../../packages/swarm-extension/README.md), [`packages/swarm-extension/package.json`](../../packages/swarm-extension/package.json), [`packages/swarm-extension/src/cli.ts`](../../packages/swarm-extension/src/cli.ts), [`packages/swarm-extension/src/extension.ts`](../../packages/swarm-extension/src/extension.ts).

- Package: `@veyyon/swarm-extension`; bin: `omp-swarm`.
- Feature: multi-agent DAG orchestration from YAML swarms, supporting `pipeline`, `parallel`, and `sequential` modes.
- Standalone CLI: `omp-swarm path/to/swarm.yaml` runs until completion or process termination.
- TUI extension mode: add the package path to `extensions`, then use `/swarm run <file.yaml>`, `/swarm status <name>`, or `/swarm help`.
- Inputs: YAML under top-level `swarm` with `name`, `workspace`, `mode`, optional `target_count`/`model`, and `agents` with `role`, `task`, optional `model`, `waits_for`, and `reports_to`.
- Side effects/output: creates the workspace if needed and persists state/logs under `<workspace>/.swarm_<name>/`.
- Limits/errors: validates the YAML definition, dependency graph, and cycles before execution; standalone runs have no built-in timeout.

### `packages/stats` — local usage dashboard

Sources: [`packages/stats/README.md`](../../packages/stats/README.md), [`packages/stats/package.json`](../../packages/stats/package.json), [`packages/coding-agent/src/cli/stats-cli.ts`](../../packages/coding-agent/src/cli/stats-cli.ts).

- Package: `@veyyon/pi-stats`; bin: `veyyon-stats`; main user path: `veyyon stats`.
- Feature: local observability dashboard for AI usage statistics from session JSONL logs.
- CLI modes: `veyyon stats` starts the dashboard server, opens `http://localhost:3847`, and keeps running; `veyyon stats --port <port>` changes the port; `veyyon stats --summary` prints a console summary; `veyyon stats --json` prints JSON and exits.
- Programmatic API: exports helpers such as `syncAllSessions()` and `getDashboardStats()` for embedding.
- Inputs/storage: reads `~/.veyyon/agent/sessions/`; stores aggregates in `~/.veyyon/stats.db`.
- Outputs: dashboard metrics and API endpoints including `/api/stats`, `/api/stats/models`, `/api/stats/folders`, `/api/stats/timeseries`, and `/api/sync`.
- Side effects/limits: syncs session files before output; long-running dashboard stops on `Ctrl+C` and closes the stats database.

### `packages/typescript-edit-benchmark` — TypeScript edit benchmark

Sources: [`packages/typescript-edit-benchmark/package.json`](../../packages/typescript-edit-benchmark/package.json), [`packages/typescript-edit-benchmark/src/generate.ts`](../../packages/typescript-edit-benchmark/src/generate.ts), [`packages/typescript-edit-benchmark/src/tasks.ts`](../../packages/typescript-edit-benchmark/src/tasks.ts), [`packages/typescript-edit-benchmark/src/verify.ts`](../../packages/typescript-edit-benchmark/src/verify.ts), [`packages/typescript-edit-benchmark/src/in-process-client.ts`](../../packages/typescript-edit-benchmark/src/in-process-client.ts).

There is no package README at this path today; the manifest and source headers are the cited package-local sources.

- Package: private `@veyyon/typescript-edit-benchmark`; library only (no `bin` entry — the benchmark runner lives in `packages/metaharness/adapters/edit/{cli,runner}.ts` and imports this package).
- Feature: fixture generation, task loading, and verification for benchmarking coding-agent edit precision on TypeScript source-code mutations.
- Modules: `generate.ts` builds fixtures by mutating a TypeScript repo (difficulty modes easy/medium/hard/nightmare; root script `bench:gen-fixtures`), `mutations.ts` defines the mutation catalog, `tasks.ts` loads tasks from a fixtures directory or `fixtures.tar.gz`, `verify.ts` compares output against expected files byte-for-byte (with format-equivalence and indent scoring), `in-process-client.ts` runs `AgentSession`s in-process to avoid per-task CLI startup cost, `formatter.ts`/`shared.ts` are support code.
- CLI (via the metaharness edit adapter): `--model` and `--output` (required), `--tasks <ids>`, `--max-tasks` (default 80), `--task-concurrency` (default 32), `--runs`, `--list`.
- Fixtures: each task directory contains `prompt.md`, `input/`, `expected/`, and `metadata.json`; bundled distribution uses `fixtures.tar.gz`.
- Outputs: JSON result snapshots written to the adapter's `--output` path, plus conversation dumps in a sibling `result.dump/` directory.
- Side effects/limits: extracts fixture archives to temp space and runs agent sessions against copied fixture inputs.

*Verified against `7ca44d3` on 2026-07-17.*
