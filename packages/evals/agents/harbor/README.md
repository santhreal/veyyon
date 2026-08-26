# Veyyon Harbor Agent Adapter

This directory provides the Harbor (`harbor-framework`) agent adapter for evaluating veyyon (the compiled `vey` binary) on benchmark suites such as **Terminal-Bench 3.0**.

## Overview

The adapter (`VeyyonAgent` in `veyyon_agent.py`) implements Harbor's `BaseInstalledAgent` interface to run compiled veyyon binaries inside containerized task environments.

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
