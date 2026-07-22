# Install

Veyyon installs as a single self-contained binary. The installer downloads it, links a short `vey` launch command next to it, and runs a quick self-check. Under the hood Veyyon is a TypeScript and Bun agent loop, with Rust natives handling the hot paths: grep, the file walker, the shell and PTY, and hashline edits. The prebuilt binary bundles all of that, so you do not need Bun, Node, or a package manager to run it.

## Install on Linux or macOS

```console
$ curl -fsSL https://get.veyyon.dev | sh
```

That installs the `veyyon` binary to `~/.local/bin`, links `vey` beside it, and prints a `doctor:` line confirming the binary runs. When `~/.local/bin` is not on your `PATH` yet, the installer adds it to your shell profile and tells you to restart your shell.

## Install on Windows

```powershell
irm https://veyyon.dev/install.ps1 | iex
```

## After install

```console
$ vey --version
```

The first interactive `vey` opens the first-run setup, which moves through a splash, providers, glyphs, theme, and an outro. To run it again later, use `veyyon setup`. To re-open just the providers panel inside a session, use `/setup` or `/providers`. See [Getting started](./getting-started.md).

Your configuration home is `~/.veyyon`, and the default profile keeps its agent directory at `~/.veyyon/profiles/default/agent/`.

## Install a specific version, or from source

The installer takes a few options. Pass them after `-- ` when you pipe the script:

```console
$ curl -fsSL https://get.veyyon.dev | sh -s -- --ref v1.0.11   # a specific release
$ curl -fsSL https://get.veyyon.dev | sh -s -- --source        # build from a git checkout
```

`--source` is for running an unreleased branch or contributing. It keeps a real checkout under `~/.veyyon/src`, installs the workspace once with Bun, and links a launcher that runs Veyyon straight from TypeScript, so there is no separate build step. A source install needs **Bun** and **Git**; the installer installs Bun for you when it is missing. On Windows the same options are `-Source`, `-Binary`, `-Ref`, and `-Uninstall`. Pass them with the scriptblock form, for example `& ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Source` (see the header of `install.ps1`).

If you would rather clone and drive the workspace yourself:

```console
$ git clone https://github.com/santhreal/veyyon.git
$ cd veyyon
$ bun setup      # installs workspace deps and builds @veyyon/natives
$ bun dev --version
```

`bun dev` runs the in-repo build. Use it while you are evaluating Veyyon or contributing to it.

## Verify the install

```console
$ vey --version
$ vey plugin doctor
$ vey plugin doctor --fix
```

`vey plugin doctor` checks plugin health and warns you when an optional external binary (`sd`, `sg`, or `git`) or a common API key is missing. For interactive diagnostics, use `/debug` in the TUI. See [Diagnostics](../features/doctor.md).

### Relocate the config directory

On Unix, Veyyon uses `~/.veyyon` by default. Two environment variables let you move it. `VEYYON_CONFIG_DIR` renames the home-relative config directory, and `VEYYON_CODING_AGENT_DIR` relocates the agent base, which holds `config.yml`, `agent.db`, your sessions, and more.

```console
$ export VEYYON_CODING_AGENT_DIR=/path/to/veyyon-agent
$ vey plugin doctor
```

The [File locations](../reference/file-locations.md) chapter shows the full layout.

## First credentials

On the first interactive launch, the first-run setup (or `veyyon setup`) walks you through sign-in and API keys. Inside a session you have three ways to manage credentials: open the panel again with `/setup` or `/providers`, run `/login` (or `/login <provider>`) for OAuth and key entry, or export the provider's environment variable and skip the interactive step. See [Authentication](./authentication.md) and [Configuring providers](./configuring-providers.md).

## Updating

Veyyon keeps itself current. On startup it checks the registry for a newer
release, and if it finds one it installs it in the background:

```text
veyyon 1.2.0 installed · restart to use it
```

The running process keeps the version it started with, so the update takes
effect the next time you launch. On that launch you get one line naming the new
version:

```text
Updated to veyyon 1.2.0 · run /changelog for release notes
```

`/changelog` opens the release notes on the web rather than printing them into
your terminal.

Two settings control this, both on by default:

| Setting | Effect when off |
| --- | --- |
| `startup.checkUpdate` | No version check runs at all, so nothing updates automatically. |
| `startup.autoUpdate` | Veyyon still tells you a new version exists, but waits for you to run `veyyon update`. |

Turn automatic updates off like this:

```console
$ veyyon config set startup.autoUpdate false
```

You can always update on demand, whichever settings are in force:

```console
$ veyyon update
```

Veyyon updates through whatever installed it, whether that is Homebrew, mise,
bun, npm, or a standalone binary. If an automatic update fails, it says so and
tells you to retry with `veyyon update`; it never fails quietly and leaves you
on an old version without a word.

If the same version fails to install twice, the cause is usually the machine
rather than the release: a binary owned by another user, a read-only image, or a
package manager that needs elevated permissions. Veyyon reports that failure and
then leaves it alone for six hours instead of repeating it on every launch. A
newer release is never held back by an older one's failure, and `veyyon update`
ignores the pause entirely, so you can always ask to see the error again:

```console
$ veyyon update
```

Running several sessions at once is safe. Only the first one to start installs;
the others see that an install is under way and skip it rather than writing over
the same binary at the same time.

## Uninstall

The installer removes everything it added, including the `vey` alias, any shell completions, and a source checkout if you made one:

```console
$ curl -fsSL https://get.veyyon.dev | sh -s -- --uninstall
```

On Windows:

```powershell
& ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Uninstall
```

Then remove your state if you want a clean machine:

```console
$ rm -rf ~/.veyyon          # irreversible: config, secrets, sessions, plugins, skills, logs
$ # if you relocated the agent base:
$ rm -rf "$VEYYON_CODING_AGENT_DIR"
```
