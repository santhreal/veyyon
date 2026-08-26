# @veyyon/deepswe-bench

Benchmark harness for evaluating coding agents against [DeepSWE](https://deepswe.datacurve.ai/) tasks. Runs agents across configuration arms or system adapters in isolated Docker containers and reports verifier reward, token usage, cost, and wall time.

## Quick Start

```bash
# List available arms, system adapters, and task sets
bun run.ts --list

# Smoke test: 1 task, 1 arm, ~5 minutes
bun run.ts --tasks tasks/smoke.txt --arms baseline --jobs 1

# Feature comparison: 10 tasks, 2 arms
bun run.ts --tasks tasks/pilot-10.txt --arms baseline,full --jobs 2

# Cross-system comparison: veyyon vs omp on the same model
bun run.ts --arms baseline,omp --model opencode-go/deepseek-v4-flash --tasks tasks/pilot-10.txt

# Dry run: validate preflight without launching containers
bun run.ts --tasks tasks/pilot-10.txt --arms baseline,full --dry-run
```

## Architecture

```
                                    +-----------------------+
                                    |       CLI (run.ts)    |
                                    +-----------+-----------+
                                                |
                               +----------------+---------------+
                               |                                |
                     +---------v---------+            +---------v---------+
                     |    src/runner/    |            |   src/systems/    |
                     |  - cli-args       |            |  - registry       |
                     |  - preflight      |            |  - adapters (vey, |
                     |  - arm-staging    |            |    omp, factory,  |
                     |  - executor       |            |    hermes)        |
                     +---------+---------+            +---------v---------+
                               |                                |
                               +----------------+---------------+
                                                |
                                    +-----------v-----------+
                                    |    Pier Orchestrator  |
                                    | (Docker Containers)   |
                                    +-----------+-----------+
                                                |
                               +----------------+---------------+
                               |                                |
                     +---------v---------+            +---------v---------+
                     |   src/aggregate/  |            |   report.md /     |
                     |  - stats & Wilson |            |   results.json    |
                     |  - usage tally    |            +-------------------+
                     |  - report-render  |
                     +-------------------+
```

### Layers

1. **CLI (`run.ts` → `src/runner/executor.ts`)**: Parses arguments, runs preflight checks, stages assets, queues trials, and writes the final report.
2. **System adapters (`src/systems/`)**: Pluggable registry of agent systems. Each adapter handles preflight validation, asset staging, and Pier job configuration for its target agent (veyyon, omp, factory, hermes).
3. **Pier orchestrator**: Spawns Docker containers per trial with network allowlists, egress proxies, and verifier environments. Python agents in `pier_agent/` run inside the containers.
4. **Aggregation (`src/aggregate/`)**: Collects trial results, computes Wilson confidence intervals, sign tests with Holm-Bonferroni correction, and renders the Markdown report.

## Execution Model

### Arms

An arm is a configuration overlay in `arms/<name>.yml`. The runner compares two or more arms across identical tasks. Arms can override:

- **Feature flags**: Toggle configuration keys (e.g. `argot.enabled: true`).
- **Prompt sections**: Override one section via `arms/<arm>.sections.yml`.
- **Prompt statements**: Override or ablate one statement via `arms/<arm>.statements.yml` (set `<statement-id>: null` to ablate).
- **Prompt registry items**: Override tool descriptions, subagent prompts, or agent prompts via `arms/<arm>.prompts.yml`.
- **Behavioral rules**: Add a rule file via `arms/<arm>.rule.md`.

### System Adapters

System adapters run entirely different agent binaries (veyyon, omp, factory, hermes) on the same tasks and model. `--arms` accepts any mix of config arms and system adapters in a single run.

### Validation

Before and during execution:

1. Arms with identical configurations are rejected.
2. When shorthand encoding is enabled, the requested model must be allowlisted.
3. The runner verifies the encode preamble reached the model prompt.
4. Settings keys are validated against the schema.
5. Setting values are validated against their declared types.

## CLI Options

| Flag | Purpose |
|---|---|
| `--list` | List available arms, system adapters, and task sets, then exit |
| `--tasks <file>` | Path to task list (e.g. `tasks/pilot-10.txt`) |
| `--tasks-root <dir>` | Path to root DeepSWE task directory |
| `--arms <list>` | Comma-separated arms: config arms and/or system adapters in any combination |
| `--model <id>` | Model identifier (defaults to `opencode/deepseek-ai/DeepSeek-V3.2`) |
| `--limit <n>` | Representative task limit sampled evenly across the task list |
| `--repeats <n>` | Samples per `(arm, task)` cell |
| `--jobs <n>` | Maximum parallel Docker container trials. When `n` equals the arm count the runner drains in paired waves: one trial per arm for the same task starts together, and the next task waits for the whole wave to settle |
| `--out <dir>` | Output directory for artifacts and reports |
| `--binary <path>` | Pin a specific build of the `vey` binary |
| `--trial-timeout <sec>` | Override per-trial timeout in seconds |
| `--dry-run` | Validate preflight, stage configs, and print plan without containers |
| `--reaggregate <dir>` | Re-parse trial results and regenerate `results.json` and `report.md` |
| `--run-dir <dir>` | Alias for `--reaggregate` |
| `--merge <dirs>` | Pool multiple run directories into a combined report |
| `--replay-root <dir>` | Directory containing validated `<task>.json` replay manifests |
| `--factory-binary <path>` | Path to Droid/Factory binary for factory system comparison |
| `--omp-cli <path>` | Path to omp CLI for omp system comparison |
| `--systems <list>` | Legacy alias for `--arms` with system adapter names |
| `--system-comparison` | Legacy shorthand: `--arms` with all registered system adapters |
| `--opencode-key <key>` | OpenCode API key (alternatively set `OPENCODE_API_KEY` env var) |
| `--help`, `-h` | Show help message with all flags |

## Convenience Scripts

| Command | What it does |
|---|---|
| `bun run list` | List arms, systems, and task sets |
| `bun run smoke` | 1-task smoke test |
| `bun run smoke:dry` | Dry-run the smoke test |
| `bun run pilot` | 10-task pilot with baseline vs full |
| `bun run pilot:dry` | Dry-run the pilot |
| `bun run compare` | Cross-system veyyon vs omp |
| `bun run compare:dry` | Dry-run the comparison |

## Task Sets

| File | Tasks | Bias | Use |
|---|---|---|---|
| `tasks/smoke.txt` | 1 | Biased | Plumbing validation |
| `tasks/pilot-10.txt` | 10 | Hardest by patch size | Stress testing |
| `tasks/diverse-20.txt` | 20 | Unbiased, held-out | Headline numbers |
| `tasks/holdout-10.txt` | 10 | Held-out | Out-of-sample evaluation |
| `tasks/argot-10.txt` | 10 | Argot-relevant | Shorthand encoding evaluation |

Task lists carry provenance headers (`@headline`, `@biased`) that the report renders as warnings when the set is not suitable for headline reporting.

## Canonical Comparisons

| Comparison | Arms | Variable |
|---|---|---|
| Feature flag | `baseline` ↔ `argot-setting-only` | `argot.enabled` |
| Behavioral rule | `argot-setting-only` ↔ `candidate-argot-nudge` | `arms/candidate-argot-nudge.rule.md` |
| Tool description | `baseline` ↔ `candidate-bash-trim` | `arms/candidate-bash-trim.prompts.yml` (`tools/bash`) |
| Delivery policy | `baseline` ↔ `candidate-delivery-terse` | `arms/candidate-delivery-terse.sections.yml` |
| Statement ablation | `baseline` ↔ `candidate-ablate-delegation-gates` | `arms/candidate-ablate-delegation-gates.statements.yml` |
| Encoding | `decode` ↔ `full` | Model allowlist and preamble |
| Dictionary budget | `full` ↔ `full-budget16k` | `arms/full-budget16k.yml` |

## Run Directory Structure

Each run creates a timestamped directory under `runs/`:

```
runs/<timestamp>/
├── report.md          # Markdown report with stats and comparison tables
├── results.json       # Machine-readable trial results
├── assets/            # Staged binaries, auth DB, arm configs
│   ├── vey            # Pinned veyyon binary
│   ├── cli.js         # omp CLI (if omp arm present)
│   ├── bun            # Bun runtime
│   ├── auth-agent.db  # Seeded auth credentials
│   └── arms/          # Resolved arm configurations
├── configs/           # Per-trial Pier job configs (<arm>__<task>__r<n>.yaml)
└── jobs/              # Per-trial execution artifacts
    └── <arm>__<task>__r<n>/
        ├── config.json           # Job configuration
        ├── result.json           # Trial result (reward, tokens, cost)
        ├── job.log               # Pier orchestration log
        ├── lock.json             # Trial lock file
        └── <task>__<id>/
            ├── trial.log         # Container-level log
            ├── config.json       # Container config
            ├── agent/            # Agent output files (veyyon.txt, omp.txt, etc.)
            ├── verifier/         # Verifier outputs (reward.json, ctrf.json, test-stdout.txt)
            ├── artifacts/        # Extracted patch and commit metadata
            └── egress-proxy/     # Squid proxy configuration
```

Re-aggregate an existing run without re-executing trials:

```bash
bun run.ts --reaggregate runs/2026-08-01T12-00-00
```

Merge multiple runs into a combined report:

```bash
bun run.ts --merge runs/day1,runs/day2 --out runs/merged
```

## Directory Structure

```
packages/deepswe-bench/
├── run.ts               # CLI entrypoint
├── aggregate.ts         # Re-exports + emptyArmResult factory
├── src/
│   ├── aggregate/       # Statistical tests, usage tallying, report rendering
│   ├── runner/          # CLI parsing, preflight, arm staging, Pier execution
│   └── systems/         # Pluggable system adapter registry and adapters
├── arms/                # Configuration overlays (baseline.yml, candidate-*.yml)
├── tasks/               # Task lists with provenance headers
├── pier_agent/          # Python container agents (veyyon_agent.py, omp_agent.py, etc.)
├── deep-swe/            # DeepSWE task corpus (Harbor format)
├── dicts/               # Repository vocabulary dictionaries (.AGENTS.dict)
├── fixtures/            # Static test fixtures
├── docs/                # Extended documentation
└── runs/                # Evaluation run outputs (timestamped directories)
```

## Documentation

- [Evaluation Guide](docs/EVAL_GUIDE.md): Step-by-step workflows for running evals.
- [Run Directory Format](docs/RUN_FORMAT.md): Structure and contents of run output directories.
- [Arms Reference](docs/ARMS_REFERENCE.md): All available arms and their configuration variables.
- [System Adapter Authoring](docs/ADAPTER_AUTHORING.md): How to create and register new agent adapters.
- [Measurement Tools](docs/MEASUREMENT_TOOLS.md): Token channel split, prefix caching, and headroom analysis.
- [Pier Agent Runtime](pier_agent/README.md): Python agent container architecture.

## Testing

```bash
# TypeScript unit tests
bash scripts/test-sandbox/run.sh bun test packages/deepswe-bench

# Python agent unit tests
python3 -m unittest discover -s packages/deepswe-bench/pier_agent -p "*_test.py"
```

## Troubleshooting

### Docker network exhaustion

Stale networks from previous runs accumulate and exhaust Docker's address pools. Remove them:

```bash
docker ps -a --format '{{.Names}}' | grep -E 'ytt-jsonpath|httpx-streaming' | xargs -r docker rm -f
docker network ls --filter "name=pier-egress" -q | xargs -r docker network rm
```

### GLIBC native addon crash

The veyyon native addon requires GLIBC 2.39+. DeepSWE containers ship older GLIBC. The loader falls back to a pure-JS path when the native addon cannot load, but older binaries crash in `ChildProcess.kill()`. Use a binary built after the GLIBC fix (commit `c33f42dd9` or later).

### Model resolution failures in containers

Dynamically-discovered models (not in the bundled catalog) require a `models refresh` before the agent starts. The veyyon binary has a synchronous discovery fallback for explicit `--model` patterns. For omp, the harness generates a `models.yml` with full metadata using the veyvon binary's models.dev overlay and stages it into the container.

### DNS timeout to ECR

`httpx-streaming-json-iteration` and other tasks that pull from `public.ecr.aws` can fail with DNS timeouts if the egress proxy cannot resolve the endpoint. Check the egress proxy allowlist in the task's `environment/` directory.

### 401/403 from OpenCode API

Ensure the OpenCode API key is valid and seeded in the auth DB. The harness reads from `~/.veyyon/shared-auth/agent.db`. Some models (e.g. Muse Spark) require explicit opt-in to data collection policies before they respond.
