# Diagnostics and health

Diagnostics are split across `veyyon setup status`, plugin doctor, TUI `/debug`, and memory commands. There is no single
`veyyon doctor` binary that covers install, auth, and plugins in one pass.

## Plugin doctor

```console
$ veyyon plugin doctor
$ veyyon plugin doctor --fix
```

Checks plugin installation health. With `--fix`, it attempts automatic repairs where implemented.

A separate System Health Check runs under `veyyon setup status` (and `veyyon setup status --json`): it checks `vey`, `veyyon`, and `git` on PATH (a missing `git` is an error, the others warnings) plus provider authentication (OAuth or one of `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `KIMI_API_KEY`, missing = warning).

## TUI debug

```text
/debug
```

Opens the debug tools selector in the interactive session.

## Memory diagnostics

```text
/memory diagnose
/memory stats
```

Run diagnostics and statistics on the configured memory backend (`memory.backend`: mnemopi, hindsight, local) from the TUI. See [Memory](./memory.md).

## Checking install health

There is no single `veyyon doctor` command. Diagnostics are spread across a few surfaces:

1. `veyyon --version` and a normal interactive session start.
2. `veyyon setup status` for the install and auth health check.
3. `veyyon plugin doctor` for extension health.
4. `/debug` and `/memory diagnose` inside the TUI.
5. [Troubleshooting](../using/troubleshooting.md) for common setup failures.

## Exit status (plugin doctor)

`veyyon plugin doctor` exits non-zero when checks report `error` status. Warnings may still exit zero.

## See also

- [Install](../using/install.md)
- [Troubleshooting](../using/troubleshooting.md)
- [Plugins](./plugins.md)
