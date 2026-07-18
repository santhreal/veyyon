# Frequently asked questions

This page answers common questions and errors. For a guided diagnostic path, see [Troubleshooting](./troubleshooting.md).

## Setup

### `veyyon plugin doctor` fails. What do I fix?

`veyyon plugin doctor` exits non-zero when a check reports an error, and it prints the failed check and the next action. Fix the line it reports, then run it again. For the full diagnostics surface, see [Diagnostics and health](../features/doctor.md).

### Does Veyyon sandbox the commands it runs?

No OS confinement (no Landlock, seccomp, Seatbelt, bubblewrap). Policy is **`tools.approvalMode`** (schema default **`yolo`**) plus execpolicy `.rules`. See [Approvals](../features/sandbox.md).

## Database and session locking

### "Session file is locked" or "another Veyyon process is running"

Veyyon uses file locking to prevent two processes from writing the same session file at once. Only one process may hold a session lock at a time. If you see this error:

- Check that no other `veyyon` process is holding the same session file lock.
- If a previous process crashed, the lock may be stale. Restarting the machine or waiting for the process table to clear usually releases it.
- Do not delete or edit the session file while a process might still hold it.

For how sessions are stored and resumed, see [Sessions](./sessions.md).

## Model authentication

### "Invalid API key" or "Authentication failed"

The process calls the configured provider endpoint with the configured key. Check env var / auth store / `models.yml` for that provider, key validity, and scopes. See [Models and providers](./models.md).

### "Unsupported region" or endpoint errors

The base URL you configured must match the provider region and product endpoint. A model id that exists in one region may not exist in another, and the same hostname may host different model catalogs. Verify the endpoint URL in your provider dashboard and compare it with the `base_url` in your config. [Models and providers](./models.md) explains how provider configuration is resolved.

### Why is my model not listed?

Veyyon discovers model ids from the provider's `/models` endpoint rather than maintaining a hardcoded allowlist. If a model is not listed, the provider endpoint may not expose it, or your key may not have access to it. Check the provider catalog and your key scopes first.

## Workflow

### Why did my edit ask for approval?

The approval mode decides when Veyyon prompts before a tool runs. In `ask` and `plan`, write and exec tiers prompt. Change mode with `--approval-mode <mode>` (`plan`, `ask`, `auto-edit`, `yolo`), `--auto-approve` / `--yolo`, or `tools.approvalMode` in `config.yml`. See [Approvals](../features/sandbox.md).

### How do I resume a session?

Run `veyyon --continue` to continue the most recent session, or `veyyon --resume <SESSION_ID>` to resume a specific one. The session stores turns, tool activity, and queued follow-ups, so a resumed session should keep its context and any pending work. For branching, forking, or exporting a session, see [Sessions](./sessions.md).

### What happened to my queued follow-up?

Follow-ups queued during a turn are stored with the session on disk, so they survive TUI restarts and session resumes. If you press `Esc` to interrupt the current turn, queued follow-ups are pulled back into the composer so nothing is lost. See [Sessions](./sessions.md) for the full queue behavior.

### Why does my output look truncated?

Output is intentionally truncated when it exceeds a tool budget. The truncation should include a next action, such as increasing a limit, using an offset, or narrowing the search. See [Troubleshooting](./troubleshooting.md) for the public path.

## Where to go next

- [Troubleshooting](./troubleshooting.md) for the guided diagnostic path.
- [Models and providers](./models.md) for provider keys, endpoints, and model selection.
- [Approvals](../features/sandbox.md) for the approval modes.
- [Sessions](./sessions.md) for resume, fork, branch, and export.
