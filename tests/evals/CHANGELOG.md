# Changelog

All notable changes to `@veyyon/evals` will be documented in this file.

## [Unreleased]

### Added

- `suites/browser` runs hard web tasks on seeded local applications (a shop, webmail, a bank with a second-factor phone, a kanban board, a spreadsheet, flight booking with a cross-origin payment frame, a helpdesk seeded with prompt injections, an analytics dashboard drawn on canvas), five workflow tasks that carry one job across two or three of them, and four recovery tasks in which the application fails once, visibly (a declined charge, an expired session, a stale save, a dropped connection), and grades each by the state the applications recorded and the agent's answer.
- `suites/miniwob` runs MiniWoB++ pages as a suite on the local-cli backend.
- The `local-cli` backend runs each trial as one print-mode CLI run on this host, in a scratch directory under `/tmp/vey-<uid>` (mode 0700, refused when another user owns it or it is a link), with an empty home, a credential store pruned to the model provider's sign-in once per run and refreshed in the runner's store before a trial would outlive its access token, and an allowlisted environment; on Linux a Landlock sandbox hides the graders, the runs directory, other trials, the git history of the checkout and the build, every user's home, the system temp directories and mounted media, and a launcher ends every process the agent started, a detached Chrome included, when the agent exits; `--unsandboxed` runs it on a host without Landlock.
- `--build name=path,...` runs one variant per build of the agent, a source tree or an executable, so two builds compare trial by trial in one plan; preflight refuses a tree without the CLI or a file that is not executable, and a resume under another build is refused.
- `engine/kit` defines a benchmark as a catalog of seeded tasks, each starting its own services and graded by named checks over recorded state; every task carries a scripted solution that the suite's sweep runs. `answerHasText` matches whole terms, `answerHasNumber` ignores digits inside identifiers and reads a leading minus, and `answerNamesOnly` and `answerStatesOnly` fail an answer that names or states a decoy beside the right value.
- A kit suite's run writes `report.md` and `summary.json` with pass rates and Wilson intervals, capability and difficulty breakdowns, passes within the turn, token and time budgets the suite declares, and a sign test of every arm against the plan's first.
- `evals tool kit-report --run <dir> [--regrade]` renders a kit suite's report for a finished run and grades it again from the trial files, finding them under the run directory when the run was moved.
- `tests/evals/docs/` is the evals manual, replacing `EVALS.md`.
- `benches/browser-fill.ts` times `tab.fill` in headless Chromium for 16, 256 and 4,096 characters and counts a fill correct only when the field holds the value.
- `benches/natural-input.ts` times `tab.click`, `tab.type` and `tab.fill` with `browser.naturalInput` off and on, and `benches/bot-detection.ts` opens public bot-detector pages through the browser tool and prints each verdict and the signals it flags.

### Changed

- `engine/` is grouped by concern into `members`, `plan`, `run`, `trial`, `kit`, `compare`, `harness`, `auth`, `io`, `wire` and `corpus`, and the overlay loaders and paired statistics every suite shares moved into it from the in-process backend and the DeepSWE suite.

### Fixed

- A trial cut short by a cancelled run gets no journal row, so `--resume` runs it again, and the retry backoff ends when the run is cancelled.
- A trial whose agent exited before any provider request succeeded is retried as infrastructure whatever its stderr says, and a failed request no longer counts as a turn.
- A journal whose last line was cut off by a killed process is repaired before the next append instead of becoming unreadable.
- A descendant in a trial's process group that ignores SIGTERM is killed once the trial's process exits.
- The resume command printed after SIGINT or SIGTERM restates every flag of the interrupted run.
- A plan whose variant names reduce to one directory name is refused, naming both variants.

## [1.5.0] - 2026-09-18

### Fixed

- `codingAgentDir()` resolves `packages/coding-agent` from the repository root, so the binary staleness preflight scans the coding agent's sources again after the package moved to `tests/evals`; it had resolved a sibling directory that does not exist and reported every binary current.

