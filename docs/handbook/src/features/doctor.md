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

## Spec — not shipped: top-level `veyyon doctor`

Older handbook pages described:

```console
$ veyyon doctor
$ veyyon doctor --json
$ veyyon doctor --summary --all
```

That full install health reporter (binary, sandbox, auth, terminal capabilities, feature flags, update feed, custom CA env vars) is **not** implemented as a root CLI subcommand today. Any mention of `veyyon doctor` for install health is a target, not current behavior.

**Workaround today**

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
