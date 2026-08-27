# Run Directory Format

Each evaluation run creates a timestamped directory under `runs/`. This document describes the structure and contents of each file.

## Top-level layout

```
runs/<timestamp>/
├── report.md          # Human-readable Markdown report
├── results.json       # Machine-readable trial results
├── assets/            # Staged binaries, auth, arm configs
├── configs/           # Per-trial Pier job configs
└── jobs/              # Per-trial execution artifacts
```

The timestamp is ISO 8601 with colons replaced by hyphens (e.g. `2026-08-25T09-10-52-052Z`).

## assets/

Binaries and credentials staged by the harness before trials start. All arms in a run share the same assets directory.

| File | Purpose |
|---|---|
| `vey` | Pinned veyvon binary (copy of `--binary` or `packages/coding-agent/dist/vey`) |
| `cli.js` | omp CLI (if an omp arm is present) |
| `bun` | Bun runtime copy for container use |
| `auth-agent.db` | Seeded auth credentials (copied from `~/.veyyon/shared-auth/agent.db`) |
| `opencode-key` | OpenCode API key file (mode 0600) |
| `omp-models.yml` | Generated models.yml for omp (when model is dynamically discovered) |
| `arms/` | Resolved arm configuration files |
| `attachments.json` | Arm attachment manifest |

## configs/

One YAML file per trial, named `<arm>__<task>__r<repeat>.yaml`. These are the Pier job configurations passed to the container.

## jobs/

One directory per trial, named `<arm>__<task>__r<repeat>/`.

### Job-level files

| File | Purpose |
|---|---|
| `config.json` | Full job configuration (arm, task, model, repeat, system kwargs) |
| `result.json` | Trial result summary (reward, tokens, cost, error classification) |
| `job.log` | Pier orchestration log (container lifecycle, network setup) |
| `lock.json` | Trial lock file (prevents concurrent execution of the same cell) |

### Trial subdirectory

Each job directory contains a `<task>__<random-id>/` subdirectory with the actual trial execution artifacts:

| Path | Purpose |
|---|---|
| `trial.log` | Container-level log (Docker compose output, build steps) |
| `config.json` | Container-specific configuration |
| `agent/` | Agent output files |
| `agent/veyyon.txt` | Veyvon agent stdout/stderr (veyyon arms) |
| `agent/omp.txt` | Omp agent NDJSON event stream (omp arms) |
| `agent/model-catalog-refresh.txt` | Model catalog refresh output (veyyon arms) |
| `verifier/` | Verifier outputs |
| `verifier/reward.json` | Structured scores (binary reward, pass fractions f2p/p2p) |
| `verifier/ctrf.json` | Machine-readable test report with failure messages |
| `verifier/test-stdout.txt` | Raw test suite output |
| `verifier/run.log` | Raw stdout/stderr captured during verifier run |
| `verifier/reports/` | Framework-native report files from the grader |
| `artifacts/` | Extracted patch and commit metadata |
| `artifacts/model.patch` | The patch the agent produced |
| `egress-proxy/` | Squid proxy configuration and logs |
| `agent-build-context/` | Docker build context for the agent container |

## results.json

Machine-readable array of `ArmResult` objects, one per trial:

```json
{
  "arm": "baseline",
  "task": "ytt-jsonpath-query-api",
  "repeat": 0,
  "reward": 1.0,
  "partial": 1.0,
  "f2p": 1.0,
  "p2p": 1.0,
  "inputTokens": 295039,
  "outputTokens": 92117,
  "cacheTokens": 11662592,
  "cacheReadTokens": null,
  "cacheWriteTokens": null,
  "promptCacheInvalidations": null,
  "costUsd": 0.05,
  "agentSeconds": 820,
  "argotLoadCalls": null,
  "assistantMsgsWithSigil": null,
  "argotPreamblePresent": null,
  "argotHandlesLoaded": null,
  "argotHandlesTaught": null,
  "encodeHeadroom": null,
  "toolCalls": 42,
  "error": null
}
```

Fields set to `null` mean "not measured", never zero. Zero is a real value: a dictionary that loaded no handles is a corpus fact, not missing data.

## report.md

The rendered Markdown report contains these sections:

1. **Header**: Model, task count, repeats, arms, and provenance warning.
2. **Per-arm totals**: Pass rate with Wilson 95% CI, mean reward, token usage, cost, wall time.
3. **Cost at reference rates**: Counterfactual cost computed from published model rates.
4. **Prompt cache invalidations**: Mid-session cache miss events (when instrumented).
5. **Per-task breakdown**: Pass rate and mean output tokens per task per arm.
6. **Arm comparison**: Paired sign test with Holm-Bonferroni correction.
7. **Reward comparison**: Continuous partial credit comparison (when applicable).
8. **Argot treatment**: Encoding preamble verification and handle statistics (when applicable).

## Re-aggregating

Re-parse trial results and regenerate `results.json` and `report.md` without re-executing trials:

```bash
bun src/suites/deep-swe/run.ts --reaggregate runs/2026-08-25T09-10-52-052Z
```

A comparison run exits 1 when its gates did not pass, from a live run and from a re-aggregation
alike. The report is written either way. `reaggregate()` and `runBench()` return the comparison, so
importing either leaves the calling process's exit code alone.

## Merging runs

Pool multiple run directories into a combined report:

```bash
bun src/suites/deep-swe/run.ts --merge runs/day1,runs/day2 --out runs/merged
```

The merged directory contains a combined `results.json` and `report.md` with all trials from all input runs.
