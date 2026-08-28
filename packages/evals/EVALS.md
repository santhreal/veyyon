# Evals Reference

`@veyyon/evals` runs evaluations, offline benchmarks, and telemetry measurements across models, harness adapters, and execution backends in this repository. It contains evaluation suites, harness adapters for agent CLIs, execution backends for containerized and in-process isolation, offline benchmarks, transcript analysis tools, a run store, a REST and Server-Sent Events API server, and a web dashboard.

## Entrypoint and Flag Grammar

The primary CLI entrypoint is `bun evals.ts`, mapped to the binary name `evals`.

### Operational Modes

- `evals --list`: Prints the loaded suites, backends, and harnesses.
- `evals --list --suite <ids>`: Lists discovered task identifiers for each named suite.
- `evals --suite <ids> --model <ids>`: Executes evaluation suites across the selected axes.
- `evals --resume --run-id <id>`: Resumes an interrupted run from its journal.
- `evals --dry-run`: Validates preflight requirements, parses paths and axes, prints the execution plan, and exits without executing trials.
- `evals bench`: Lists the benches. `evals bench <id> [args...]` runs one, forwarding the remaining arguments to it.
- `evals measure`: Lists the measurements. `evals measure <id> [args...]` runs one, forwarding the remaining arguments to it.
- `evals tool`: Lists the tools. `evals tool <id> [args...]` runs one, forwarding the remaining arguments to it.
- `evals serve`: Starts the manager server (REST + SSE API, dashboard, run launcher) on port 4700.

### Flag Grammar

`bench`, `measure`, `tool`, and `serve` are the only positional arguments the entrypoint reads, and each must come first. Every other input is named by a flag starting with `--`. Any other positional argument is a usage error. Flags accept `--flag value` and `--flag=value` syntax.

Boolean flags take no value; passing a value causes an error:
- `--dry-run`: Print the run plan and preflight checks without executing trials.
- `--list`: List registered members or suite task identifiers.
- `--resume`: Resume an existing run from its journal file.
- `--help`: Print CLI usage instructions.

Value flags require a non-empty string argument:
- `--suite <name,name>`: Evaluation suite identifiers. Required to run trials.
- `--harness <a,b>`: Harness adapter identifiers. Defaults to `veyyon`.
- `--config <path,path>`: Configuration overlay file paths. Each path defines one variant.
- `--prompts <path,path>`: Prompt overlay file paths. Each path defines one variant.
- `--model <id,id>`: Target model identifiers. Required to run trials.
- `--tasks <ids|path>`: Comma-separated task identifiers, or a task-list file (`.txt`, `.jsonl`, `.list`, `.tasks`, or containing a path separator). Prefix an entry with `<suite>=` to scope it to one suite.
- `--limit <n>`: Run only the first n selected tasks (integer, n >= 1). Applied after selection, so a dropped task is never described.
- `--repeats <n>`: Trial repetitions per matrix cell (integer, n >= 1, default 1).
- `--attempts <n>`: Maximum attempts per trial on unhandled execution failures (integer, 1 to 5, default 2).
- `--jobs <n>`: Concurrent trials in flight (integer, n >= 1, default 1).
- `--runs-dir <path>`: Output directory for run artifacts and journals (default `packages/evals/runs`).
- `--work-dir <path>`: Working directory passed to the execution backend (default current working directory).
- `--dataset-dir <path>`: Path overriding a suite dataset directory (single-suite runs only).
- `--run-id <name>`: Identifier for the run directory and journal. It must be a single path segment.
- `--trial-timeout <sec>`: Seconds overriding each task time budget (integer, at least 1).
- `--agent-timeout <sec>`: Seconds bounding agent execution alone (integer, at least 1).
- `--timeout-multiplier <x>`: Positive multiplier scaling whichever budget applies.

Harness-declared flags:
Harness adapters declare additional flags via `HarnessAdapter.flags`. The entrypoint accepts these flags as `--<flag> <value>` and passes them to the matching adapter options bag. Examples include `--auth-db <path>`, `--vey-binary <path>`, `--omp-binary <path>`, `--factory-binary <path>`, and `--factory-auth <key>`.

Package scripts in `package.json`:
- `bun run evals`: Runs `bun evals.ts`.
- `bun run list`: Runs `bun evals.ts --list`.
- `bun run bench`: Runs `bun evals.ts bench`.
- `bun run measure`: Runs `bun evals.ts measure`.
- `bun run serve`: Runs `bun evals.ts serve` on port 4700.
- `bun run dev`: Runs `bun --hot evals.ts serve`.
- `bun run tool`: Runs `bun evals.ts tool`.
- `bun run test`: Runs unit test suites via Bun test runner.
- `bun run test:py`: Runs Python container agent test suites via unittest.

