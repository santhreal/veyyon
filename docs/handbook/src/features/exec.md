# Non-interactive mode (`veyyon --print`)

`--print` (short `-p`) runs Veyyon without the interactive TUI: one prompt, tools run under the active approval mode, then exit. Use this from scripts, CI, and other programs.

The run exits after the agents it spawned and the commands it ran in the background have finished and their results are answered. It does not wait for a process started with the `launch` tool or a background command run with `timeout: 0`.

```console
$ veyyon -p "add a unit test for parse_config and run it"
$ echo "summarize the diff on this branch" | veyyon -p
$ veyyon -p - <<'EOF'
Review src/auth.rs for missing error handling.
EOF
```

The prompt may be a CLI argument or stdin. If both are present, the piped stdin content is prepended to the argument prompt (stdin first, then the argument, separated by a newline).

Run `veyyon --help` for the generated flag set. Common options:

### Session and config

| Option | Effect |
| --- | --- |
| `--no-session` | Do not persist the session (an ephemeral run) |
| `--no-rules` | Do not discover or load rules files |
| `--no-skills` | Do not discover or load skills |
| `--profile <name>` | Activate a named profile (`-p` is `--print`, not profile) |
| `--config <file>` | Load an extra config overlay for this run, repeatable and never persisted |
| `--cwd <DIR>` | Working directory for the session |
| `--allow-home` | Start in your home directory instead of auto-switching to a temp dir |

### Output and models

| Option | Effect |
| --- | --- |
| `--mode json` | Machine-readable event stream on stdout |
| `--model` / `--plan` | Model selection for the run |
| `--approval-mode` / `--yolo` | Approval policy for the run |

`--mode json` writes one JSON line per session event, after the session header. Configured secrets in a line are replaced with their placeholders. A line that cannot be redacted is not written, and a `Dropped a --mode json line` message is written to stderr instead.

Headless runs have no TTY for approval prompts: choose a mode that does not block (`--yolo` only on disposable runners) or expect the turn to stop when a prompt would be required. See [Approvals](./sandbox.md).

## Related

- [Approvals](./sandbox.md)
- [Safety](../using/safety.md)
- [CLI](../reference/cli.md)
