# Changelog

All notable changes to `@veyyon/evals` will be documented in this file.

## [Unreleased]

### Added

- `@veyyon/evals` is the single package holding every evaluation in this repository, replacing `@veyyon/deepswe-bench`, `@veyyon/metaharness` and `@veyyon/typescript-edit-benchmark`.
- `evals --suite <name,name>` runs any number of suites in one invocation across five axes (suite × harness × config × prompt variant × model), with `--tasks`, `--repeats`, `--jobs`, `--dry-run` and `--list`. Each suite produces its own run record, a `--tasks` entry is scoped to one suite by a `<suite>=` prefix, and `--dataset-dir` is refused when the run names more than one suite.
- `src/run/plan.ts` decides every trial cell before anything executes, task-major with variants innermost, and refuses an empty selection, an unknown task id or a non-integer repeat count.
- `src/run/execute.ts` drives a plan through one execution backend with a bounded worker pool, records results in plan order rather than completion order, and runs cleanup for a cell whose trial threw.
- A trial that throws records `reward: null` with the error text, so a broken container is no longer indistinguishable from an agent that scored zero.
- Terminal-Bench 3.0 is an eval suite: `src/suites/terminal-bench/` with the dataset pinned at tag `v3.0.0` (`2b0442c3c583b710ca8da14c8e601b99f2f1f244`, 74 tasks), Harbor task-config parsing, provenance, and the committed `smoke.txt` and `pilot.txt` task lists.
- `src/core/` holds the shared contracts (`EvalSuite`, `HarnessAdapter`, `ExecutionBackend`), the three registries, the variant matrix with deterministic variant naming and collision detection, and the suite-tagged run record model.
- Pier, Harbor and in-process are registered execution backends: `pierBackend`, `harborBackend`, `inProcessBackend`, each with a preflight verdict naming what is missing.
- The harness adapters (veyyon, omp, factory, hermes) are shared across suites at `src/harnesses/`, registered by `registerBuiltinHarnesses()`.
- `agents/harbor/veyyon_agent.py` runs the veyyon harness inside a Harbor container.
- Folded the TypeScript-edit mutation, verification, and benchmark suite into `src/suites/typescript-edit/`.
- Added in-process `AgentSession` execution client at `src/backends/in-process/client.ts`.
- Moved TypeScript-edit benchmark fixtures and datasets to `datasets/typescript-edit/`.
- Moved the Harbor execution backend to `src/backends/harbor/` and local Harbor agent to `agents/harbor/veyyon_local.py`.
- Moved the SQLite run store, experiment grouping layer, and REST/SSE manager server into `src/manager/` and `src/server/`.
- Moved the React live evaluation dashboard into `src/web/`.
- Moved benchmark and trace reporting tools into `src/report/`.
- Harness adapters declare their supported execution backends in their backend map, refusing planning for unbound backend pairs and supporting multi-harness trial matrix generation.
- The in-process backend loads a config overlay and a prompt-variant overlay per trial, applying settings to the agent session and the prompt text through `VEYYON_EVAL_PROMPTS`, and refuses a missing file, an unknown setting key or a prompt id no registry holds before any trial starts.

### Changed

- Parameterized the Harbor backend default dataset and upgraded the run store schema to version 2 with explicit suite and backend identities, so rows from two suites cannot be aggregated into one pass rate.
- The run store is `assets/evals.sqlite`, and the manager server, dashboard and report renderers are named for the evals package rather than the retired metaharness.
- The DeepSWE runner keeps its suite-specific flags at `src/suites/deep-swe/run.ts`; its harness registry, Pier execution and reporting are now the shared ones.
- `bench:gen-fixtures` generates TypeScript-edit fixtures from `datasets/typescript-edit/typescript-source` instead of a path under `/tmp`.
- The React dashboard is its own TypeScript project (`src/web/tsconfig.json`), the only DOM-typed project in the package, so the rest of the package typechecks against the harness's own DOM shims.
- Every test lives under `test/`, mirroring the `src/` tree, and `bunfig.toml` `pathIgnorePatterns` keeps test discovery out of the gitignored data trees (`runs/`, `datasets/repo-cache/`, `datasets/deep-swe/corpus/`, `.cache/`).
- `src/paths.ts` is the single owner of the package's directory layout, replacing the DeepSWE-scoped `paths.ts` and the manager's second copy.
- The search benches write their scratch corpora to the repository's `.internal/` directory instead of creating a stray `packages/.internal/`.
- Record and config parsing calls `isRecord` and `errorMessage` from `@veyyon/utils` instead of eight local copies.

### Fixed

- DeepSWE dry-run preflight reports missing or stale binary artifacts with their build command instead of triggering a product build.
- `--dry-run` refuses an overlay the real run would refuse: the backend's preflight now receives the plan's variants, so a missing overlay file, an unknown setting key or a prompt id no registry holds is reported before any quota is spent instead of hours into the run.