## [1.3.0] - 2026-08-28

### Added

- `@veyyon/evals` is the single package holding every evaluation in this repository, replacing `@veyyon/deepswe-bench`, `@veyyon/metaharness` and `@veyyon/typescript-edit-benchmark`.
- `evals --suite <name,name>` runs any number of suites in one invocation across five axes (suite × harness × config × prompt variant × model), with `--tasks`, `--repeats`, `--jobs`, `--dry-run` and `--list`. Each suite produces its own run record, a `--tasks` entry is scoped to one suite by a `<suite>=` prefix, and `--dataset-dir` is refused when the run names more than one suite.
- `engine/run-plan.ts` decides every trial cell before anything executes, task-major with variants innermost, and refuses an empty selection, an unknown task id or a non-integer repeat count.
- `engine/execute-run.ts` drives a plan through one execution backend with a bounded worker pool, records results in plan order rather than completion order, and runs cleanup for a cell whose trial threw.
- A trial that throws records `reward: null` with the error text, so a broken container is no longer indistinguishable from an agent that scored zero.
- Terminal-Bench 3.0 is an eval suite: `suites/terminal-bench/` with the dataset pinned at tag `v3.0.0` (`2b0442c3c583b710ca8da14c8e601b99f2f1f244`, 74 tasks), Harbor task-config parsing, provenance, and the committed `smoke.txt` and `pilot.txt` task lists.
- `engine/` holds the shared contracts (`EvalSuite`, `HarnessAdapter`, `ExecutionBackend`), the three registries, the variant matrix with deterministic variant naming and collision detection, and the suite-tagged run record model.
- Pier, Harbor and in-process are registered execution backends: `pierBackend`, `harborBackend`, `inProcessBackend`, each with a preflight verdict naming what is missing.
- The harness adapters (veyyon, omp, factory, hermes) are shared across suites at `harnesses/`, registered by `the autoscan loader`.
- `agents/harbor/veyyon_agent.py` runs the veyyon harness inside a Harbor container.
- Folded the TypeScript-edit mutation, verification, and benchmark suite into `suites/typescript-edit/`.
- Added in-process `AgentSession` execution client at `backends/in-process/client.ts`.
- Moved TypeScript-edit benchmark fixtures and datasets to `datasets/typescript-edit/`.
- Moved the Harbor execution backend to `backends/harbor/` and local Harbor agent to `agents/harbor/veyyon_local.py`.
- Moved the SQLite run store, experiment grouping layer, and REST/SSE manager server into `store/` and `api/`.
- Moved the React live evaluation dashboard into `dashboard/`.
- Moved benchmark and trace reporting tools into `tools/`.
- Harness adapters declare their supported execution backends in their backend map, refusing planning for unbound backend pairs and supporting multi-harness trial matrix generation.
- The in-process backend loads a config overlay and a prompt-variant overlay per trial, applying settings to the agent session and the prompt text through `VEYYON_EVAL_PROMPTS`, and refuses a missing file, an unknown setting key or a prompt id no registry holds before any trial starts.
- The omp harness stages an OAuth credential store (`auth-agent.db`) into the container when no API key is resolved, copying it to `~/.omp/agent/agent.db` in the setup step. Preflight accepts the auth DB as an alternative to `--omp-api-key` or `$PROVIDER_API_KEY`, probing it can serve the run's model.

### Changed

