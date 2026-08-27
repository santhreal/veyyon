# Harnesses

A harness is one member of the harness axis: an agent system that executes a task. Four are
registered — `veyyon`, `omp`, `factory`, `hermes` — and a run names one or more with `--harnesses`
(the DeepSWE runner names them as arms with `--arms`).

`src/core/types.ts` declares the `HarnessAdapter` contract. `src/core/harness-registry.ts` is the
registry. `src/harnesses/index.ts` holds `builtinHarnesses` and `registerBuiltinHarnesses()`.
`src/harnesses/adapters/` holds the adapters. `agents/pier/` and `agents/harbor/` hold the Python
classes the container backends import, and `agents/common/` the modules both frameworks share:
the container-program executor, the session-usage readers, the attachment reader and the
model-catalog bootstrap.

To add one, follow [`deep-swe/ADAPTER_AUTHORING.md`](deep-swe/ADAPTER_AUTHORING.md).

## What an adapter declares

| Member | Purpose |
|---|---|
| `name`, `displayName`, `description` | Identity and report labels |
| `defaultModel` | Model used when a run names none; `null` requires `--model` |
| `capabilities` | `replay`, `compaction`, `armAttachments`, `promptOverrides`, each stated as a boolean |
| `backends` | The backends it runs on, and the binding each needs |
| `flags` | The invocation flags the adapter reads (`omp-binary`, `factory-auth`, …) |
| `preflight` | Rejects before a run when a binary or credential is absent |
| `stageAssets` | Writes binaries, configs and credentials the trial reads |

## Registered harnesses

| Harness | Backends | Capabilities | Default model |
|---|---|---|---|
| `veyyon` | pier, harbor, in-process | replay, compaction, arm attachments, prompt overrides | none — the run must name one |
| `omp` | pier, harbor | none | `opencode-go/deepseek-v4-flash` |
| `factory` | pier | replay, compaction | `google-antigravity/gemini-3.6-flash` |
| `hermes` | pier | replay, compaction | `google-antigravity/gemini-3.6-flash` |

`veyyon` declares no default model. A run that names no model is rejected by `resolveTrialModel`
rather than measured against an unstated one, because the arm name never states which model it used.

`armAttachments` and `promptOverrides` decide whether a run may vary those axes. A run whose
`--prompts` axis reaches a harness declaring `promptOverrides: false` is rejected on the `axes`
verdict, because the overlay would go unread and every cell of that axis would run the identical
trial under a different arm name. The backend states the same thing for itself in
`appliesVariantAxes`: `in-process` reads a config overlay and prompt overrides, `pier` reads a config
overlay and stages arm attachments, `harbor` reads none of the three.

## Backend bindings

`backends` maps a backend id to a `HarnessBackendBinding`, and is the only declaration of these
facts:

- `agentImportPath` — the `module:Class` the backend imports. The Pier job config reads it, and the
  DeepSWE runner rejects a Pier run of a harness that states none.
- `agentName` — the name a backend's CLI selects the harness by (`harbor run --agent <name>`);
  defaults to the harness name.
- `containerAssetsDir` — where staged assets are mounted inside the container.
- `authGateway` — whether the harness reaches its provider through the host authentication
  gateway. A harness carrying its own credentials leaves it unset, and the harbor environment
  builder then writes no gateway variables for it.

A (harness, suite) pair whose backend is absent from `backends` fails run planning with
`UnboundHarnessBackendError` naming the harness, the suite and the backend.

## Container programs

A harness that runs a CLI inside a task container declares that run once, as
`containerProgram(context)` returning a `StagedProgram`: the files to upload, the setup lines, the
invocation with `{{instruction}}`, `{{model}}` and `{{assets}}` substituted, the env file sourced
before it, the log path, the session sources and the usage dialect. `src/core/container-program.ts`
validates it and stages it as `program.json`; `agents/common/container_program.py` executes it under
either framework. Pier passes the staged path as the `program_path` job-config kwarg, harbor as
`VEYYON_BENCH_AGENT_PROGRAM`, and every backend files it at
`<assets-root>/programs/<harness>/<arm>` through `programDirFor`.

`omp` is delivered this way, which is what gives it harbor and therefore Terminal-Bench. `veyyon`
declares no program: it mounts local source, seeds a credential store and replays recorded sessions,
so it keeps its own agent class per backend.

## Registry behavior

`registerHarness` rejects a duplicate id with `DuplicateHarnessRegistrationError`.
`requireHarness` rejects an unknown id with `HarnessNotFoundError` naming every registered id.
`validateSystemsSelection` partitions a requested list into valid and invalid ids without throwing,
for a CLI that reports all bad ids at once.

The registry is process-wide. A test that resolves a harness calls `registerBuiltinHarnesses()`
first; it is idempotent, and no test clears the shared registry.

`listHarnessFlags()` is the union of the registered adapters' `flags`. An entry point adds it to its
flag grammar, so `--omp-binary` is accepted where the omp adapter is registered and `--ompbinary`
refuses the invocation instead of leaving the adapter on its PATH default. A flag an adapter reads
without declaring, and a declared flag it never reads, both fail
`test/harnesses/an-adapter-declares-the-flags-it-reads-and-the-runner-accepts-them.test.ts`.

## Layering

`src/core/**` and `src/harnesses/**` import neither a suite, a backend, the manager nor the server:
every contract they share is declared in `src/core/types.ts` and supplied by the caller. An adapter
states its own backend bindings — the pier agent class, harbor's agent name and import path — so
adding a harness touches no backend. The boundary is a `noRestrictedImports` override on those two
directories in the repo `biome.json`, so `bun run check:tools` fails on an upward import rather than
a reviewer noticing it.

## Cross-harness comparison

`src/harnesses/system-comparison.ts` aggregates one task set executed by two harnesses into a paired
comparison: per-task cells, hard gates, and a rejection (`ComparisonRejected`) when the two arms did
not measure the same tasks. It is the only place a claim of the form "harness A beats harness B" is
computed.
