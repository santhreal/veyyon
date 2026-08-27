# Harbor Agent Adapters

This directory provides the Harbor (`harbor-framework`) agent adapters used on benchmark suites such as **Terminal-Bench 3.0**: `VeyyonAgent` in `veyyon_agent.py` for veyyon (the compiled `vey` binary), and `ProgramAgent` in `program_agent.py` for every harness whose container run is one declaration.

## Overview

Both adapters implement Harbor's `BaseInstalledAgent` interface to run a coding agent inside a containerized task environment. `VeyyonAgent` is specific to veyyon, which is mounted or packed from a local revision and reaches its provider through the auth gateway. `ProgramAgent` runs whatever `program.json` the run staged.

### Delivery & Staging Model

Because veyyon is evaluated at local development revisions rather than published package versions:
1. The host runner stages assets in an `assets_dir`:
   - `vey` (the compiled executable)
   - `auth-agent.db` (seeded SQLite credential store)
   - `arms/<arm_name>.yml` (settings overlay)
   - `attachments.json` (optional attachment manifest for prompt variants and rules)
2. During `install()` / `setup()` (or prior to `run()`), `VeyyonAgent`:
   - Creates `/opt/veyyon-assets` in the container.
   - Uploads `vey`, `auth-agent.db`, and `arm.yml`.
   - Uploads any prompt or rule attachments.
   - Makes `/opt/veyyon-assets/vey` executable (`chmod +x`).
   - Copies credentials to `~/.veyyon/shared-auth/agent.db` and config to `~/.veyyon/arm.yml`.
   - Installs rule files to `~/.veyyon/rules/` if specified by arm attachments.
3. During `run()`:
   - Refreshes and verifies the dynamic model catalog entry via `/opt/veyyon-assets/vey models refresh <provider> --json`.
   - Invokes `vey` headlessly with `--model`, `--auto-approve`, `--config $HOME/.veyyon/arm.yml`, and `--print <instruction>`.
   - Streams output through a status-preserving `tee` to `/logs/agent/veyyon.txt`.
   - Collects session `.jsonl` files from `~/.veyyon/profiles/default/agent/sessions` to `/logs/agent/sessions/`.
   - Populates `AgentContext` (`n_input_tokens`, `n_cache_tokens`, `n_output_tokens`, `cost_usd`, and metadata) from session logs or replay results.

## Program-Driven Harnesses

`ProgramAgent` carries no harness knowledge. `VEYYON_BENCH_AGENT_PROGRAM` names the staged `program.json` on the host, and `common/container_program.py` uploads the assets it declares, runs its setup lines, substitutes `{{assets}}`, `{{model}}` and `{{instruction}}` into its command, streams the output to the log path it names, and collects the session files it names. The declaration is written once in TypeScript, under `packages/evals/src/harnesses/adapters/`, and Pier's shim in `../pier/omp_agent.py` executes the same file through the same module.

`ProgramAgent.name()` returns the harness the program names, so the run directory and the log path carry that harness rather than `program`. Adding a harness to Terminal-Bench 3.0 means declaring its program and binding it to the harbor backend; no Python module is added.

## Error Handling & Error Patterns

Rather than ad-hoc regex handling in application logic, `VeyyonAgent` declares `ERROR_PATTERNS` mapping provider failure needles to Harbor's typed exception hierarchy:
- `ApiRateLimitError` (HTTP 429, rate limits, too many requests)
- `ApiUsageLimitError` (quota exceeded, unpaid invoices, credit limits)
- `ApiInternalServerError` (HTTP 500, provider internal server errors)
- `ApiOverloadedError` (HTTP 503, service unavailable, capacity limits)
- `ApiConnectionClosedError` (connection closed mid-response / mid-stream)
- `ApiResponseStalledError` (stream stalled mid-response)
- `OutputTokenExceededError` (output token maximum exceeded)
- `ContextWindowExceededError` (context window / input token limits exceeded)
- `AgentAuthenticationError` (401 Unauthorized, invalid API key, not logged in)
- `ModelNotFoundError` (model does not exist or unavailable)
- `AgentSafetyRefusalError` (safety / content filtering / cyber safeguard hard stops)
- `NetworkConnectionError` (DNS resolution failures, connection refused, curl / TLS errors)

## Running Tests

Run the test suite via stdlib `unittest`:

```bash
python3 -m unittest discover -s packages/evals/agents/harbor -p '*_test.py'
```
