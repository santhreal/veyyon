# @veyyon/deepswe-bench

Benchmark harness for evaluating Veyyon features against DeepSWE tasks. It runs the agent across configuration arms in isolated Docker containers and reports verifier reward, token usage, cost, and wall time.

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
| Encoding | `decode` ↔ `full` | Model allowlist and preamble |
| Dictionary budget | `full` ↔ `full-budget16k` | `argot.tokenBudget` (1000 vs 16000) |
| Tool discovery | `baseline` ↔ `discovery-all` | `tools.discoveryMode` |
| Output spill floor | `spill-control` ↔ `baseline` ↔ `spill-tight` | `tools.inlineOutputFloor` (1 vs 0.25 vs 0.1) |
| Signature max length | `baseline` ↔ `sig-max4000` | `context.thoughtSignatureMaxLength` (none vs 4000) |
| Artifact spill threshold | `baseline` ↔ `spill2kb` | `tools.artifactSpillThreshold` (50 KB vs 2 KB) |
| Signature retention | `baseline` ↔ `sig-last8` ↔ `sig-last1` | `context.thoughtSignatureRetention` (all vs 8 vs 1) |
| Thinking retention | `baseline` ↔ `think-last1` | `context.thinkingRetention` (all vs 1) |
| Model | Any arm across `--model` values | `--model` |

## Prompt prefix measurement

Run `prefix-composition.ts` to inspect prefix composition across session transcripts:

```bash
bun prefix-composition.ts runs/<run-id>/jobs           # baseline arm
bun prefix-composition.ts runs/<run-id>/jobs sig-last1__
```

The script measures prefix mass in character-turns (one character present in the prompt across one turn).

Baseline distribution (20 tasks, 2026-07-25):

| Component | Share |
|---|---|
| Thought signatures | 37.5% |
| Tool results | 26.3% |
| System prompt and tool schemas | 17.4% |
| Thinking | 9.0% |
| Tool-call arguments | 8.3% |
| Assistant text | 0.9% |
| User text | 0.6% |

Tool result spill simulations:

| Spill threshold | Share of bill (Gemini) | Share of bill (Claude) | Results spilled (Claude) |
|---|---|---|---|
| 50 KB (default) | 0.5% | 0.0% | 0% |
| 10 KB | 3.3% | 8.5% | 3% |
| 5 KB | 4.9% | 13.5% | 6% |
| 2 KB | 9.2% | 26.1% | 23% |
| 1 KB | 12.5% | 33.9% | 35% |

Thought signature length cap simulations:

| Cap | Share of prefix | Share of bill | Tool calls losing signature |
|---|---|---|---|
| 8,000 chars | 20.9% | 17.9% | 8% |
| 4,000 chars | 26.6% | 22.8% | 15% |
| 2,000 chars | 30.4% | 26.0% | 24% |
| 1,000 chars | 33.1% | 28.3% | 38% |

Prefix cache invalidation by lever:

| Lever | Turns keeping prefix intact | Tail invalidated | Share of bill |
|---|---|---|---|
| stock | 100.0% | 0.0% | 0.0% |
| sig-max4000 | 100.0% | 0.0% | 0.0% |
| sig-last1 | 1.9% | 1.1% of prefix | 0.7% |
| sig-last5 | 5.4% | 5.9% of prefix | 3.8% |

## Channel split and retype measurements

Measure line-structure distribution across channels:

```bash
bun measure-channel-split.ts                    # active profile
bun measure-channel-split.ts --sessions <dir>   # specific transcript directory
bun measure-channel-split.ts --json             # JSON output
```

Measure dictionary handle emission frequency:

```bash
bun measure-retype-likelihood.ts --repo <dir>
bun measure-retype-likelihood.ts --sessions <dir>
bun measure-retype-likelihood.ts --json
```

## Prerequisites

1. Clone tasks into this package:
   ```bash
   git clone --depth 1 https://github.com/datacurve-ai/deep-swe
   ```
2. Install Pier and verify Docker is running:
   ```bash
   uv tool install datacurve-pier
   ```
3. `run.ts` compiles `dist/vey` if out of date and stages credentials to `assets/auth-agent.db`.

## Running

```bash
cd packages/deepswe-bench
bun run.ts \
  --tasks tasks/smoke.txt \
  --arms baseline,decode,full \
  --model google-antigravity/gemini-2.5-flash \
  --jobs 2 \
  --repeats 1 \
  --out ../../runs/deepswe/argot-smoke
```

