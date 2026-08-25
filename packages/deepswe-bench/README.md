# @veyyon/deepswe-bench

Benchmark harness for evaluating Veyyon features against DeepSWE tasks. It runs the agent across configuration arms or system adapters in isolated Docker containers and reports verifier reward, token usage, cost, and wall time.

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
                     +---------+---------+            +---------+---------+
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

## Quick Start

### Discover what is available

```bash
bun run.ts --list          # list all arms, system adapters, and task sets
bun run.ts --help          # show every flag and usage example
```

### Smoke test (1 task, 1 arm, ~5 minutes)

Validates the full pipeline — binary staging, auth seeding, Pier container, verifier — on a single task.

```bash
bun run.ts --tasks tasks/smoke.txt --arms baseline --jobs 1
```

### Feature comparison (10 tasks, 2 arms)

Compares a baseline arm against a candidate arm across the pilot task set.

```bash
bun run.ts --tasks tasks/pilot-10.txt --arms baseline,candidate-bash-trim --jobs 2
```

### Cross-system comparison (veyyon vs omp)

Runs two different agent systems on the same tasks and model, then reports paired gates.
System adapters (veyyon, omp, factory, hermes) can be mixed with config arms in a single run.

```bash
bun run.ts --arms veyyon,omp --model opencode-go/deepseek-v4-flash --tasks tasks/pilot-10.txt
bun run.ts --arms baseline,omp --model opencode-go/deepseek-v4-flash --tasks tasks/pilot-10.txt
```

### Dry run (validate without containers)

Checks binary, auth, arm configs, task lists, and Pier version — then prints the plan and exits.

```bash
bun run.ts --tasks tasks/pilot-10.txt --arms baseline,full --dry-run
```

### Re-aggregate or merge existing runs

```bash
bun run.ts --reaggregate runs/2026-08-01T12-00-00
bun run.ts --merge runs/day1,runs/day2 --out runs/merged
```

### Convenience scripts

| Command | What it does |
|---|---|
| `bun --cwd packages/deepswe-bench run list` | List arms, systems, and task sets |
| `bun --cwd packages/deepswe-bench run smoke` | 1-task smoke test |
| `bun --cwd packages/deepswe-bench run smoke:dry` | Dry-run the smoke test |
| `bun --cwd packages/deepswe-bench run pilot` | 10-task pilot with baseline vs full |
| `bun --cwd packages/deepswe-bench run pilot:dry` | Dry-run the pilot |
| `bun --cwd packages/deepswe-bench run compare` | Cross-system veyyon vs omp |
| `bun --cwd packages/deepswe-bench run compare:dry` | Dry-run the comparison |

## Execution model

An arm is a configuration overlay in `arms/<name>.yml`. Runs compare two or more arms across identical tasks.

### Single-variable comparisons

Arm comparisons evaluate one variable at a time:

- **Prompt section:** Override one section via `arms/<arm>.sections.yml`. The runner passes this through `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS`.
- **Prompt statement:** Override or ablate one statement via `arms/<arm>.statements.yml` (set `<statement-id>: null` to ablate). Passed via `VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS`.
- **Prompt registry item:** Override one registry prompt (tool description, subagent prompt, agent prompt) via `arms/<arm>.prompts.yml`. Passed via `VEYYON_EVAL_PROMPTS`.
- **Feature flag:** Toggle one configuration key in `arms/<arm>.yml`.
- **Model:** Change `--model <id>`.

Validation checks before and during execution:
1. **Identical inputs:** Arms with identical configurations are rejected.
2. **Model allowlist:** When shorthand encoding is enabled, the requested model must be allowlisted.
3. **Preamble verification:** The runner verifies the encode preamble reached the model prompt.
4. **Configuration keys:** Settings keys are validated against the schema.
5. **Setting values:** Values are validated against their declared types.

## Canonical comparisons

