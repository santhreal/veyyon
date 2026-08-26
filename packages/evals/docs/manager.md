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
- `POST /api/runs`: Launch a run with parameters (benchmark, model, tasks, concurrency, attempts, jobName).
- `GET /api/runs/:name`: Run metadata and execution traces.
- `POST /api/runs/:name/cancel`: Cancel an active run.
- `DELETE /api/runs/:name`: Delete a completed run and on-disk job files.
- `POST /api/runs/:name/resume`: Resume incomplete run trials.
- `GET /api/runs/:name/traces/:trace[?raw=1]`: Fetch normalized or native execution trace.
- `GET /api/events`: Server-Sent Events stream for real-time status updates.

State is stored in `<jobs-dir>/_manager/evals.sqlite`.

## Harbor runner options

| Option | Default | Description |
|---|---|---|
| `-m, --model <provider/model>` | `anthropic/claude-sonnet-4-6` | Model identifier (repeatable). |
| `-l, --tasks <N>` | `20` | Maximum task count. |
| `-n, --concurrency <N>` | `4` | Concurrent container executions. |
| `-k, --attempts <N>` | `1` | Attempts per task (pass@k). |
| `-d, --dataset <name>` | `terminal-bench@2.0` | Harbor dataset identifier. |
| `-i/-x, --include/--exclude <glob>` | None | Task pattern filters (repeatable). |
| `--timeout-multiplier <x>` | None | Task timeout scaling factor. |
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

Results are placed within `<!-- bench-results:<key> -->` comment markers.

## Trace reports

Generate a markdown summary from a normalized execution trace:

```bash
bun packages/evals/src/report/trace-report.ts <run> <trace> [--focus "context"] [--out report.md]
```

Flags:
- `--base <url>`: Evaluation manager server base URL (default: `http://localhost:4700`).
- `--tiny <model>`: Per-turn summary model override.
- `--synth <model>`: Run-level synthesis model override.
- `--concurrency <N>`: Parallel generation workers (default: 8).

## Runtime notes

- Docker network access in Harbor task containers is limited to public registries; LLM requests route through the host gateway.
- Rust native addons must be compiled for the target platform architecture before running in container environments.
