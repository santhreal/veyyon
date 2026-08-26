# Terminal-Bench 3.0 Suite Specification & Operator Guide

`packages/evals` runs **Terminal-Bench 3.0** through the `terminal-bench` `EvalSuite`.

## Overview

- **Suite Name**: `terminal-bench`
- **Version**: `v3.0.0`
- **Canonical Git Remote**: `https://github.com/harbor-framework/terminal-bench.git`
- **Pinned Git Tag**: `refs/tags/v3.0.0`
- **Pinned Commit SHA**: `2b0442c3c583b710ca8da14c8e601b99f2f1f244` (74 tasks, 866M)
- **Execution Backend**: `harbor` (resolved through `src/core/backend-registry.ts`)
- **Default Cache Location**: `packages/evals/.cache/datasets/terminal-bench/v3.0.0`

## Suite Registration & Discovery

The suite registers itself in `defaultSuiteRegistry` when its register module is imported:

```typescript
import { requireSuite } from "@veyyon/evals/core/suite-registry";
import { registerTerminalBenchSuite } from "@veyyon/evals/suites/terminal-bench/register";

registerTerminalBenchSuite();
const suite = requireSuite("terminal-bench");
```

`registerTerminalBenchSuite()` is idempotent and takes a registry, so a test may register into its
own. Importing the module registers into the default registry as a side effect.

## Task List Selection & Provenance

Curated task lists live in `packages/evals/datasets/terminal-bench/tasks/`:

| Task List | Tasks | Directive | Purpose |
|---|---|---|---|
| `tasks/smoke.txt` | 1 | `@biased` | Fast plumbing & CI smoke check (`bun-sourcemap-leak`) |
| `tasks/pilot.txt` | 10 | `@biased` | Curated fast subset across 10 diverse categories for quick validation |
| `tasks/pilot-10.txt` | 10 | `@biased` | Alias for `tasks/pilot.txt` |

### Provenance Headers

Every task list file begins with a provenance directive:
- `# @biased: <reason>`: Marks a subset chosen for speed or stress, not suitable for headline reporting.
- `# @headline: <reason>`: Marks an unbiased, representative sample suitable for headline pass rate claims.

A task list line is one task id, which becomes a directory under the dataset root. A line that is
not a single path segment — a path, an absolute name, `..`, or a name with surrounding whitespace —
refuses the list and names the file and the line number, before a run starts.

### Recorded provenance

`computeTerminalBenchProvenance` records `resolvedCommitSha`, `taskCount`, `selectedTasks` and a
SHA-256 `contentHash` over the `task.toml` and `instruction.md` of each selected task, in sorted
order. Both fields state what was read: a task file that cannot be read ends the computation naming
the path rather than hashing as empty, and a checkout whose commit cannot be resolved ends it rather
than reporting the pinned constant. Pass `commitSha` to record a commit explicitly.

## Task Descriptor & Metadata Mapping

`describeTask(taskId, context)` reads `task.toml` and returns a `TaskDescriptor`:

- `id`: Task identifier (e.g. `bun-sourcemap-leak`)
- `path`: Task directory path
- `timeBudgetSec`: Agent timeout from `[agent].timeout_sec` (defaults to 18000s)
- `instructionPath`: Path to `instruction.md`
- `metadata`: Complete task configuration:
  - `verifier`: verifier settings (`environment_mode`, `timeout_sec`, `env`)
  - `agent`: agent settings (`timeout_sec`, `user`)
  - `environment`: environment constraints (`cpus`, `memory_mb`, `storage_mb`, `gpus`, `gpu_types`, `network_mode`, `os`, `workdir`)
  - `artifacts`: required output artifacts collected from agent container
  - `rawConfig`: complete validated `TaskConfig` descriptor

## Preflight Verification

`preflight(context)` validates all prerequisite host capabilities before running:

1. **Corpus Presence**: Checks `datasetDir/tasks/` exists.
2. **Commit SHA Pin**: Checks git HEAD matches `2b0442c3c583b710ca8da14c8e601b99f2f1f244`.
3. **Harbor on PATH**: Validates `harbor` executable is discoverable.
4. **Docker Accessibility**: Runs `docker info` to ensure daemon is active and responsive.
5. **GPU Verification**: For selected tasks with `environment.gpus > 0`, verifies host has usable GPU acceleration via `nvidia-smi`.

Fails closed with actionable diagnostics if any check fails.

## Scoring & Reward Parsing Contract

`scoreTrial(cell, artifacts)` grades trial results:

1. **Reward File Precedence**:
   - `verifier/reward.json` (`{"reward": float, "partial"?: float}` or `{"rewards": {"default": float}}`)
   - `verifier/reward.txt` (single floating point number)
   - `result.json` (fallback verifier result / exception info)
2. **Failure vs Zero-Score Distinction**:
   - Scored `0`: `reward: 0.0, error: null` (attempt completed and failed verification)
   - Scored `1`: `reward: 1.0, error: null` (attempt passed verification)
   - Missing / Empty / Corrupted reward: `reward: null, error: "<actionable message>"` (trial errored / aborted)
3. **Multi-Step Tasks**:
   - Supports `multi_step_reward_strategy`: `"mean"` (average step rewards) or `"final"` (score of final step).
4. **Usage Metrics**:
   - Extracts token counts (`inputTokens`, `outputTokens`, `cacheTokens`), cost (`costUsd`), and duration (`durationSec`) when present in trial artifacts.