| Comparison | Arms | Variable |
|---|---|---|
| Feature flag | `baseline` ↔ `argot-setting-only` | `argot.enabled` |
| Behavioral rule | `argot-setting-only` ↔ `candidate-argot-nudge` | `arms/candidate-argot-nudge.rule.md` |
| Tool description | `baseline` ↔ `candidate-bash-trim` | `arms/candidate-bash-trim.prompts.yml` (`tools/bash`) |
| Delivery policy | `baseline` ↔ `candidate-delivery-terse` | `arms/candidate-delivery-terse.sections.yml` |
| Statement ablation | `baseline` ↔ `candidate-ablate-delegation-gates` | `arms/candidate-ablate-delegation-gates.statements.yml` |
| Encoding | `decode` ↔ `full` | Model allowlist and preamble |
| Dictionary budget | `full` ↔ `full-budget16k` | `arms/full-budget16k.yml` |

## CLI Options

| Flag | Purpose |
|---|---|
| `--list` | List available arms, system adapters, and task sets, then exit |
| `--tasks <file>` | Path to task list (e.g. `tasks/pilot-10.txt` or `tasks/diverse-20.txt`) |
| `--tasks-root <dir>` | Path to root DeepSWE task directory |
| `--arms <list>` | Comma-separated arms: config arms (`baseline`, `full`, …) and/or system adapters (`veyyon`, `omp`, `factory`, `hermes`) in any combination |
| `--model <id>` | Model identifier (defaults to `opencode/deepseek-ai/DeepSeek-V3.2`) |
| `--limit <n>` | Representative task limit sampled evenly across the task list |
| `--repeats <n>` | Number of samples per `(arm, task)` cell |
| `--jobs <n>` | Maximum parallel Docker container trial runs |
| `--out <dir>` | Output directory for artifacts and reports |
| `--binary <path>` | Pin a previous build of the `vey` binary |
| `--trial-timeout <sec>` | Override per-trial timeout in seconds |
| `--dry-run` | Validate preflight, stage configs, and print plan without launching Docker containers |
| `--systems <list>` | Legacy alias for `--arms` with system adapter names |
| `--replay-root <dir>` | Directory containing validated `<task>.json` replay manifests |
| `--factory-binary <path>` | Path to Droid/Factory binary for factory system comparison |
| `--reaggregate <dir>` | Re-parse trial results and regenerate `results.json` and `report.md` |
| `--merge <dirs>` | Pool multiple run directories into a combined report |
| `--system-comparison` | Legacy shorthand: `--arms` with all registered system adapters |
| `--run-dir <dir>` | Alias for `--reaggregate` |
| `--help`, `-h` | Show help message with all flags |

## Directory Structure

```
packages/deepswe-bench/
├── src/
│   ├── aggregate/       # Statistical tests (Wilson, sign test, Holm), usage tallying, report rendering
│   ├── runner/          # CLI parsing, preflight checks, arm staging, Pier execution queue
│   └── systems/         # Pluggable system adapter registry (Veyyon, Omp, Factory, Hermes)
├── arms/                # Configuration overlays (baseline.yml, candidate-*.yml)
├── tasks/               # Task lists with provenance headers (@headline, @biased)
├── pier_agent/          # Python container agents (veyyon_agent.py, omp_agent.py, etc.)
├── dicts/               # Repository vocabulary dictionaries (.AGENTS.dict)
├── fixtures/            # Static test fixtures and evaluation assets
└── docs/                # Extended documentation and authoring guides
```

## Documentation Guides

- [System Adapter Authoring Guide](docs/ADAPTER_AUTHORING.md): How to create and register new agent adapters.
- [Measurement & Analysis Tools](docs/MEASUREMENT_TOOLS.md): Token channel split, prefix caching, and headroom analysis.
- [Pier Agent Runtime Environment](pier_agent/README.md): Python agent container architecture.

## Testing

Run all unit tests in the sandbox:

```bash
bash scripts/test-sandbox/run.sh bun test packages/deepswe-bench
```

Run Python agent unit tests:

```bash
python3 -m unittest discover -s packages/deepswe-bench/pier_agent -p "*test.py"
```
