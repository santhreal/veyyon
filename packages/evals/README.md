# @veyyon/evals

Every model, harness and prompt evaluation in this repository.

One package holds the suites, the execution backends, the harness adapters, the run store, the
report renderers and the live dashboard. A run is a point in five axes:

|Axis|Flag|Members|
|---|---|---|
|Suite|`--suite`|`deep-swe`, `terminal-bench`, `typescript-edit`; a list runs each of them|
|Harness|`--harness`|`veyyon`, `omp`, `factory`, `hermes`|
|Config|`--config`|any overlay file, one variant per file|
|Prompt variant|`--prompts`|any prompt-override file, one variant per file|
|Model|`--model`|any model id the harness can reach|

The execution backend is a property of the suite, not a sixth axis: `deep-swe` runs through Pier,
`terminal-bench` through Harbor, `typescript-edit` in this process.

## Run something

```sh
bun run list                                    # every registered suite, backend and harness
bun run evals --list --suite terminal-bench     # the tasks of one suite
bun run evals --suite terminal-bench --model anthropic/claude-sonnet-4-6 \
	--tasks datasets/terminal-bench/tasks/smoke.txt --jobs 2
bun run evals --suite terminal-bench,typescript-edit --model anthropic/claude-sonnet-4-6 \
	--tasks terminal-bench=datasets/terminal-bench/tasks/smoke.txt
bun run evals --suite deep-swe --model google-antigravity/gemini-3.5-flash \
	--config arms/baseline.yml --config arms/candidate-unified-runtime.yml --dry-run
```

`--dry-run` prints the plan and every preflight verdict — paths, axes, suite, harness, backend, and
`resume` when `--resume` is passed — and starts no container, and builds nothing: a missing or stale
artifact is reported with the command that produces it. `--repeats N` runs each cell N times; results
are recorded in plan order, so two runs of one plan diff cell by cell.

The `paths` verdict covers the three directories a run reaches: `--runs-dir`, which is created when
absent and must not be a regular file or an unwritable directory, `--work-dir`, which must already
exist, and `--dataset-dir`, which must exist as a directory or, for `typescript-edit`, as a `.tar` or
`.tar.gz` archive. Each is checked before the plan is built, so a mistyped directory costs a second
rather than a preflight that passes and a run that dies at its first write. A `--tasks` value holding
a path separator or a `.txt`, `.jsonl`, `.list` or `.tasks` extension names a file: when it cannot be
read the refusal names the path, instead of reading it as one unknown task id.

The `axes` verdict covers the axes a variant carries beyond the harness and the model: `--config`,
`--prompts`, and arm attachments. A backend states which of the three it reads and a harness states
whether it applies prompt overrides and arm attachments, and an axis this run varies that neither
applies is rejected by name. Harbor reads none of the three, so `--prompts a.json,b.json` against a
harbor suite is rejected instead of expanding the matrix, naming the cells apart and running the
same trial twice under two arm names.

`--resume` continues the run named by `--run-id` from its `trials.jsonl` journal, skipping every
trial that already settled. A run id with no journal is rejected rather than started, so a typo
cannot bill a fresh run of every task under a name that looked half finished.

A run id names one plan. The journal header records a digest of the suite version, dataset sha,
backend, and every variant's harness, overlay paths, model and attachments, and an invocation that
plans anything else under that run id is rejected — with or without `--resume`. A settled trial is
matched by suite, task, variant name and repeat, and a variant name carries the model only when a
run varies more than one, so without the digest `--resume --model b` skipped the trials run against
model a and reported them as b's. Narrowing `--tasks` or raising `--repeats` is the same plan
reaching fewer or more cells, and resumes.

A `--suite` list runs each suite in turn and writes one run record per suite, because a record is
suite-tagged and two suites' trials are never comparable. A `--tasks` entry carrying a `<suite>=`
prefix belongs to that suite alone; an unprefixed entry applies to every suite. `--dataset-dir` can
only mean one suite's dataset, so a multi-suite run rejects it. The exit code is the worst any suite
earned, and a failed preflight in one suite does not stop the ones after it.

A `--config` file is a settings overlay: its keys are settings paths, and an unknown key is rejected
by name before the first trial. A `--prompts` file maps a prompt id to the text that replaces it,
carried to the agent by `VEYYON_EVAL_PROMPTS`; an id no registry holds is rejected with the nearest
real ids, so a typo costs a second rather than a container. Each harness declares which backends it
runs on, and a suite whose backend a harness is not bound to is rejected during planning instead of
at the first trial.

One module decides how long a trial gets: `src/core/trial-deadline.ts`. A task's own
`timeBudgetSec` applies, or 1800 seconds when it states none; `--trial-timeout` replaces that
budget and `--timeout-multiplier` scales it. A scaled or defaulted budget stops at 3600 seconds,
a budget the task states for itself is honored up to 86400, and no deadline is shorter than one
second, so `--timeout-multiplier 0.0001` shortens a trial rather than failing it before it
starts. A trial's raw output keeps its last 65536 bytes, counted in bytes so multi-byte output is
bounded by what the journal writes.

