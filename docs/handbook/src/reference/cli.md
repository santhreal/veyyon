# CLI reference

The command is **`veyyon`**. Run `veyyon` with no subcommand to start an interactive session; use a
registered subcommand for everything else. `veyyon --help` and per-command `--help` are the
generated source of truth.

## Starting a session

```console
$ veyyon
$ veyyon "fix the failing test in auth.rs"
```

Common launch options:

| Option | Purpose |
| --- | --- |
| `[PROMPT]` | Optional initial user prompt |
| `-c, --continue` | Continue the previous session |
| `--config <file>` | Load an extra config.yml-style overlay for this run (repeatable) |
| `--approval-mode <policy>` | When to ask before running commands |
| `--profile <name>` | Use an isolated profile agent directory |
| `--model <id>` | Interactive model (`provider/model`) |
| `--subagent-model <id>` | Model for spawned task subagents |
| `--compaction-model <id>` | Model for context compaction |

Config precedence: CLI flags → `--config` overlays → project config → global config → defaults. See
[Configuration](../using/configuration.md).

## Registered subcommands

Unknown first tokens route to `launch` as a prompt:

| Command | Aliases | Purpose |
| --- | --- | --- |
| `launch` | (default) | Interactive or prompted session |
| `acp` | | Agent Client Protocol server mode |
| `agents` | | Manage agent definitions |
| `auth-broker` | | Shared auth broker (headless login) |
| `auth-gateway` | | Auth gateway helper |
| `bench/throughput` | | Throughput benchmark harness |
| `commit` | | Agentic commit workflow |
| `completions` | | Shell completion scripts |
| `config` | | List/get/set settings |
| `dry-balance` | | Dry-run OAuth account balancing |
| `gc` | | Garbage-collect session artifacts |
| `grep` | | Grep-tool CLI probe |
| `gallery` | | TUI gallery / fixtures |
| `grievances` | | Internal grievance reporter |
| `install` | | Install or link an extension package (alias of `plugin install`/`plugin link`) |
| `join` | | Join collab session |
| `models` | | List models and providers |
| `plugin` | | Plugin lifecycle (`list`, `install`, …) |
| `profile` | `profiles` | List, create, or remove self-contained profiles |
| `prompt` | | Inspect the assembled system prompt without starting a session |
| `read` | | Read-tool CLI probe |
| `rollback` | | Move this install to another published version |
| `say` | | Speak text with local TTS (`--voices` lists voices) |
| `search` | `q` | Web search probe |
| `session` | `sessions` | Study a stored session (`stats`: timing, tool cost, turn cadence) |
| `setup` | | First-run setup wizard |
| `shell` | | Native shell probe |
| `ssh` | | SSH host configuration |
| `stats` | | Usage statistics dashboard (`--summary` prints to console, `--json` for machines) |
| `tiny-models` | | On-device tiny model utilities |
| `token` | | Print a provider's API key or OAuth token |
| `ttsr` | | Time-traveling stream rules test |
| `update` | | Self-update |
| `usage` | | Provider usage limits |
| `worktree` | `wt` | Git worktree helpers |

Hidden worker selectors and `--smoke-test` are for CI/packaging, not daily use.

## Studying a session

`veyyon session stats [id]` reads a stored session and reports how it spent its
time and tokens. With no id it studies the most recent session in the current
directory; give a session id or filename prefix to pick another one. The command
reads only, so it is safe to run against a session another process is writing.

```console
$ veyyon session stats
$ veyyon session stats 3f8a
$ veyyon session stats --json
```

It reports, in one pass:

- **Totals**: wall clock, turn and tool-call counts, token usage, request time, tool execution time, queue wait, and tool-result weight.
- **Lifecycle**: sequence coverage, checkpoints, and the latest running or ended state.
- **Context**: prompt, non-message, stored-message, and tail-token attribution when recorded.
- **Agent communication**: sent and received message counts, payload bytes, outcomes, and delivery routes.
- **Task state**: latest open, active, dropped, and completed counts plus recorded transitions.
- **Tool latency and cost**: per-tool execution percentiles, scheduler wait, returned tokens, and returned bytes.
- **Repeated argument fingerprints**: tools called more than once with the same collision-resistant argument digest. Older sessions with only 32-bit fingerprints are analyzed in a separate legacy namespace.
- **Per-turn**: each assistant turn's model, request time, tool calls, and token usage.

The `session.instrumentation` setting controls the stored detail:

- `off` stores the normal resumable conversation and tool history without extra telemetry. Stats still use normal assistant usage and messages.
- `basic` adds lifecycle and checkpoints, task-state transitions, tool wall-clock and status, and model request timing.
- `rich` adds context attribution, agent-message delivery, tool scheduling and result weight, model token throughput, and richer rollups.
- `ultra` adds argument fingerprints, abort state, compaction links, directional agent routes, per-task transitions, cache and reasoning detail, and upstream-provider provenance.

The setting applies immediately. A new level starts a new measured lifecycle interval. A turn already in flight keeps the lower of its dispatch level and the current level when it is stored. If you turn instrumentation off before that turn finishes, its added study fields are omitted. Normal conversation and tool history remain resumable.

Use `ultra` for a session you want to study in full, or create a study profile with
`veyyon profile new dev --from dev`. See [Profiles](../features/profiles.md) for the
setting and profile behavior.

`--json` prints the complete report, including every turn; the text view caps the
longest tables and says so when it does.

There are no `veyyon app-server`, `exec-server`, `execpolicy`, or `responses-api-proxy` subcommands,
and no top-level `resume` / `fork` / `archive` verbs. Resume and branch from the TUI (`/resume`,
`/fork`, `/session`) or the launch session picker; for non-interactive resume use `veyyon --print
--resume <id>` / `--continue`.

## Exit codes

See [Exit codes](./exit-codes.md).
