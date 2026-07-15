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
| `--no-alt-screen` | Inline mode (preserve scrollback) |

Config precedence: CLI flags → `-c` overrides → `config.yml` → defaults. See
[Configuration](../using/configuration.md).

## Registered subcommands

Unknown first tokens route to `launch` as a prompt:

| Command | Aliases | Purpose |
| --- | --- | --- |
| `launch` | (default) | Interactive or prompted session |
| `acp` | | Agent Control Protocol server mode |
| `agents` | | Manage agent definitions |
| `auth-broker` | | Shared auth broker (headless login) |
| `auth-gateway` | | Auth gateway helper |
| `bench` | | Benchmark harness |
| `commit` | | Agentic commit workflow |
| `completions` | | Shell completion scripts |
| `config` | | List/get/set settings |
| `dry-balance` | | Token balance probe |
| `gc` | | Garbage-collect session artifacts |
| `grep` | | Test grep tool (esp. Windows) |
| `gallery` | | TUI gallery / fixtures |
| `grievances` | | Internal grievance reporter |
| `install` | | Install / bootstrap |
| `join` | | Join collab session |
| `models` | | List models and providers |
| `plugin` | | Plugin lifecycle (`list`, `install`, …) |
| `read` | | Read-tool CLI probe |
| `say` | | TTS one-shot |
| `search` | `q` | Web search probe |
| `setup` | | First-run setup wizard |
| `shell` | | Native shell probe |
| `ssh` | | SSH host configuration |
| `tiny-models` | | On-device tiny model utilities |
| `token` | | Token utilities |
| `ttsr` | | Time-traveling stream rules test |
| `update` | | Self-update |
| `usage` | | Provider usage limits |
| `worktree` | `wt` | Git worktree helpers |

Hidden worker selectors and `--smoke-test` are for CI/packaging, not daily use.

> **Spec — not shipped:** `veyyon app-server`, `exec-server`, `execpolicy`, `responses-api-proxy`, and
> `resume` / `fork` / `archive` as top-level CLI verbs. Use `/resume`, `/fork`, and `/session` in the
> TUI, or the session picker on launch.

## Exit codes

See [Exit codes](./exit-codes.md).