Start with `--dry-run`. The first paid run uses `tasks/smoke.txt` and one repeat. Increase the task set or repeat count only after reviewing the exact trial count printed by the dry run.

### Options

- `--tasks <file>`: Newline-delimited list of task names. Omit to run all tasks.
- `--tasks-root <dir>`: Override tasks directory (default: `deep-swe/tasks`).
- `--reaggregate <runDir>`: Rebuild `results.json` and `report.md` from raw trial data.
- `--arms <a,b,c>`: Comma-separated list of `arms/*.yml` overlays.
- `--limit N`: Uniformly sample N tasks across the task list.
- `--dry-run`: Validate configurations, arms, and auth without running containers.
- `--trial-timeout S`: Wall-clock timeout per trial in seconds (defaults to task definition).
- `--jobs N`: Concurrent Pier container runs.
- `--model <provider/id>`: Model identifier under test.
- `--repeats K`: Number of samples per (arm, task) cell (default: 1).
- `--binary <path>`: Use an existing compiled `vey` binary instead of rebuilding.
- `--merge <runA,runB>`: Pool results across runs with matching arms, models, and binaries.

System comparison (`--systems`) replaces `--arms` and runs the other agents beside Veyyon on the
same tasks. The two are mutually exclusive, and every path below is required in that mode:

- `--systems <a,b,c>`: Comma-separated system names to compare instead of arm overlays.
- `--replay-root <dir>`: Directory holding one validated `<task>.json` real-session manifest per task.
- `--factory-binary <path>`: Factory CLI binary. Defaults to `droid` on `PATH`.
- `--factory-auth <file>`: Non-empty file holding the Factory API key.
- `--factory-settings <file>`: Factory settings file. Optional.
- `--hermes-auth <file>`: Non-empty `.env` file holding the Hermes credentials.

### Output structure

A run directory contains:
- `jobs/`: Raw Pier task logs, trajectories, and verifier reports.
- `assets/`: Staged `vey` binary, auth database, and arm overlays.
- `results.json`: Machine-readable metrics.
- `report.md`: Summary tables.

## Metrics

- **pass rate [95% CI]**: Fraction of samples with verifier reward 1.0, with Wilson 95% confidence intervals.
- **mean reward**: Average continuous verifier score across samples.
- **input / output / cache tok**: Total tokens recorded by session accounting.
- **cost USD**: Total cost, or `unpriced` when provider does not report token costs.
- **agent wall**: Execution time in seconds within the agent phase.
- **Arm comparison**: Paired exact sign test per task, with Holm-Bonferroni correction across pairs (`adj p < 0.05`).
- **Reward comparison**: Paired sign test on continuous mean reward.
- **Efficiency comparison**: Paired sign test on output tokens and cost, conditioned on non-inferior reward.
- **Tool call distribution**: Mean calls per completed run by tool.
- **Errors**: Breakdown of failed trials by category (timeout, exit code, missing verifier result).

## Prompt section arms

To override a single prompt section, create `arms/<arm>.sections.yml` alongside `arms/<arm>.yml`:

```yaml
# arms/candidate-delivery-terse.sections.yml
deliveryContract: |
  Report the outcome and nothing else. State what changed, in which files, and
  whether it is verified.
```

Run with:

```bash
bun run.ts --arms baseline,candidate-delivery-terse \
  --tasks tasks/pilot-10.txt \
  --model google-antigravity/gemini-3.5-flash \
  --jobs 2 --repeats 1
```

Available section names: `conventions`, `role`, `runtime`, `toolPolicy`, `executionWorkflow`, `deliveryContract`.

## Prompt statement arms

To ablate or override a specific statement, create `arms/<arm>.statements.yml`:

```yaml
# arms/candidate-ablate-lsp-preference.statements.yml
tool-policy/lsp: null
```

List statement identifiers using:

```bash
veyyon prompt --statements
veyyon prompt --statement <id>
```


## Prompt registry arms

To override a prompt from the prompt registry (such as a tool description, subagent prompt, or agent prompt), create `arms/<arm>.prompts.yml` alongside `arms/<arm>.yml`:

```yaml
# arms/candidate-bash-trim.prompts.yml
tools/bash: |
  Runs commands in the embedded shell — terminal ops: git, bun, cargo, python.
```

A prompt experiment cannot be run by editing prompt files directly in the repository. Both arms of a benchmark run execute against a single built binary, so modifying a file in the tree applies the change to all arms simultaneously and leaves any measured delta without an identifiable cause.

List prompt identifiers using:

```bash
veyyon prompt --prompts
veyyon prompt --prompt <id>
```