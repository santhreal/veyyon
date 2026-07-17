# Diagnostics and health

Veyyon's **shipped** diagnostics today are scoped to **plugins** and **interactive debug** — not a
full install-wide `veyyon doctor` command yet.

## Plugin doctor (shipped)

```console
$ veyyon plugin doctor
$ veyyon plugin doctor --fix
```

Checks plugin installation health. With `--fix`, it attempts automatic repairs where implemented.

Additional plugin-environment checks warn when optional external binaries (`sd`, `sg`, `git`) or common
API keys are missing — these are warnings, not hard failures.

## TUI debug (shipped)

```text
/debug
```

Opens the debug tools selector in the interactive session.

## Memory diagnostics (shipped)

```text
/memory diagnose
/memory stats
```

Operate the mnemopi memory backend from the TUI. See [Memory](./memory.md).

## Checking install health

There is no single `veyyon doctor` command. Diagnostics are spread across a few surfaces:

1. `veyyon --version` and a normal interactive session start.
2. `veyyon plugin doctor` for extension health.
3. `/debug` and `/memory diagnose` inside the TUI.
4. [Troubleshooting](../using/troubleshooting.md) for common setup failures.

## Exit status (plugin doctor)

`veyyon plugin doctor` exits non-zero when checks report `error` status. Warnings may still exit zero.

## See also

- [Install](../using/install.md)
- [Troubleshooting](../using/troubleshooting.md)
- [Plugins](./plugins.md)
