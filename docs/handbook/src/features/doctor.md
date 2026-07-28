# Diagnostics and health

`veyyon setup status` is the health check. It answers two things in one pass: whether the install itself works, and whether you are signed in to a provider. Plugin health has its own command, and the TUI has its own debug tools.

## System health

```console
$ veyyon setup status
$ veyyon setup status --json
```

The install checks run first, because nothing below them can work if the install does not. They are the same questions the installer asks at the end of every install, asked of your machine as it is now:

| Check | What it proves |
| --- | --- |
| `veyyon on PATH` | The shell can find it, and which file it found. |
| `PATH copies` | Only one `veyyon` is on your PATH. A second one earlier on PATH keeps answering after an update writes the first, which is what makes an update look like it did nothing. |
| `veyyon runs` | It executes and reports the version you are running. If it will not start, the check quotes what the system said. |
| `Native addon` | A real search returns a real match, so the native addon loaded. `--version` alone passes without it. |
| `Install method` | Whether `veyyon update` swaps the binary or advances a source checkout. |
| `vey alias` | The short name the rest of the documentation tells you to type resolves. |
| `Shell completions` | Completion files are installed, and for which shells. |

None of them touches the network. A health check you cannot run when the network is what broke is not much of a health check.

After the install checks come the credential checks: `git` on PATH (missing is an error), and provider authentication through OAuth or one of `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `KIMI_API_KEY` (missing is a warning).

The command exits non-zero when any check reports an error, so you can gate a script on it. Warnings exit zero: they are worth reading, not worth stopping for.

## Plugin doctor

```console
$ veyyon plugin doctor
$ veyyon plugin doctor --fix
```

Checks plugin installation health. With `--fix`, it attempts automatic repairs where implemented.

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

## Which one to reach for

1. `veyyon setup status` when veyyon itself is misbehaving: it covers the install and your credentials.
2. `veyyon plugin doctor` when an extension is misbehaving.
3. `/debug` and `/memory diagnose` inside a session.
4. [Troubleshooting](../using/troubleshooting.md) for common setup failures.

## Exit status

Both `veyyon setup status` and `veyyon plugin doctor` exit non-zero when a check reports an error, and zero when the worst result is a warning.

## See also

- [Install](../using/install.md)
- [Troubleshooting](../using/troubleshooting.md)
- [Plugins](./plugins.md)
