# Non-interactive mode (`veyyon --print`)

`--print` (short `-p`) runs Veyyon without the interactive TUI: one prompt, tools run under the active approval mode, then exit. Use this from scripts, CI, and other programs.

```console
$ veyyon -p "add a unit test for parse_config and run it"
$ echo "summarize the diff on this branch" | veyyon -p
$ veyyon -p - <<'EOF'
Review src/auth.rs for missing error handling.
EOF
```

The prompt may be a CLI argument or stdin. If both are present, stdin is appended as a `<stdin>` block.

Run `veyyon --help` for the generated flag set. Common options:

### Session and config

| Option | Effect |
| --- | --- |
| `--strict-config` | Error when `config.yml` contains unknown fields |
| `--skip-git-repo-check` | Allow running outside a Git repository |
| `--ephemeral` | Do not persist the session under the agent sessions dir |
| `--ignore-user-config` | Do not load user `config.yml` (auth still uses the agent dir) |
| `--ignore-rules` | Do not load user or project execpolicy `.rules` files |
| `--profile <name>` | Activate a named profile (`-p` is `--print`, not profile) |
| `-c key=value` | Override a config value for this run (repeatable) |
| `--cwd <DIR>` | Working directory for the session |
| `--add-dir <DIR>` | Extra writable root (repeatable) |

### Output and models

| Option | Effect |
| --- | --- |
| `--json` | Machine-readable event stream on stdout |
| `--model` / role flags | Model selection for the run |
| `--approval-mode` / `--yolo` | Approval policy for the run |

Headless runs have no TTY for approval prompts: choose a mode that does not block (`--yolo` only on disposable runners) or expect the turn to stop when a prompt would be required. See [Approvals](./sandbox.md).

## Related

- [Approvals](./sandbox.md)
- [Safety](../using/safety.md)
- [CLI](../reference/cli.md)
