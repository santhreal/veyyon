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
| `-c, --config key=value` | Override config for one run (repeatable) |
| `--approval-mode <policy>` | When to ask before running commands |
| `--profile <name>` | Use an isolated profile agent directory |
| `--model <id>` | Interactive model (`provider/model`) |
| `--subagent-model <id>` | Model for spawned task subagents |
| `--compaction-model <id>` | Model for context compaction |

Config precedence: CLI flags → `-c` overrides → `config.yml` → defaults. See
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
| `bench` | | Benchmark harness |
| `commit` | | Agentic commit workflow |
| `completions` | | Shell completion scripts |
| `config` | | List/get/set settings |
| `dry-balance` | | Dry-run OAuth account balancing |
| `gc` | | Garbage-collect session artifacts |
| `grep` | | Grep-tool CLI probe |
| `gallery` | | TUI gallery / fixtures |
| `grievances` | | Internal grievance reporter |
| `install` | | Install / bootstrap |
| `join` | | Join collab session |
| `models` | | List models and providers |
| `plugin` | | Plugin lifecycle (`list`, `install`, …) |
| `read` | | Read-tool CLI probe |
| `say` | | Speak text with local TTS (`--voices` lists voices) |
| `search` | `q` | Web search probe |
| `session` | `sessions` | Study a stored session (`stats`: timing, tool cost, turn cadence) |
| `setup` | | First-run setup wizard |
| `shell` | | Native shell probe |
| `ssh` | | SSH host configuration |
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

- **Totals**: wall clock, turn and tool-call counts, token usage, request time, tool execution time, queue wait, and the weight tool results added to context.
- **Tool latency**: per tool, the call count and the p50, p95, and max execution time, plus total scheduler wait, slowest tool first.
- **Tool cost**: per tool, the tokens and bytes its results returned into context, most expensive first.
- **Repeated identical calls**: tools called more than once with byte-identical arguments, keyed by an arguments fingerprint.
- **Per-turn**: each assistant turn's model, request time, tool calls, and token usage.

The timing and weight fields come from the per-tool-call records that
instrumentation writes. How much is recorded depends on the `session.instrumentation`
setting: `off` records nothing (the command still reports turns and usage from the
assistant's own accounting, but tool timing reads as zero), `basic` records
wall-clock, `rich` adds output weight, and `ultra` adds the arguments fingerprint
that powers repeated-call detection. Turn on `ultra` for a session you want to
study in full, or create a ready-made study profile with `veyyon profile new dev
--from dev`. See [Profiles](../features/profiles.md) and the `session.instrumentation`
setting for the level details.

`--json` prints the complete report, including every turn; the text view caps the
longest tables and says so when it does.

There are no `veyyon app-server`, `exec-server`, `execpolicy`, or `responses-api-proxy` subcommands,
and no top-level `resume` / `fork` / `archive` verbs. Resume and branch from the TUI (`/resume`,
`/fork`, `/session`) or the launch session picker; for non-interactive resume use `veyyon --print
--resume <id>` / `--continue`.

## Exit codes

See [Exit codes](./exit-codes.md).
