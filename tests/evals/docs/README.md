# Evals

`@veyyon/evals` measures agents: it runs benchmark suites across harnesses, models, settings
overlays, prompt overlays and builds of the agent, records every trial, and reports what changed
between arms. It holds the suites, the harness adapters, the execution backends, a kit for writing
new benchmarks, offline benches and measurements, a run store, and a dashboard.

There is no automatic optimizer. A person proposes a change as an arm (a settings overlay, a prompt
overlay, or a build), and the evals run it beside a baseline on the same tasks and seeds and state
the difference with its uncertainty.

## Chapters

1. [Running evals](running.md): the `evals` command, its modes and flags.
2. [Architecture](architecture.md): the engine's modules, the contracts between them, and how
   members are discovered.
3. [Backends](backends.md): where a trial runs: Pier, Harbor, in-process, local-cli.
4. [Suites](suites.md): the benchmarks this package holds, and how to add one.
5. [Writing a kit suite](kit.md): a benchmark as a catalog of seeded tasks graded by recorded state.
6. [The browser suite](browser-suite.md): hard web tasks on local applications.
7. [Experiments](experiments.md): comparing arms and builds, reading the paired report.
8. [Run output](output.md): the files a run writes and the records in them.
9. [Benches, measurements and tools](programs.md): the programs that are not suites.

## Quick start

```sh
bun evals.ts --list
bun evals.ts --suite browser --model google-antigravity/gemini-3.8-flash --dry-run
bun evals.ts --suite browser --model google-antigravity/gemini-3.8-flash --repeats 2 --jobs 4
```

Run the commands from `tests/evals`. A run writes `runs/<run-id>/`, with `report.md` beside the
trial records.
