# Evaluation Guide

Step-by-step workflows for running DeepSWE evaluations with the benchmark harness.

## Prerequisites

1. **Docker** with `docker compose` available.
2. **Pier** installed: `uv tool install datacurve-pier`.
3. **Bun** runtime for the harness.
4. **OpenCode API key** for models routed through OpenCode (DeepSeek, Muse Spark, etc.).
5. **A veyyon binary** at `packages/coding-agent/dist/vey` (build with `bun --cwd=packages/coding-agent run build` or pin with `--binary`).

### Seeding auth credentials

The harness reads API keys from `~/.veyyon/shared-auth/agent.db`. If you have a veyyon auth store with the OpenCode provider configured, it is seeded automatically. To pass the key explicitly:

```bash
export OPENCODE_API_KEY=sk-...
# or
bun src/suites/deep-swe/run.ts --opencode-key sk-... --arms baseline --tasks datasets/deep-swe/tasks/smoke.txt
```

## Workflow 1: Smoke test

Validates the full pipeline on a single task. Use this after any harness change to confirm staging, auth, Pier, and the verifier all work.

```bash
bun src/suites/deep-swe/run.ts --tasks datasets/deep-swe/tasks/smoke.txt --arms baseline --jobs 1
```

Expected duration: 5 to 30 minutes depending on model latency and task difficulty.

Check the result:

```bash
# Read the report
cat runs/<latest>/report.md

# Check the verifier reward
cat runs/<latest>/jobs/baseline__ytt-jsonpath-query-api__r0/*/verifier/reward.json
```

## Workflow 2: Feature comparison

Compares a baseline arm against a candidate arm across the pilot task set. Each arm overrides one variable (prompt section, feature flag, tool description, etc.).

```bash
# Baseline vs full (argot encode + decode)
bun src/suites/deep-swe/run.ts --tasks datasets/deep-swe/tasks/pilot-10.txt --arms baseline,full --jobs 2 --repeats 2

# Baseline vs a single prompt change
bun src/suites/deep-swe/run.ts --tasks datasets/deep-swe/tasks/pilot-10.txt --arms baseline,candidate-bash-trim --jobs 2

# Dry run first to validate configs
bun src/suites/deep-swe/run.ts --tasks datasets/deep-swe/tasks/pilot-10.txt --arms baseline,full --dry-run
```

The report includes:

- Per-arm pass rate with Wilson 95% confidence intervals.
- Paired sign test with Holm-Bonferroni correction across all arm pairs.
- Per-task breakdown showing which tasks each arm passed or failed.
- Token usage and cost comparison.

## Workflow 3: Cross-system comparison

Runs different agent binaries (veyyon, omp, factory, hermes) on the same tasks and model. System adapters can be mixed with config arms.

```bash
# veyyon baseline vs omp
bun src/suites/deep-swe/run.ts --arms baseline,omp \
  --model opencode-go/deepseek-v4-flash \
  --tasks datasets/deep-swe/tasks/pilot-10.txt \
  --jobs 2 --repeats 2

# Pin a specific veyyon binary
bun src/suites/deep-swe/run.ts --arms baseline,omp \
  --model opencode-go/deepseek-v4-flash \
  --binary packages/coding-agent/dist/vey \
  --omp-binary ~/.bun/bin/omp \
  --tasks datasets/deep-swe/tasks/pilot-10.txt
```

### Fairness

Both arms receive the same `model_name` in their job config. The harness does not alter the model between arms. Trial timeout is identical (default 1800s, override with `--trial-timeout`).

### Omp model resolution

Omp's release binary does not have veyyon's synchronous model discovery fallback. For dynamically-discovered models (not in omp's bundled catalog), the harness builds a `models.yml` with full metadata using the veyyon binary's models.dev overlay and stages it as an optional asset of omp's container program; the program's setup step copies it to `~/.omp/agent/models.yml`. This bypasses omp's background discovery race entirely.

## Workflow 4: Headline evaluation

Use the unbiased `diverse-20` task set for headline numbers. This set spans Go, TypeScript, and Python with no feature-favoring curation.

```bash
bun src/suites/deep-swe/run.ts --tasks datasets/deep-swe/tasks/diverse-20.txt --arms baseline,full --jobs 4 --repeats 3
```

The report header carries `@headline` provenance, confirming the numbers are suitable for publication.

## Workflow 5: Re-aggregate or merge runs

Re-parse trial results from an existing run without re-executing trials. Useful after changing the aggregation logic or report format.

```bash
bun src/suites/deep-swe/run.ts --reaggregate runs/2026-08-01T12-00-00
```

Merge multiple runs into a combined report:

```bash
bun src/suites/deep-swe/run.ts --merge runs/day1,runs/day2 --out runs/merged
```

## Choosing a task set

| Task set | Tasks | When to use |
|---|---|---|
| `smoke.txt` | 1 | After harness changes; validates plumbing |
| `pilot-10.txt` | 10 | Feature stress testing; hardest tasks by patch size |
| `diverse-20.txt` | 20 | Headline numbers; unbiased held-out set |
| `holdout-10.txt` | 10 | Out-of-sample evaluation |
| `argot-10.txt` | 10 | Argot shorthand encoding evaluation |

Task lists with `@biased` headers are not suitable for headline reporting. The report renders a warning when a biased set is used.

## Choosing a model

| Model | Provider | Notes |
|---|---|---|
| `opencode-go/deepseek-v4-flash` | OpenCode | Fast, cheap, good for iteration |
| `opencode-go/deepseek-v4-pro` | OpenCode | Higher quality, higher cost |
| `opencode-go/muse-spark-1.2-contributor` | OpenCode | Requires data collection opt-in |

Models not in the bundled catalog require a `models refresh` before the agent can resolve them. The veyyon binary handles this with a synchronous discovery fallback. For omp, the harness generates a `models.yml` with full metadata.

## Interpreting the report

### Per-arm totals

The top table shows each arm's pass rate with a Wilson 95% confidence interval, mean reward (partial credit), token usage, cost, and wall time. Trials that errored (infrastructure failure, timeout, crash) are excluded from the pass rate denominator but counted as `+N err`.

### Paired comparison

The arm comparison table shows the delta in pass rate between pairs of arms, averaged over tasks both arms ran. The verdict uses a two-sided exact sign test over per-task wins/losses. `adj p` is the Holm-Bonferroni-corrected p-value across all arm pairs in the run.

At small task counts, trust the sign test over the confidence interval. A verdict of "not distinguishable (underpowered)" means the sample size is too small to reach significance, not that the arms are equivalent.

### Error classification

Trials that error are classified by type:

- `timeout`: Trial exceeded the time limit.
- `crash`: Agent process crashed (e.g. GLIBC, native addon).
- `dns`: DNS resolution failure inside the container.
- `auth`: API authentication failure.
- `server`: Upstream API returned 5xx.
- `unknown`: Unclassified error.

## Cleaning up Docker resources

Each trial creates Docker networks and containers. Stale resources from previous runs accumulate and can exhaust Docker's address pools:

```bash
# Remove stopped eval containers
docker ps -a --format '{{.Names}}' | grep -E 'ytt-jsonpath|httpx-streaming' | xargs -r docker rm -f

# Remove stale pier-egress networks
docker network ls --filter "name=pier-egress" -q | xargs -r docker network rm

# Full Docker cleanup (reclaims disk)
docker system prune -f
```