## Member Kinds

The member kinds declared in `engine/member-discovery.ts` are:

| Kind | Directory | Noun | Shape |
|---|---|---|---|
| `suite` | `suites` | `suite` | `descriptor` |
| `harness` | `harnesses` | `harness` | `descriptor` |
| `backend` | `backends` | `backend` | `descriptor` |
| `bench` | `benches` | `bench` | `program` |
| `measurement` | `measurements` | `measurement` | `program` |
| `tool` | `tools` | `tool` | `program` |

Naming rules:
- Single-file members live at `<dir>/<id>.ts`. Multi-file members live at `<dir>/<id>/main.ts`.
- A leading underscore (`_`) marks a shared helper file or directory that is excluded from discovery.
- Descriptor members default-export their descriptor object. The descriptor `id` property must match the file or directory name.
- Program members execute for side effects and output reports; they have no default export.
- Autoscan discovers all members at import time. Adding a member requires no registration function call, registry edit, or barrel re-export.

## Adding a Member

### Adding a Suite

1. Create `suites/<id>.ts` (or `suites/<id>/main.ts`) default-exporting an object that implements `EvalSuite`. Set `id` to `<id>`, specify `version`, `displayName`, `description`, and `backend`, and implement `discoverTasks`, `describeTask`, `provenance`, `scoreTrial`, and `preflight`.
2. Run `bun evals.ts --suite <id> --model <model-id> --dry-run`.

### Adding a Harness

1. Create `harnesses/<id>.ts` (or `harnesses/<id>/main.ts`) default-exporting an object that implements `HarnessAdapter`. Set `id` to `<id>`, specify `displayName`, `description`, `defaultModel`, `capabilities`, `flags`, and `backends`, and implement `preflight` and `stageAssets`.
2. Run `bun evals.ts --suite <suite-id> --harness <id> --model <model-id> --dry-run`.

### Adding a Backend

1. Create `backends/<id>.ts` (or `backends/<id>/main.ts`) default-exporting an object that implements `ExecutionBackend`. Set `id` to `<id>`, and implement `preflight`, `prepare`, `runTrial`, and `cleanup`.
2. Run `bun evals.ts --suite <suite-id> --model <model-id> --dry-run`.

### Adding a Bench

1. Create `benches/<id>.ts`, or `benches/<id>/main.ts` when it needs more than one file, as a script that runs its workload under `import.meta.main`. A bench is a program member: it has no default export.
2. Run `bun evals.ts bench <id>`.

### Adding a Measurement

1. Create `measurements/<id>.ts`, or `measurements/<id>/main.ts` when it needs more than one file, as a script that runs its workload under `import.meta.main`. A measurement is a program member: it has no default export.
2. Run `bun evals.ts measure <id>`.

### Adding a Tool

1. Create `tools/<id>.ts`, or `tools/<id>/main.ts` when it needs more than one file, as a script that runs its workload under `import.meta.main`. A tool is a program member: it has no default export.
2. Run `bun evals.ts tool <id>`.

## Arms

Arms are cross-suite configuration overlays in `arms/`. Each arm modifies a single variable relative to default configuration, isolating the cause of performance deltas.

An arm is selected as `--config arms/<name>.yml`. Each `--config` path is one variant, so `--config arms/a.yml,arms/b.yml` runs both arms over the same task and model matrix.

Arm files and companion overlays:
- `<name>.yml`: Configuration settings overlay modifying feature flags and runtime settings (e.g. `argot.enabled`, `defaultEffort`, context thresholds).
- `<name>.sections.yml`: System prompt section body text overrides. Keys map to recognized section identifiers: `conventions`, `role`, `runtime`, `toolPolicy`, `executionWorkflow`, `deliveryContract`.
- `<name>.statements.yml`: System prompt statement overrides or ablations. Keys map to statement identifiers. Setting a value to `null` ablates the statement; setting a string replaces its text.
- `<name>.prompts.yml`: Prompt registry overrides for tool descriptions, subagent prompts, or agent directives.
- `<name>.rule.md`: Behavioral rule file mounted into agent context.

The arm digest covers all associated files (`.yml`, `.sections.yml`, `.statements.yml`, `.prompts.yml`, `.rule.md`). Two arms sharing identical YAML settings but differing companion files are distinct and do not collide.

## Run Output

Finished runs write structured output under `<runs-dir>/<run-id>/`:

