# @veyyon/evals

Every model, harness and prompt evaluation in this repository.

One package holds the suites, the execution backends, the harness adapters, the run store, the
report renderers and the live dashboard. A run is a point in five axes:

|Axis|Flag|Members|
|---|---|---|
|Suite|`--suite`|`deep-swe`, `terminal-bench`, `typescript-edit`|
|Harness|`--harness`|`veyyon`, `omp`, `factory`, `hermes`|
|Config|`--config`|any overlay file, one variant per file|
|Prompt variant|`--prompts`|any prompt-override file, one variant per file|
|Model|`--model`|any model id the harness can reach|

The execution backend is a property of the suite, not a sixth axis: `deep-swe` runs through Pier,
`terminal-bench` through Harbor, `typescript-edit` in this process.

## Run something

```sh
bun run list                                    # suites, their backends and descriptions
bun run evals --list --suite terminal-bench     # the tasks of one suite
bun run evals --suite terminal-bench --model anthropic/claude-sonnet-4-6 \
	--tasks datasets/terminal-bench/tasks/smoke.txt --jobs 2
bun run evals --suite deep-swe --model google-antigravity/gemini-3.5-flash \
	--config arms/baseline.yml --config arms/candidate-unified-runtime.yml --dry-run
```

`--dry-run` prints the plan and both preflight verdicts and starts no container. `--repeats N` runs
each cell N times; results are recorded in plan order, so two runs of one plan diff cell by cell.

DeepSWE also keeps its own runner for the flags that are specific to it (arm overlays, attachment
staging, replay manifests):

```sh
bun run deepswe:smoke:dry
bun run deepswe --arms baseline,candidate-python-workspace --jobs 4
```

## Layout

```
src/
├── core/        contracts, the three registries, variant matrix, run record model
├── run/         plan.ts decides every cell; execute.ts drives them through one backend
├── suites/      deep-swe/, terminal-bench/, typescript-edit/
├── backends/    pier/, harbor/, in-process/
├── harnesses/   adapters for veyyon, omp, factory, hermes
├── manager/     SQLite run store, benchmark and experiment grouping
├── server/      REST + SSE API over the store
├── web/         React live dashboard (its own tsconfig: the only DOM-typed project here)
├── report/      benchmark and trace report renderers
├── paths.ts     the one owner of the package's directory layout
└── cli.ts       the cross-suite entrypoint
test/            every test, mirroring the src/ tree
datasets/        task lists, corpora, fixtures, dictionaries
agents/          Python container agents (pier/, harbor/)
docs/            deep-swe/, terminal-bench.md, manager.md
runs/            trial output, gitignored
.cache/          vendored datasets, gitignored
```

A suite, backend or harness exists because an index module registers it. Nothing scans the
filesystem: `src/suites/index.ts`, `src/backends/index.ts` and `src/harnesses/index.ts` are the
complete list, and a member missing from them is invisible to the CLI, the store and the dashboard.

## Adding a suite

1. Implement `EvalSuite` (`src/core/types.ts`): `discoverTasks`, `describeTask`, `provenance`,
   `scoreTrial`, `preflight`, and the `backend` it needs.
2. Export `<name>Suite` from `src/suites/<name>/suite.ts` and `register<Name>Suite(registry?)` from
   `src/suites/<name>/register.ts`. A suite directory carries no barrel: three suites collide on
   names like `TaskMetadata`, so every importer names the module it wants.
3. Add it to `builtinSuites` in `src/suites/index.ts`.
4. Commit a task list under `datasets/<name>/tasks/` with a provenance header.

The run engine supplies the rest: the cell matrix, the bounded worker pool, the error mapping (a
thrown trial records `reward: null` with the error text, never a zero), cleanup, and the summary.

## Manager and dashboard

```sh
bun run serve            # REST + SSE over the run store, dashboard at /
```

The store is `assets/evals.sqlite`, schema v2: every row carries the suite and backend identity, so
rows from two suites cannot be aggregated into one pass rate. `docs/manager.md` covers the API.

## Gates

```sh
bun run check:types      # both projects: the package, then src/web
bash ../../scripts/test-sandbox/run.sh bun test packages/evals   # from the repo root
bun run test:py          # Python container agents
```
