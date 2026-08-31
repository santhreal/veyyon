# User-Facing Packages

This page indexes README-only user-facing package CLIs and features that need root docs coverage beyond package-local READMEs/manifests.

## Root-docs policy

- **Include** root docs coverage for package-local CLIs, extension features, dashboards, and benchmark runners that users can run directly or through `veyyon`.
- **Exclude explicitly** when a package/crate is internal implementation only; point to the architecture doc that owns it.
- Package READMEs and manifests remain the source of truth for package-local setup and flags; root docs make the feature discoverable and link to exact source paths.
- Internal Rust crates remain covered by native architecture docs unless promoted as standalone user-facing commands or APIs. The contributor-facing map lives at [`native-crates.md`](./native-crates.md); today every `natives/*` entry is internal to `@veyyon/natives` and the embedded shell, so [`natives-architecture.md`](./natives-architecture.md) and the surrounding native docs own them.

## Package CLIs and features

### `plugins/mode-swarm`: swarm orchestration

Sources: [`plugins/mode-swarm/README.md`](../../plugins/mode-swarm/README.md), [`plugins/mode-swarm/package.json`](../../plugins/mode-swarm/package.json), [`plugins/mode-swarm/src/cli.ts`](../../plugins/mode-swarm/src/cli.ts), [`plugins/mode-swarm/src/extension.ts`](../../plugins/mode-swarm/src/extension.ts).

- Package: `@veyyon/swarm-extension`; bin: `veyyon-swarm`.
- Feature: multi-agent DAG orchestration from YAML swarms, supporting `pipeline`, `parallel`, and `sequential` modes.
- Standalone CLI: `veyyon-swarm path/to/swarm.yaml` runs until completion or process termination.
- TUI extension mode: add the package path to `extensions`, then use `/swarm run <file.yaml>`, `/swarm status <name>`, or `/swarm help`.
- Inputs: YAML under top-level `swarm` with `name`, `workspace`, `mode`, optional `target_count`/`model`, and `agents` with `role`, `task`, optional `model`, `waits_for`, and `reports_to`.
- Side effects/output: creates the workspace if needed and persists state/logs under `<workspace>/.swarm_<name>/`.
- Limits/errors: validates the YAML definition, dependency graph, and cycles before execution; standalone runs have no built-in timeout.

### `packages/stats`: local usage dashboard

Sources: [`packages/stats/README.md`](../../packages/stats/README.md), [`packages/stats/package.json`](../../packages/stats/package.json), [`packages/coding-agent/src/cli/stats-cli.ts`](../../packages/coding-agent/src/cli/stats-cli.ts).

- Package: `@veyyon/stats`; bin: `veyyon-stats`; main user path: `veyyon stats`.
- Feature: local observability dashboard for AI usage statistics from session JSONL logs.
- CLI modes: `veyyon stats` starts the dashboard server, opens `http://localhost:3847`, and keeps running; `veyyon stats --port <port>` changes the port; `veyyon stats --summary` prints a console summary; `veyyon stats --json` prints JSON and exits.
- Programmatic API: exports helpers such as `syncAllSessions()` and `getDashboardStats()` for embedding.
- Inputs/storage: reads `~/.veyyon/profiles/default/agent/sessions/`; stores aggregates in `~/.veyyon/stats.db`.
- Outputs: dashboard metrics and API endpoints including `/api/stats`, `/api/stats/models`, `/api/stats/folders`, `/api/stats/timeseries`, and `/api/sync`.
- Side effects/limits: syncs session files before output; long-running dashboard stops on `Ctrl+C` and closes the stats database.

### `packages/evals`: model and agent evaluation

Sources: [`packages/evals/package.json`](../../packages/evals/package.json), [`packages/evals/engine/contracts.ts`](../../packages/evals/engine/contracts.ts), [`packages/evals/suites/typescript-edit/generate.ts`](../../packages/evals/suites/typescript-edit/generate.ts), [`packages/evals/suites/typescript-edit/verify.ts`](../../packages/evals/suites/typescript-edit/verify.ts), [`packages/evals/backends/in-process/client.ts`](../../packages/evals/backends/in-process/client.ts), [`packages/evals/EVALS.md`](../../packages/evals/EVALS.md).

- Package: private `@veyyon/evals`; bin: `evals`, the suite runner; `evals serve` starts the run store API and dashboard.
- Feature: one runner over five axes — eval suite, agent harness, configuration arm, prompt variant, and model — across three execution backends (`pier` for DeepSWE containers, `harbor` for Terminal-Bench 3.0, `in-process` for the TypeScript-edit suite).
- Suites: `suites/deep-swe` (SWE tasks in Pier containers), `suites/terminal-bench` (Terminal-Bench 3.0 through Harbor), `suites/typescript-edit` (in-process TypeScript source mutations).
- Modules: `engine` holds the suite, harness and backend contracts plus the variant matrix and the run engine; `store` holds the SQLite run store and experiment grouping; `api` serves the REST/SSE API; `dashboard` is the live dashboard; `tools` renders aggregates and markdown tables.
- TypeScript-edit CLI (`suites/typescript-edit/cli.ts`): `--model` and `--output` (required), `--tasks <ids>`, `--max-tasks` (default 80), `--task-concurrency` (default 32), `--runs`, `--list`.
- Fixtures: each TypeScript-edit task directory contains `prompt.md`, `input/`, `expected/` and `metadata.json`; the bundled distribution is `datasets/typescript-edit/fixtures.tar.gz`. DeepSWE task lists are `datasets/deep-swe/tasks/*.txt`; Terminal-Bench task lists are `datasets/terminal-bench/tasks/*.txt`.
- Outputs: trial directories and JSON result snapshots under `packages/evals/runs/`, plus the run rows the dashboard reads.
- Side effects/limits: extracts fixture archives, clones upstream task repositories into `datasets/repo-cache/`, vendors pinned datasets into `.cache/`, and runs Docker containers for the `pier` and `harbor` backends.

*Verified against `4aaaffd0a` on 2026-08-30.*