```
runs/<timestamp>/
├── report.md          # Markdown report with statistics and comparison tables
├── results.json       # Array of TrialResultRecord objects
├── trials.jsonl       # Append-only journal of settled trials
├── assets/            # Staged binaries, auth databases, and arm configurations
├── configs/           # Per-trial container job configurations (<variant>__<task>__r<n>.yaml)
└── jobs/              # Per-trial execution artifacts (<variant>__<task>__r<n>/)
```

Top-level files:
- `report.md`: Markdown summary report containing per-arm totals, pass rates with Wilson 95% confidence intervals, cost tables, per-task breakdowns, and paired sign test comparisons.
- `results.json`: JSON array of `TrialResultRecord` objects.
- `trials.jsonl`: Append-only execution journal recording `RUN_JOURNAL_KIND`, `RUN_JOURNAL_VERSION`, the plan digest, and settled trial records.
- `assets/`: Staged binaries (`vey`, `bun`), SQLite credential stores (`auth-agent.db`), resolved arm configuration files, attachment manifests, and staged container programs (`programs/<harness>/<arm>/`).
- `configs/`: Per-trial container job configuration files named `<variant>__<task>__r<repeat>.yaml`.
- `jobs/`: Per-trial execution directories named `<variant>__<task>__r<repeat>/` containing `config.json`, `result.json`, `job.log`, `lock.json`, and `<task>__<id>/` subdirectories with `trial.log`, `agent/` outputs, `verifier/` scores (`reward.json`, `ctrf.json`, `test-stdout.txt`), `artifacts/` (`model.patch`), and `egress-proxy/` logs.

Run record data model (`engine/run-record.ts`):
- `EvalRunRecord`: Represents a completed or settled suite run. Contains `id`, `suite` (`name`, `version`, `provenanceSha`), `variants`, `tasks`, `repeats`, `results`, `createdAt`, optional `completedAt`, `provenance`, and `metadata`.
- `TrialResultRecord`: Represents one settled trial execution. Contains `cell` (`task`, `variant`, `repeat`), `score` (`reward`, optional `partial`, optional `error`, `extra`), optional `artifacts` (`trialDir`, `logPaths`, `filePaths`, `rawOutput`, `usage`, `extra`), `startedAt`, `finishedAt`, and `durationMs`.
- `TrialUsage`: Token and monetary usage metrics. Contains `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalCostUsd`, and `durationMs`. Unmeasured fields are `null`, never `0`.
- `CellSummary`: Summarizes grouped trial outcomes for a variant. Contains `variant`, `totalTrials`, `settledTrials`, `passedTrials`, `failedTrials`, `erroredTrials`, `passRate`, `meanReward`, `meanDurationMs`, `meanInputTokens`, `meanOutputTokens`, `totalCostUsd`.
- `RunVerdict`: Assessment of run completion status, returning exit code 0 or 1 based on settled trials, measured grades, and infrastructure errors.

## Datasets and Agents

Directories holding task fixtures, agent container runtimes, and execution outputs:
- `datasets/`: Task definitions, task lists, corpora, fixture archives, and static dictionaries. Contains `datasets/deep-swe/tasks/` and `datasets/terminal-bench/tasks/` with task lists carrying `@headline` and `@biased` provenance directives; `datasets/typescript-edit/fixtures.tar.gz` holding the synthetic mutation corpus; and `datasets/dicts/*.AGENTS.dict` holding repository vocabulary dictionaries.
- `agents/`: Container agent implementations in Python and shared execution helpers.
  - `agents/pier/`: Pier backend container agents (`VeyyonAgent`, `OmpAgent`, `FactoryAgent`, `HermesAgent`).
  - `agents/harbor/`: Harbor backend container agents (`VeyyonAgent`, `ProgramAgent`).
  - `agents/common/`: Shared container program executor (`container_program.py`), session token usage readers (`session_usage.py`), model catalog bootstrap helper (`model_catalog_bootstrap.py`), and arm attachment loader (`arm_attachments.py`).
- `assets/`: Ephemeral staging root for binary assets, credentials, and container programs created during evaluation runs.
- `runs/`: Output directory where finished evaluation runs, trial artifacts, execution journals, reports, and SQLite manager databases (`_manager/evals.sqlite`) are stored.

## Measurements

Measurement programs in `packages/evals/measurements/`:
- `measurements/prefix-composition.ts`: Reports prompt category token decomposition, cache hit rates, prefix mass distribution, and simulated cache invalidation cost impact from session transcripts.
- `measurements/online-codec-ceiling.ts`: Reports theoretical and empirical token and cost savings achievable by an append-only online dictionary codec without prefix cache invalidation.
- `measurements/retype-likelihood.ts`: Reports the empirical emission frequency of dictionary candidate strings in actual agent transcripts compared to corpus document frequency predictions.