DeepSWE also keeps its own runner for the flags that are specific to it (arm overlays, attachment
staging, replay manifests):

```sh
bun run deepswe:smoke:dry
bun run deepswe --arms baseline,candidate-python-workspace --jobs 4
```

## Offline benches

`src/benches/` holds measurements that need no provider and no container. They build their own
corpus, run production code paths against it, and exit non-zero when a claim stops holding.

```sh
bun run bench:search              # unified search: arm agreement, declared answers, dispatch cost
bun run bench:search --list       # the registered corpora, case suites and arms
bun run bench:search:disclosure   # inline bytes a broad search costs on later turns
```

The search bench is extended by registration, not by editing the runner. Three axes are registered
in `src/benches/search/registry.ts`: a **corpus** (a file tree the bench materializes), a **case
suite** (cases over one named corpus, each declaring the answer that corpus has), and an **arm** (a
way to reach the search engines). `--suite`, `--arms` and `--reference` select which registered
members a run measures; with none given it measures every registered case suite through every
registered arm. A lookup for an unregistered id fails and prints the ids that exist.

A run answers two separate questions. **Arm agreement** compares every arm's bytes against the
reference arm (`unified-tool` by default), which catches a wrapper that diverges from the engine it
dispatches to. That comparison is satisfied by construction for the shipped arms, so each case also
declares the answer the corpus has for it: the files it must find, the files it must not, and a
count where a cap or pagination determines the set. An engine regression that moves every arm together
— a glob that stops recursing, a gitignore rule read the wrong way round, a structural pattern that
matches no node — fails the declared answer while agreement still passes. `expect` is required on
every case, so a new case cannot be added without one.

## Layout

```
src/
├── core/        contracts, the three registries, variant matrix, run record model, flag grammar
├── run/         plan.ts computes every cell; execute.ts drives them through one backend
├── suites/      deep-swe/, terminal-bench/, typescript-edit/
├── backends/    pier/, harbor/, in-process/
├── benches/     offline micro-benchmarks that consume no provider quota: search/
├── harnesses/   adapters for veyyon, omp, factory, hermes
├── manager/     SQLite run store, benchmark and experiment grouping
├── server/      REST + SSE API over the store
├── web/         React live dashboard (its own tsconfig: the only DOM-typed project here)
├── report/      benchmark and trace report renderers
├── paths.ts     the one owner of the package's directory layout
└── cli.ts       the cross-suite entrypoint
test/            every test, in the directory of the code it drives, named for the behavior it defends
datasets/        task lists, corpora, fixtures, dictionaries
agents/          Python container agents (pier/, harbor/)
docs/            per-suite and per-layer reference (see docs/ below)
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
   `src/suites/<name>/register.ts`. A suite directory carries no barrel: three suites declare types
   with colliding names such as `TaskMetadata`, so every import states its module path.
3. Add it to `builtinSuites` in `src/suites/index.ts`.
4. Commit a task list under `datasets/<name>/tasks/` with a provenance header.

The run engine supplies the rest: the cell matrix, the bounded worker pool, the error mapping (a
thrown trial records `reward: null` with the error text, never a zero), cleanup, and the summary.

## Manager and dashboard

```sh
bun run serve            # REST + SSE over the run store, dashboard at /
```

The store is `<runs-dir>/_manager/evals.sqlite`, schema v2. Every row carries the suite and backend
identity, so rows from two suites cannot be aggregated into one pass rate, and the experiment and
arm a launch stated, so grouping never re-parses a job name. An unmeasured cost or token count is
stored as NULL and reported as absent, never as zero. `docs/manager.md` covers the API.

## Documentation

|Document|Covers|
|---|---|
|[`docs/harnesses.md`](docs/harnesses.md)|The harness axis: adapters, registry, backend bindings|
|[`docs/backends.md`](docs/backends.md)|The `ExecutionBackend` contract and the three backends|
|[`docs/typescript-edit.md`](docs/typescript-edit.md)|The TypeScript-edit suite, its mutations and corpus|
|[`docs/terminal-bench.md`](docs/terminal-bench.md)|The Terminal-Bench suite on the Harbor backend|
|[`docs/search-bench.md`](docs/search-bench.md)|The offline search bench: corpora, case suites, arms|
|[`docs/manager.md`](docs/manager.md)|The run store, REST/SSE API and launch parameters|
|[`docs/dashboard.md`](docs/dashboard.md)|The wire contract and how unmeasured values render|
|[`docs/deep-swe/`](docs/deep-swe/)|The DeepSWE suite: eval guide, arms, run format, measurement tools, adapter authoring|

## Gates

```sh
bun run check:types      # both projects: the package, then src/web
bash ../../scripts/test-sandbox/run.sh bun test packages/evals   # from the repo root
bun run test:py          # Python container agents
```
