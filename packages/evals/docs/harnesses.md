# Harnesses

A harness is one member of the harness axis: an agent system that executes a task. Four are
registered — `veyyon`, `omp`, `factory`, `hermes` — and a run names one or more with `--harnesses`
(the DeepSWE runner names them as arms with `--arms`).

`src/core/types.ts` declares the `HarnessAdapter` contract. `src/core/harness-registry.ts` is the
registry. `src/harnesses/index.ts` holds `builtinHarnesses` and `registerBuiltinHarnesses()`.
`src/harnesses/adapters/` holds the adapters. `agents/pier/` and `agents/harbor/` hold the Python
classes the container backends import.

To add one, follow [`deep-swe/ADAPTER_AUTHORING.md`](deep-swe/ADAPTER_AUTHORING.md).

## What an adapter declares

| Member | Purpose |
|---|---|
| `name`, `displayName`, `description` | Identity and report labels |
| `defaultModel` | Model used when a run names none; `null` requires `--model` |
| `capabilities` | `replay`, `compaction`, `armAttachments`, `promptOverrides` |
| `backends` | The backends it runs on, and the binding each needs |
| `flags` | The invocation flags the adapter reads (`omp-binary`, `factory-auth`, …) |
| `preflight` | Rejects before a run when a binary or credential is absent |
| `stageAssets` | Writes binaries, configs and credentials the trial reads |

## Registered harnesses

| Harness | Backends | Capabilities | Default model |
|---|---|---|---|
| `veyyon` | pier, harbor, in-process | replay, compaction, arm attachments, prompt overrides | none — the run must name one |
| `omp` | pier | none | `opencode-go/deepseek-v4-flash` |
| `factory` | pier | replay, compaction | `google-antigravity/gemini-3.6-flash` |
| `hermes` | pier | replay, compaction | `google-antigravity/gemini-3.6-flash` |

`veyyon` declares no default model. A run that names no model is rejected by `resolveTrialModel`
rather than measured against an unstated one, because the arm name never states which model it used.

## Backend bindings

`backends` maps a backend id to a `HarnessBackendBinding`, and is the only declaration of these
facts:

- `agentImportPath` — the `module:Class` the backend imports. The Pier job config reads it, and the
  DeepSWE runner rejects a Pier run of a harness that states none.
- `agentName` — the name a backend's CLI selects the harness by (`harbor run --agent <name>`);
  defaults to the harness name.
- `containerAssetsDir` — where staged assets are mounted inside the container.

A (harness, suite) pair whose backend is absent from `backends` fails run planning with
`UnboundHarnessBackendError` naming the harness, the suite and the backend.

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

## Cross-harness comparison

`src/harnesses/system-comparison.ts` aggregates one task set executed by two harnesses into a paired
comparison: per-task cells, hard gates, and a rejection (`ComparisonRejected`) when the two arms did
not measure the same tasks. It is the only place a claim of the form "harness A beats harness B" is
computed.
