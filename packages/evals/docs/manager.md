# Evaluation Run Manager

Evaluation run manager for benchmark suites in `@veyyon/evals`. Manages runs across Harbor, TypeScript edit, and DeepSWE suites using a shared SQLite store, REST/SSE API, and web dashboard.

## Suites and Backends

- `terminal-bench` (Harbor backend): Terminal-bench task execution via Harbor runner.
- `typescript-edit` (In-process backend): TypeScript edit benchmark via `src/suites/typescript-edit/adapter/cli.ts`.
- `deep-swe` (Pier backend): DeepSWE multi-arm evaluations via `src/suites/deep-swe/run.ts`.
## Usage

Start the dashboard server and API:

```bash
bun --cwd=packages/evals run serve --port 4700
```

## Harbor execution model

1. **Source execution:** Mounts repository source into task containers (`--install source`) to run `packages/coding-agent/src/cli.ts` without rebuilds.
2. **Credential routing:** Routes provider `baseUrl` entries to the host authentication gateway.
3. **Trial tracking:** Polls per-trial `result.json` files for status, token counts, and verifier results.

## Server API

- `GET /`: Dashboard and run launcher.
- `GET /api/experiments[?q=]`: Experiment list with optional substring filter.
- `POST /api/experiments`: Register experiment definition (`{ "id": "exp1", "goal": "..." }`).
- `GET /api/experiments/:id`: Experiment details, task matrix, and projections.
- `PUT /api/experiments/:id`: Update experiment metadata.
- `POST /api/experiments/:id/arms`: Launch a new arm inheriting configuration.
- `DELETE /api/experiments/:id`: Delete experiment and associated runs.
- `GET /api/runs[?experiment=&status=&benchmark=]`: List runs filtered by experiment, status, or benchmark adapter.
- `POST /api/runs`: Launch a run with parameters (benchmark, model, tasks, concurrency, attempts, jobName). A `jobName` that already names a run is rejected, whatever that run's status: resume it, delete it, or pick another name.
- `GET /api/runs/:name`: Run metadata and execution traces.
- `POST /api/runs/:name/cancel`: Cancel an active run. The response states whether anything was signalled; a run whose process is already gone reports `cancelled: false` and its status is reconciled from disk.
- `DELETE /api/runs/:name`: Delete a completed run and on-disk job files.
- `POST /api/runs/:name/resume`: Resume incomplete run trials.
- `GET /api/runs/:name/traces/:trace[?raw=1]`: Fetch normalized or native execution trace. A harbor trace links to the agent log the trial wrote, discovered from the trial's `agent/` directory rather than assumed, so a run of any harness links to its own `agent/<agent>.txt`. A trial whose `result.json` cannot be read is reported as an error naming the unreadable file, not as a trial still running.
- `GET /api/events`: Server-Sent Events stream for real-time status updates. A subscriber receives a comment frame every 15 seconds while the run list is unchanged, and is dropped once 256 frames go unread.

Every field of a mutating request body is checked before the request takes effect. An unknown field
is rejected by name, including inside a nested object; `tasks`, `concurrency` and `attempts` take an
integer >= 1; `timeoutMultiplier` a number > 0; `environment` one of `docker` or `apple-container`;
`role` one of `baseline`, `variant` or the empty string; an experiment `id` a token of
`[A-Za-z0-9_.]`. `POST /api/runs` requires `model`, `POST /api/experiments/:id/arms` requires `arm`
and `model`, `POST /api/experiments` requires `id`. A rejected body returns 400, names the field and
the reason, and changes nothing.

State is stored in `<jobs-dir>/_manager/evals.sqlite`.

A run with no owning process — one the CLI started, or one a previous manager left behind — takes its
status from its own job directory. A job result that states a finish time settles it. Otherwise the
newest write across the directory and its `result.json` decides: written within the last 30 minutes
the run stays `running`, since an orphaned runner may still be producing trials, and older than that
it becomes `complete` when its trial count reached the job's total and `failed` when it did not. The
recorded finish time is that write, never the time of the sync, and a directory carrying no usable
timestamp is not read as a live run.

## Harbor runner options