- Parameterized the Harbor backend default dataset and upgraded the run store schema to version 2 with explicit suite and backend identities, so rows from two suites cannot be aggregated into one pass rate.
- The run store is `assets/evals.sqlite`, and the manager server, dashboard and report renderers are named for the evals package rather than the retired metaharness.
- The DeepSWE runner keeps its suite-specific flags at `suites/deep-swe/main.ts`; its harness registry, Pier execution and reporting are now the shared ones.
- `bench:gen-fixtures` generates TypeScript-edit fixtures from `datasets/typescript-edit/typescript-source` instead of a path under `/tmp`.
- The React dashboard is its own TypeScript project (`dashboard/tsconfig.json`), the only DOM-typed project in the package, so the rest of the package typechecks against the harness's own DOM shims.
- Every test lives under `test/`, mirroring the package tree, and `bunfig.toml` `pathIgnorePatterns` keeps test discovery out of the gitignored data trees (`runs/`, `datasets/repo-cache/`, `datasets/deep-swe/corpus/`, `.cache/`).
- `engine/package-paths.ts` is the single owner of the package's directory layout, replacing the DeepSWE-scoped `paths.ts` and the manager's second copy.
- The search benches write their scratch corpora to the repository's `.internal/` directory instead of creating a stray `packages/.internal/`.
- Record and config parsing calls `isRecord` and `errorMessage` from `@veyyon/utils` instead of eight local copies.
- Zero barrel files (`export * from`) remain in the package. Every importer reaches the source module directly, so adding a member requires writing exactly one file with no index or barrel edit.
- `tsconfig.json` includes the package root and excludes `dashboard/` instead of the removed `src/` tree. `.gitignore` and `scripts/local-endpoint-bridge.sh` no longer reference `src/`.

### Fixed

- DeepSWE dry-run preflight reports missing or stale binary artifacts with their build command instead of triggering a product build.
- `--dry-run` refuses an overlay the real run would refuse: the backend's preflight now receives the plan's variants, so a missing overlay file, an unknown setting key or a prompt id no registry holds is reported before any quota is spent instead of hours into the run.
- `Handlebars.compile` in `suites/typescript-edit/argot-bench.ts` and `generate.ts` receives the prompt text (`.text`) instead of the `PromptEntry` object, fixing an import-time crash.
- The entry-point flag-refusal sweep scans the package root instead of the removed `src/` directory, and the one-flag-grammar test no longer references the retired deep-swe runner entry point.
- The Harbor backend skips source-tree mount preparation when `VEYYON_BENCH_BINARY_X64` or `VEYYON_BENCH_BINARY_ARM64` is set, so a pinned-binary run does not fail on a compose overlay the binary mode never uses.
- The Harbor compose overlay targets the `main` service that harbor's build template defines, not a non-existent `task` service, so `docker compose build` no longer fails with "service has neither an image nor a build context".
- The Harbor backend passes `--agent` instead of the deprecated `--agent-import-path`, so harbor 0.22.0 no longer rejects the invocation.
- The omp harness routes OAuth providers through the auth gateway: `buildModelsYml` uses the gateway URL with `/v1` appended as the provider base URL, `openai-responses` as the API, and `no-auth` as the API key when no key is resolved.
- The omp harness parses `vey models refresh --json` output as a single `{"models":[...]}` JSON object instead of NDJSON lines, so `models.yml` is staged for providers that return the object format.
- The omp harness stages the host's `bun` binary alongside the omp binary and invokes omp through it, so a task container with an older Bun runtime does not crash the omp bundle.
- The omp harness mounts the host's `~/node_modules` into the container at `/opt/omp-assets/node_modules`, so the omp binary can resolve its external dependencies (`@oh-my-pi/pi-natives`, `turndown`, etc.).
- The omp harbor binding declares `authGateway: true`, so the compose overlay includes `extra_hosts: host.docker.internal:host-gateway` for omp runs.
- The Harbor compose overlay supports `cfg.extraVolumes` for harness-specific bind mounts in addition to source-tree mounts.
- The Harbor backend strips `VEYYON_AUTH_BROKER_URL` and `VEYYON_AUTH_BROKER_TOKEN` from the subprocess environment and the forward-env denylist, so the host's loopback broker address does not leak into containers that can only reach the gateway at `host.docker.internal:4000`.
- The omp harness uses the gateway bearer token as the `apiKey` in `models.yml` when routing through the gateway, so omp sends an authorized request instead of `no-auth` and getting 401.
- The Harbor backend passes `gatewayToken` through to the harness staging options, so a harness with a `containerProgram` (omp) receives the gateway token alongside the gateway URL.
