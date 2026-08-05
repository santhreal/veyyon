# Frequently asked questions

This page answers common questions and errors. For a guided diagnostic path, see [Troubleshooting](./troubleshooting.md).

## Setup

### `veyyon plugin doctor` fails. What do I fix?

`veyyon plugin doctor` exits non-zero when a check reports an error, and it prints the failed check and the next action. Fix the line it reports, then run it again. For the full diagnostics surface, see [Diagnostics and health](../features/doctor.md).

### Does Veyyon sandbox the commands it runs?

No OS confinement (no Landlock, seccomp, Seatbelt, bubblewrap). Policy is **`tools.approvalMode`** (schema default **`auto`**), plus the working-directory and secret-use boundaries, which apply on every rung except `yolo`, and hard-coded critical bash patterns, which prompt on every rung including `yolo`. See [Approvals](../features/sandbox.md).

## Database and session locking

There is no cross-process lock on a session file: nothing prevents two `veyyon` processes from opening the same session at once, and the single-writer guarantee is per-process only. Treat one session as belonging to one running process; do not edit or delete its file while that process is alive.

For how sessions are stored and resumed, see [Sessions](./sessions.md).

## Model authentication

### "Invalid API key" or "Authentication failed"

The process calls the configured provider endpoint with the configured key. Check env var / auth store / `models.yml` for that provider, key validity, and scopes. See [Models and providers](./models.md).

### "Unsupported region" or endpoint errors

The base URL you configured must match the provider region and product endpoint. A model id that exists in one region may not exist in another, and the same hostname may host different model catalogs. Verify the endpoint URL in your provider dashboard and compare it with the `base_url` in your config. [Models and providers](./models.md) explains how provider configuration is resolved.

### Why is my model not listed?

Veyyon lists models from a bundled catalog plus live discovery from providers that expose a `/models` endpoint. If a model is not listed, the provider endpoint may not expose it, or your key may not have access to it. Check the provider catalog and your key scopes first.

## Workflow

### Why did my edit ask for approval?

The approval mode decides when Veyyon prompts before a tool runs. In `ask`, every tier prompts, reads included. In `ask-command`, reads and edits run and anything that executes asks. In `auto`, the default, every tier runs with the per-tool, working-directory, credential and critical-call guards still asking. In `plan`, exec is blocked outright and write prompts only inside an active plan-mode session. Change mode with `--approval-mode <mode>` (`plan`, `ask`, `ask-command`, `auto`, `yolo`), `--auto-approve` / `--yolo`, or `tools.approvalMode` in `config.yml`. See [Approvals](../features/sandbox.md).

### How do I resume a session?

Run `veyyon --continue` to continue the most recent session, or `veyyon --resume <SESSION_ID>` to resume a specific one. The session stores turns and tool activity, so a resumed session keeps its context. For branching, forking, or exporting a session, see [Sessions](./sessions.md).

### What happened to my queued follow-up?

Queued follow-ups live in memory for the lifetime of the running process; they are not written to the session file. If you press `Esc` to interrupt the current turn, queued follow-ups are pulled back into the composer so nothing is lost. See [Sessions](./sessions.md) for the full queue behavior.

### Why does my output look truncated?

Output is intentionally truncated when it exceeds a tool budget. The truncation should include a next action, such as increasing a limit, using an offset, or narrowing the search. See [Troubleshooting](./troubleshooting.md) for the public path.

## Where to go next

- [Troubleshooting](./troubleshooting.md) for the guided diagnostic path.
- [Models and providers](./models.md) for provider keys, endpoints, and model selection.
- [Approvals](../features/sandbox.md) for the approval modes.
- [Sessions](./sessions.md) for resume, fork, branch, and export.