| Option | Default | Description |
|---|---|---|
| `-m, --model <provider/model>` | `anthropic/claude-sonnet-4-6` | Model identifier (repeatable). |
| `-l, --tasks <N>` | `20` | Maximum task count. |
| `-n, --concurrency <N>` | `4` | Concurrent container executions. |
| `-k, --attempts <N>` | `1` | Attempts per task (pass@k). |
| `-d, --dataset <name>` | `terminal-bench@2.0` | Harbor dataset identifier. |
| `-i/-x, --include/--exclude <glob>` | None | Task pattern filters (repeatable). |
| `--timeout-multiplier <x>` | None | Task timeout scaling factor, a number > 0. |
| `--agent-arg <arg>` | None | Arguments forwarded to the in-container CLI. |
| `--env <KEY[=VALUE]>` | None | Environment variables forwarded to container. |
| `--binary <path>` | None | Prebuilt CLI binary path. |
| `--install <source\|local\|published>` | `source` | Installation strategy (`source`, `local`, `published`). |
| `--environment <docker\|apple-container>` | `docker` | Container runtime engine. |
| `--gateway-url <url>` | `http://host.docker.internal:4000` | Host gateway URL. |
| `--no-gateway` | off | Use direct host API credentials. |
| `-o, --jobs-dir <path>` | `<repo>/runs/harbor` | Base directory for job outputs. |
| `--resume <name\|path>` | None | Resume an existing job directory. |
| `--filter-error-type <T>` | `CancelledError` | Error types to retry during resume. |
| `--dry-run` | off | Validate configuration and print commands without execution. |

`-l/--tasks`, `-n/--concurrency` and `-k/--attempts` take an integer >= 1, and
`--timeout-multiplier` a number greater than zero. A value outside that refuses the invocation
instead of reaching harbor as `null` or reaching the deadline as an ignored multiplier.
`--job-name` is one directory name under the jobs directory. `--env KEY` forwards the host value
and refuses when the host sets no `KEY`; `--env KEY=VALUE` states the value and never reads the
host. A wrong invocation exits 2, a failed gateway health check 3, and a harbor run that failed
returns harbor's own exit code.

## Outputs

- `<jobs-dir>/<jobName>/`: Individual trial directories and `result.json` files.
- `<jobs-dir>/_bench/<jobName>/report.md`: Markdown summary table.
- `<jobs-dir>/_bench/<jobName>/harbor.log`: Raw Harbor execution log.
- `<jobs-dir>/_manager/logs/<jobName>.log`: API runner log output.

## Documentation insertion

Insert benchmark results into markdown documentation:

```bash
bun packages/evals/src/report/bench-report.ts --run <jobName> --doc docs/argot.md [--key argot]
```

Results are placed within `<!-- bench-results:<key> -->` comment markers. A re-run replaces the
block between that pair. A key holds letters, digits, `.`, `_` or `-`; anything else is rejected
with exit 2, because a key that closes its own comment early leaves a pair the next run cannot
find. A doc with no marker pair takes the block at the end of its `## Benchmark results` section,
or gains that heading when it states none.

## Trace reports

Generate a markdown summary from a normalized execution trace:

```bash
bun packages/evals/src/report/trace-report.ts <run> <trace> [--focus "context"] [--out report.md]
```

Flags:
- `--base <url>`: Evaluation manager server base URL (default: `http://localhost:4700`).
- `--tiny <model>`: Per-turn summary model override.
- `--synth <model>`: Run-level synthesis model override.
- `--concurrency <N>`: Parallel generation workers (default: 8). A value that is not a positive
  integer ends the invocation with exit code 2 before the trace is fetched.
- `--out <file>`: Write the report here instead of stdout.
- `--focus <text>`: Question the synthesis answers.

The run and the trace are positional, and one argument holding both (`"<run>|<trace>"`) is accepted
because that is how the dashboard spells a trace link. A third positional, an undeclared flag, or a
valued flag given without its value ends the invocation with exit code 2 and the usage text.

## Runtime notes

- Docker network access in Harbor task containers is limited to public registries; LLM requests route through the host gateway.
- Rust native addons must be compiled for the target platform architecture before running in container environments.
