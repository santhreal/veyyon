# Repository Guidelines

## Project Overview

`veybot` is a self-hosted GitHub triage-and-fix bot that drives [`veyyon --mode rpc`](https://github.com/santhreal/veyyon) as a subprocess. On every issue opened in an allowlisted repository it classifies the issue, applies labels, then branches into one of: reproduce → fix → PR (`bug` / `documentation`), single-comment answer (`question`), single thoughtful comment (`enhancement` / `proposal`), or brief comment (`invalid` / `duplicate`). Follow-up comments and PR review comments resume the same veyyon session so the agent keeps its prior reasoning. If the orchestrator restarts mid-task, the dispatcher resumes the same session via `veyyon --continue` from the per-issue `session_dir`, so an interrupted task re-enters its prior reasoning instead of restarting from scratch. The orchestrator runs as a single FastAPI process inside Docker with SQLite-backed durable event state.

Two task kinds run without a live webhook behind them. `port_upstream` turns one `upstream-port` tracking issue, filed by `scripts/upstream-radar.ts`, into one candidate pull request adapted to veyyon's diverged architecture. `ci_repair` fixes a candidate whose checks went red, on the same branch, at most `VEYBOT_CI_MAX_REPAIRS` times per head commit. Both stop at the candidate. **There is no merge path anywhere in this tree and there must never be one.** Its absence is a load-bearing guarantee, not an oversight: a human reviews and merges every candidate. See "Upstream port pipeline" below and `README.md` for the operator view.

## Architecture & Data Flow

Webhook → durable queue → async dispatcher → per-issue git worktree → veyyon RPC subprocess + host tools.

1. `POST /webhook/github` — HMAC-SHA256 verified against `GITHUB_WEBHOOK_SECRET` (`server.py` + `github_events.verify_signature`). Bad signature returns `401`.
2. `github_events.route()` decides one of `triage_issue` / `handle_comment` / `handle_pr_conversation` / `handle_review` / `cleanup_workspace` / `skip`. Bot-authored events (`*[bot]`, `user.type == "Bot"`, configured `bot_login`) and non-allowlisted repos are dropped here.
3. `db.record_event()` inserts the event with `INSERT OR IGNORE` on `X-GitHub-Delivery` (dedup). Endpoint returns `202`.
4. `queue.WorkerPool._dispatch_loop` atomically claims `state='queued'` rows under `BEGIN IMMEDIATE`, guarded by an in-process `_inflight` set keyed by `(owner, repo, number)` to serialize per-issue work. Cap: `VEYBOT_MAX_CONCURRENCY` (default 8).
5. `sandbox.SandboxManager.ensure_workspace()` produces a worktree at `/data/workspaces/<owner>__<repo>__<n>/repo` on a deterministic branch `farm/<8hex>/<slug>`, backed by a shared `--filter=blob:none` clone pool. Credentialed remote URL and git identity are reset every time.
6. `tasks.*` dispatchers build `TaskInputs` and call `worker.run_task()` which spawns `veyyon --mode rpc` with `cwd=worktree`, persistent `session_dir`, and a randomly-picked model from `VEYBOT_MODEL` (CSV pool). When `<session_dir>/*.jsonl` already exists the worker passes `--continue`, so both follow-up events and crash-restarted events resume the same session.
7. Inside the subprocess the agent uses **built-in veyyon tools** (read/edit/write/bash/lsp, scoped to the worktree) and **host tools** from `host_tools.py` (the only surface allowed to mutate GitHub or write audit rows).
8. Success → event `state='done'`. Exception → `state='failed'` with a credential-redacted traceback in `events.last_error`. The `_inflight` slot is released either way.

## Upstream Port Pipeline

Two task kinds have no live webhook behind them.

**`port_upstream`.** `scripts/upstream-radar.ts` mirrors every newly merged `can1357/oh-my-pi` PR that survives `scripts/upstream-port-policy.json` into ONE issue on `santhreal/veyyon` labeled `VEYBOT_PORT_LABEL` (default `upstream-port`). veybot turns each into ONE candidate PR adapted to veyyon's diverged architecture. Prompts: `kickoff_port_upstream.md`, with `{{kind_guidance}}` filled from `port_guidance_fix.md` or `port_guidance_feature.md` and `{{prior_failure_block}}` filled from `port_prior_failure.md` or the empty string. The fix arm requires a failing negative control before implementation and a reverted-fix check after; the feature arm requires an off-versus-on differential through the real operator path. Not applicable ends at `mark_unable_to_reproduce`, not at a comment.

**`ci_repair`.** A candidate whose checks go red is repaired in place on the same branch, at most `VEYBOT_CI_MAX_REPAIRS` times per head commit (default 3). A new push resets the counter. Prompt: `kickoff_ci_repair.md`; the give-up comment is `ci_repair_exhausted.md`. Weakening a gate is never an acceptable outcome, and the prompt says so explicitly: if the only way to pass is to weaken the gate, the task reports failure and pushes nothing.

**Backlog drain.** The radar issues predate the bot, so `route()` will never see them. `manual_triage.enqueue_port_backlog` lists open labeled issues and writes synthetic `issues.labeled` rows straight into the events table, exactly as `enqueue_manual_triage` does for `issues.opened`. Delivery ids come from `port_backlog_delivery_id(repo, number)`, so re-running is idempotent; an issue already in the events table is skipped whether a prior drain or a live webhook put it there. CLI: `veybot port-backlog owner/repo [--limit N] [--dry-run]`, or `bun run veybot:backlog`.

**Kill switches.** `VEYBOT_PORT_UPSTREAM_ENABLED` and `VEYBOT_CI_REPAIR_ENABLED`, both default `True`, following the `pr_review_enabled` pattern (`config.py` -> `server.py` -> `route()`). `VEYBOT_AGENT_PROFILE` (default empty) appends `--profile <value>` to the veyyon invocation.

<critical>
- **NEVER add a merge or auto-merge capability.** Not a host tool, not a task, not a CLI flag, not a "just for candidates that are green" special case. Its absence is the guarantee that makes an unattended port bot safe to run, and the prompts promise the reviewer it does not exist.
- **NEVER teach a prompt to weaken a gate.** No skip, no threshold drop, no lint ignore, no `.github/` edit. A green check bought that way is worse than a red one.
- **veybot is the only worker on the `upstream-port` queue.** Its predecessor was removed for exactly this reason: two workers on one queue give an issue two candidates. Do not add a second one.
</critical>

## Key Directories

- `src/` — package (see "Important Files").
- `src/prompts/` holds the `{{dotted.path}}` templates `persona.py` loads via `@cache` and `importlib.resources`. Shipped as package data (`pyproject.toml` `package-data`). **Substitution only.** `persona._PLACEHOLDER` matches `[a-zA-Z0-9_.]` and nothing else, so there are no conditionals, no loops, and no filters. A `{{#if}}` or `{{& raw}}` survives rendering verbatim and reaches the model as literal template syntax. An unresolvable path renders as the empty string, never an error, so a renamed field ships a prompt with a silent hole. Branching is precomputed in Python and passed in as a ready-made block string; `kickoff_port_upstream.md`'s `{{kind_guidance}}` and `{{prior_failure_block}}` are the worked examples. Lists join with `", "`, so a bullet list must arrive pre-rendered (`{{failing_list}}`).
- `tests/` — pytest suite. `test_worker_smoke.py` is gated on `VEYBOT_INTEGRATION=1`.
- `data/` — runtime state (sqlite + WAL, `workspaces/`, `logs/`). Never committed.
- `/Dockerfile` (repo root) — produces `veyyon:dev` (veyyon runtime image: python + bun + rustup + veyyon-natives + veyyon_rpc + `/usr/local/bin/veyyon` shim + the full veyyon source under `/veyyon`). Stages: `natives-builder` → `wheel-builder` → `base` → `runtime` (default). Built via `bun run docker:build`. Veybot's image extends `base` via `FROM ${VEYYON_BASE}` in `/Dockerfile.veybot`.

## Development Commands

Task runner is `bun` against the **monorepo root** `package.json`. veybot itself no longer ships a `package.json`; every recipe lives at the root under the `veybot:*` namespace. Local venv (no docker): `bun run veybot:install` runs `pip install -e 'python/veybot[dev]'`. From there:

```
bun run test:py                   # pytest -x python/veyyon-rpc/tests python/veybot/tests
bun run veybot:test:integration   # VEYBOT_INTEGRATION=1, requires veyyon on PATH
bun run veybot:serve              # python -m veybot serve on the host
```

Docker inner loop:

```
bun run docker:build              # build veyyon:dev (one-time / on veyyon change)
bun run docker:run                # docker run -it veyyon:dev (smoke-test the shim)
bun run veybot:build              # docker:build (if veyyon changed) + docker compose build
bun run veybot:dev                # build + up -d + follow logs
bun run veybot:up / veybot:down / veybot:restart / veybot:logs
bun run veybot:rebuild            # docker compose build --no-cache
bun run veybot:reset              # `down -v` + drop the veyyon image
```

Frontend (Vite + SolidJS, in `web/` — still a bun workspace):

```
bun run veybot:web:dev            # vite dev server with proxy to :8080
bun run veybot:web:build          # produce src/static/ bundle
bun --cwd=python/veybot/web run typecheck   # tsc --noEmit
```

In-container CLI (`veybot` console script → `veybot.cli:main`): no root aliases — invoke directly:

```
docker compose --project-directory python/veybot exec veybot veybot triage owner/repo#N
docker compose --project-directory python/veybot exec veybot veybot replay <delivery_id>
docker compose --project-directory python/veybot exec veybot veybot status
docker compose --project-directory python/veybot exec veybot veybot cleanup owner/repo#N
docker compose --project-directory python/veybot exec veybot veybot port-backlog owner/repo --limit 10
```

HTTP / sqlite / webhook inspection is unaliased — use `curl http://localhost:${VEYBOT_BIND_PORT:-8080}/{healthz,readyz,events,issues}` and `docker compose --project-directory python/veybot exec veybot sqlite3 /data/veybot.sqlite` directly.

Lint + format: TypeScript via Biome (config in `biome.json`), Python via Ruff (config in `pyproject.toml`). Root recipes cover both languages — `bun run lint` / `bun run fix` apply to the whole monorepo including veybot. `bun run lint:py` / `bun run fix:py` scope to Python only.

## Code Conventions & Common Patterns

- **Python ≥3.11**, container is 3.12-slim. `from __future__ import annotations` is the norm; type hints are mandatory on public functions.
- **Records**: prefer `@dataclass(slots=True, frozen=True)` for immutable value types (see `github_client.IssueInfo`, `sandbox.Workspace`, `db.EventRow`).
- **Async style**: FastAPI handlers and `queue.WorkerPool` are async. `worker.run_task` is **synchronous** and runs in a worker thread because `veyyon-rpc` is blocking — keep it that way; don't try to async it. CLI commands wrap with `asyncio.run`.
- **Config**: `pydantic-settings` `Settings` in `config.py` with `VEYBOT_*` env prefix (e.g. `VEYBOT_MAX_CONCURRENCY`, `VEYBOT_REPO_ALLOWLIST`). Access only via `get_settings()` (`@cache` singleton). Tests must call `reset_settings_cache()` after mutating env.
- **Dependency injection**: pass `Settings`, `Database`, `GitHubClient`, `SandboxManager` explicitly into `create_app()`, `WorkerPool`, and `ToolBindings`. No module-level globals other than the singleton accessors (`get_settings`, `get_database`).
- **State**: SQLite (`db.Database`) is the source of truth for `events`, `issues`, `tool_calls`. Thread-safe via an internal `_lock`; `BEGIN IMMEDIATE` for claim contention. In-memory state is only the `_inflight` set in `WorkerPool`.
- **Error handling**: custom exception types (`GitHubError` with `retry_after`, `GitCommandError`, `InvalidIssueRef`, `RpcCommandError`). `sandbox.redact_credentials()` strips `user:pass@` from any URL before it lands in logs, audit rows, or exception messages. **Never** include credentialed URLs in error strings.
- **Logging**: structured JSON via `logging_config.JsonFormatter`. Use `logger.info("event", extra={...})`; do not collide with `_RESERVED` keys. Configure once via `configure_logging()`.
- **Host tools** (`host_tools.py`): every tool is built from a per-task `ToolBindings` closure and audits through `_audit()` into `tool_calls`. Audit only ever sees agent-supplied args, never internal credentials. New tools follow the same pattern: validate args → call `GitHubClient` / `SandboxManager` → return structured dict → audit.
- **Naming**: snake_case for everything Python; module names singular nouns; test files `test_<module>.py`; test functions `test_<action>_<condition>`.
- **Prompts**: edit `src/prompts/*.md`. Variables use `{{path.to.field}}`; resolution is `persona._lookup`. The package install includes them as data files — adding a new prompt requires no other registration.

## Important Files

- `src/server.py` — FastAPI app, `/webhook/github`, `/healthz`, `/readyz`, `/events`, `/issues`, manual triage/replay endpoints, dashboard at `/`.
- `src/queue.py` — `WorkerPool` dispatcher and `_inflight` serialization.
- `src/tasks.py` holds the task entry points the dispatcher calls. A dispatchable task is `async def name(*, settings, db, github, sandbox, git_transport, payload, delivery_id, attempts=0, slot_uid=None) -> None`; its return value is discarded and raising is the only failure channel.
- `src/worker.py` — synchronous veyyon RPC driver, prompt assembly via `persona`.
- `src/host_tools.py` — agent's GitHub surface; tool list: `classify_issue`, `set_issue_labels`, `gh_post_comment`, `repro_record`, `gh_push_branch`, `gh_open_pr`, `gh_request_review`, `mark_unable_to_reproduce`, `abort_task`, `fetch_issue_thread`.
- `src/sandbox.py` — clone pool + worktree lifecycle, `GitCommandError`, credential redaction.
- `src/github_client.py` — typed httpx client; parses webhook payloads into `IssueInfo` / `CommentInfo` / `PullRequestInfo`.
- `src/github_events.py` — routing and HMAC verification.
- `src/db.py` — sqlite schema and DAOs (`record_event`, `claim_next_event`, `upsert_issue`, `log_tool_call`).
- `src/config.py` — `Settings` model and `get_settings()`.
- `src/cli.py` is the Click CLI (`serve`, `triage`, `replay`, `status`, `cleanup`, `port-backlog`).
- `src/manual_triage.py` synthesizes webhook payloads and writes them straight into the events table, bypassing `route()`. `enqueue_manual_triage` backs `veybot triage`; `enqueue_port_backlog` backs `veybot port-backlog`. This is the template for enqueueing work no live webhook will ever deliver.
- `src/dashboard.py` — single-page HTML dashboard served from `/`.
- `pyproject.toml` — packaging + pytest config (`asyncio_mode = "auto"`, `testpaths = ["tests"]`).
- `/Dockerfile.veybot` (repo root) — veybot's image. `FROM ${VEYYON_BASE}` (default `veyyon:dev`), adds the SolidJS dashboard bundle, the veybot Python package, and the `veybot-entrypoint` shim. Tini entrypoint, exposes `8080`, `VOLUME /data`. The toolchain (python + bun + rustup + veyyon-natives + veyyon_rpc + `veyyon` shim) comes from `base` — no duplication in this file.
- `docker-compose.yml` — `build.args.VEYYON_BASE`, mounts `$VEYYON_ROOT:/work/veyyon:ro`, `./data:/data`, and the read-only `~/.agent` staging pair, `extra_hosts: llm-gateway.internal:host-gateway`. `models.yml` is deliberately NOT mounted: `src/agent_models.py` generates it from `VEYBOT_LLM_*`, so routing stays in `.env`, a fresh machine needs no hand-written host file, and compose cannot fail on a missing mount source. The dashboard is published on `127.0.0.1:6543` only: the webhook route checks its HMAC but `/` and the issue-browser API have no auth, so a wider publish exposes them to the whole LAN/tailnet. Reach it over an SSH tunnel.
- `entrypoint.sh` — validates `VEYYON_ROOT`, creates `/data/{workspaces,logs}` + build caches.
- `.env.example` — authoritative list of runtime env vars, all of them, with real defaults. `Settings` runs `extra="forbid"`, so a key here that is not a declared field in `src/config.py` is a startup error naming the key; adding a setting means adding it to both, and `tests/test_env_example_documents_settings.py` fails otherwise. `_ProxyEnvLoader` keeps `extra="ignore"` on purpose: it declares only gh-proxy's slice of the same shared file.
- `src/config.py` — the ONLY module that reads the environment. Nothing else calls `os.environ`/`getenv`; keep it that way, since it is what makes `.env` a single authoritative surface. The "Project adaptation" block (`VEYBOT_PROJECT_MARKERS`, the bootstrap command/timeout, `VEYBOT_PRE_PR_FIX_COMMAND`, `VEYBOT_PRE_PR_CHECK_COMMAND`, `VEYBOT_SLOT_EXTRA_GROUP`) is what lets veybot service a project with a toolchain other than bun; `host_tools.py` resolves those through `_configured`/`_publish_step_argv` and holds no command literals of its own.
- `src/agent_models.py` — generates the agent's `~/.veyyon/agent/models.yml` from `VEYBOT_LLM_BASE_URL` / `VEYBOT_LLM_API_KEY` / `VEYBOT_LLM_API` / `VEYBOT_LLM_PROVIDER_ID` plus the `VEYBOT_MODEL` pool. Called from `worker._build_extra_env`, after staging so it wins over a stale copied file and on every launch so a model change cannot leave stale routing. The `apiKey` field holds the NAME `VEYBOT_LLM_API_KEY`, which veyyon resolves from the environment, so the credential never lands on disk; an empty `VEYBOT_LLM_BASE_URL` means veybot does not manage routing and writes nothing.
- `README.md` — full architecture + operational reference. Authoritative for end-to-end flow, host-tool spec, security posture, and configuration reference.

## Runtime/Tooling Preferences

- **Python**: 3.11+ source target, 3.12 in container. Setuptools src layout (`pyproject.toml` `[tool.setuptools] package-dir = { "" = "src" }`).
- **Package manager**: `pip` only. No poetry / uv / pdm files; don't introduce one.
- **Task runner**: `bun` (root `package.json` `scripts`). Always reach for an existing `bun run` recipe before invoking `docker compose` or `pytest` directly.
- **Container runtime**: Docker Compose v2. The image embeds Bun 1.3.14 + a rustup launcher and exposes `veyyon` via a `/usr/local/bin/veyyon` shim; `VEYBOT_AGENT_COMMAND=veyyon` should not need changing.
- **Required env** (set in `.env`, see `.env.example`): `GITHUB_WEBHOOK_SECRET`, `VEYBOT_BOT_LOGIN`, `VEYBOT_GIT_AUTHOR_NAME`, `VEYBOT_GIT_AUTHOR_EMAIL`, `VEYBOT_REPO_ALLOWLIST`, plus model knobs (`VEYBOT_MODEL`, `VEYBOT_THINKING`, optional `VEYBOT_PROVIDER`) and rate-limit / concurrency / timeout overrides. Set `VEYBOT_BOT_LOGIN` to the lowercase mention handle (`veybot` in production, no leading `@` or `[bot]`; config normalizes common variants). `VEYBOT_MAINTAINER_LOGINS` is optional comma-separated bare logins (`@`/`[bot]` optional, case-insensitive) for non-owner implementation authorizers. **GitHub auth is mode-exclusive**: either set `VEYBOT_GH_PROXY_URL` + `VEYBOT_GH_PROXY_HMAC_KEY` (gh-proxy mode; PAT lives only in the sidecar container — the bundled compose default), or set `GITHUB_TOKEN` directly (single-process PAT mode). `Settings._validate_proxy_or_pat` rejects a `.env` that sets both.
- **VEYYON_ROOT resolution**: veybot lives inside the veyyon monorepo at `python/veybot/`. `bun run docker:build` builds the parent monorepo (`../..`) as its docker build context to produce `veyyon:dev`; `docker-compose.yml` extends that image via `VEYYON_BASE` and mounts the same parent path read-only at `/work/veyyon` for the orchestrator to see live source. Override `VEYYON_ROOT` only when pointing the build/mount at a different veyyon checkout. Inside the container the path is always `/work/veyyon`. Build invalidation stays bounded: Python-only edits in veybot never trigger a natives recompile.
- **Forbidden**: no docker-in-docker, no extra service containers, no new background workers outside `WorkerPool`. The container itself is the isolation boundary; per-issue isolation is the git worktree.

## Testing & QA

- **Framework**: `pytest` with `asyncio_mode = "auto"` (`pyproject.toml`). HTTP mocking with `httpx.MockTransport`; `respx` is available but only `MockTransport` is used in-tree — match that style.
- **Fixtures** (`tests/conftest.py`):
  - `env` — `monkeypatch`-sets all required `VEYBOT_*` env vars and calls `reset_settings_cache()` before/after.
  - `settings` — invokes `ensure_paths()` for sqlite/workspace dirs.
  - `db` — isolated `tmp_path/test.sqlite` `Database`; tests must `database.close()` in teardown when bypassing this.
- **Isolation rules**: any test mutating env via `monkeypatch.setenv` MUST also call `reset_settings_cache()` to invalidate the `@cache`d `get_settings()`.
- **Async tests**: `test_github_client.py` and `test_host_tools.py` spin custom event loops in background threads to bridge sync-style tests with async client code. Prefer `pytest-asyncio` `auto` mode (`async def test_*`) for new tests; only fall back to the loop helpers if matching the surrounding file's style.
- **Mocking**: never patch internals; inject test doubles via `httpx.MockTransport` for HTTP and via the `db` / `tmp_path` fixtures for storage. Sandbox tests use a real local bare repo as the upstream.
- **Integration**: `tests/test_worker_smoke.py` is gated by `VEYBOT_INTEGRATION=1` (uses `pytestmark.skipif`) and needs `veyyon` on `PATH`. Don't enable it in default `bun run test:py`.
- **Coverage expectation**: ~80 unit tests currently. New code with a control-flow branch needs a test covering it; new host tools need at minimum a happy path + one validation-failure path mirroring `test_host_tools.py`. Test logical behavior (assertions on observable effects in DB / HTTP requests), not literal strings or default config values.
