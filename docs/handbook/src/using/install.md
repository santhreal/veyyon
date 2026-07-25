# Install

Veyyon installs as a single self-contained binary. The installer downloads it, links a short `vey` launch command next to it, and runs a quick self-check. Under the hood Veyyon is a TypeScript and Bun agent loop, with Rust natives handling the hot paths: grep, the file walker, the shell and PTY, and hashline edits. The prebuilt binary bundles all of that, so you do not need Bun, Node, or a package manager to run it.

## Install on Linux or macOS

```console
$ curl -fsSL https://get.veyyon.dev | sh
```

That installs the `veyyon` binary to `~/.local/bin`, links `vey` beside it, and runs a `doctor:` self-check. The self-check does two things: it confirms the binary starts and reports the version the release claims, and it runs a real search to confirm the native addon loads. The second check matters because `veyyon --version` answers without the addon, so a binary built for the wrong architecture starts cleanly and then fails on your first real command.

That search runs twice. The first time is on the downloaded file, before anything is installed: the checksum proves the bytes are the ones that were published, but it cannot tell you the release has no build for your platform. If the download cannot run a search, the installer stops there and your machine is untouched, with no binary installed, no `vey` alias, no change to your shell profile and no completion files. The second run proves the finished install works from where it now lives. Each message says which of the two it is. Either way, when the search fails the installer tells you to install from source. When `~/.local/bin` is not on your `PATH` yet, the installer adds it to your shell profile and tells you to restart your shell.

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

If an install is interrupted, run it again. The installer stages the binary beside its final path and moves it into place only once the file is complete, so a cancelled install never leaves you with a half-written `veyyon`. Cancelling with Ctrl-C removes the staged file on the way out; a kill the process cannot catch leaves it behind, and the next install reclaims it and names it:

```console
  ok  removed /home/you/.local/bin/.veyyon.download.48213 left by an interrupted install (pid 48213)
```

A staged file belonging to an installer that is still running is left alone, so two installs at once cannot delete each other's download.

On Linux the installer checks which C library your system uses before it downloads anything. The published binaries are built against glibc, so on a musl system (Alpine and similar) the installer stops and tells you to install from source instead. It stops rather than continuing because a musl system would install the binary cleanly and then fail to start it, with a "not found" error from the dynamic loader about a file that is plainly there.

## Install a specific version, or from source

The installer takes a few options. Pass them after `-- ` when you pipe the script:

```console
$ curl -fsSL https://get.veyyon.dev | sh -s -- --ref v1.0.11   # a specific release
$ curl -fsSL https://get.veyyon.dev | sh -s -- --source        # build from a git checkout
```

`--source` is for running an unreleased branch or contributing. It keeps a real checkout under `~/.veyyon/src`, installs the workspace once with Bun, and links a launcher that runs Veyyon straight from TypeScript, so there is no separate build step. A source install needs **Bun** and **Git**; the installer installs Bun for you when it is missing. It also needs **[git-lfs](https://git-lfs.com)** when the checkout tracks files through Git LFS, and it stops with that message rather than continuing: without git-lfs those files are written as small pointer text files, which look present and then fail at runtime. If nothing in the checkout is LFS-tracked, git-lfs is not required and the installer does not ask for it. The native addon is provisioned automatically: the installer (and the launcher, if the addon ever goes missing) downloads the prebuilt addon for your platform from the matching release, and falls back to a local Rust build only when no prebuilt exists. On Windows the same options are `-Source`, `-Binary`, `-Ref`, `-Local`, and `-Uninstall`. Pass them with the scriptblock form, for example `& ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Source` (see the header of `install.ps1`). `-Local` (and `--local` on Linux and macOS) installs the binary a checkout has already built instead of downloading a release, which is what you want when you are working on Veyyon itself or installing on a machine with no network.

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

Veyyon keeps itself current. On startup it checks veyyon.dev for a newer
version, and if it finds one it downloads the new binary in the background:

```text
veyyon 1.2.0 installed · restart to use it
```

The running process keeps the version it started with, so the update takes
effect the next time you launch. On that launch the welcome card's tip line
names the new version and points at what you can do about it:

```text
Tip: Updated to veyyon 1.2.0 · /changelog · roll back or turn auto-update off in /settings
```

You see it once per update, on the first launch after it. `/changelog` opens the
release notes on the web rather than printing them into your terminal.

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

### Going back to an older version

If a release breaks something you depend on, you do not have to wait for the next
one. `veyyon rollback` moves your install to any published version.

Run it with no arguments and you get a picker over every published version:

```console
$ veyyon rollback
```

The list opens on the version you are running. Type to filter it, press `c` to
open the highlighted version's changelog in your browser, and press enter to
choose one. Nothing installs until you choose, and the change takes effect the
next time you launch.

If you already know the version you want, or you are writing a script, the same
command works without the picker. Start by seeing what there is:

```console
$ veyyon rollback --list
VERSION  PUBLISHED
1.3.0    2026-07-01  (newer)
1.2.0    2026-06-01  (current)
1.1.0    2026-05-01  (previously run)
```

The markers tell you where you stand: `current` is the version running now,
`newer` is a version you would move forward to, and `previously run` is one this
machine has been on before. Then name the one you want:

```console
$ veyyon rollback 1.1.0
```

That installs 1.1.0 the same way an update installs a new release, verifies the
binary really is the version it claims, and prints the changelog link for it. Like
an update, it takes effect the next time you launch.

Two things it refuses rather than guesses at. Rolling back to the version you are
already running does nothing useful, so it says so instead of reinstalling and
reporting success. And a source checkout cannot be rolled back: it updates by
fast-forwarding its git branch, which only moves forward, so Veyyon tells you
that rather than quietly reinstalling the latest version. To run an older version
from a checkout, check the tag out yourself, or install the binary build and roll
back from there.

Add `--json` to `--list` when you want the same information for a script; each
row carries the version, its publish date, the markers, and the changelog URL.
Without a terminal on both ends, the bare `veyyon rollback` prints the list
rather than opening a picker nothing can drive, so it is safe in a pipeline.

You can also reach the picker without leaving a session. Open `/settings`, go to
the `Interaction` tab, and you will find `Roll back version` directly under
`Automatic Updates`, showing the version you are running now. It opens the same
picker, and choosing a version closes the settings panel first so you can watch
the install and read anything it has to tell you. The row appears only on an
install that can actually perform the move, so you will not see it on a source
checkout.

Veyyon is distributed only two ways, and it updates the way it was installed. A
binary install (the `curl` installer from veyyon.dev) replaces its own binary
with the newer one it fetches from veyyon.dev; veyyon.dev serves the signed
release and propagates automatically from GitHub Releases, so that is the only
place a binary ever comes from. Before it keeps the new binary it runs the same
two checks the installer runs: the binary reports the version the release
claims, and a real search confirms the native addon loads. If either fails the
previous binary goes back in place and the update reports why, so a release with
no build for your platform cannot leave you with a binary that starts and then
fails on your first command. A source checkout updates in its own terms:
`veyyon update` fast-forwards the checkout, reinstalls dependencies, and
regenerates build artifacts, and refreshes the native addon, all in one command.
It then reads the checkout's own version back and refuses to report success
unless the checkout really is at the new release. A fast-forward only advances
the branch you are on, so a checkout on a feature branch, or on a fork whose
upstream lags, can merge cleanly and stay behind; Veyyon tells you that instead
of claiming a version you do not have. The background updater leaves
source checkouts alone (it never runs git against your working tree); it tells
you a version exists and you run `veyyon update` when you want it. There is no
npm, Homebrew, or other package-manager channel to go through. If an update
fails, Veyyon says so and tells you to retry with `veyyon update`; it never
fails quietly and leaves you on an old version without a word.

If the same version fails to install twice, the cause is usually the machine
rather than the release: a binary owned by another user, a read-only image, or a
directory that needs elevated permissions to write. Veyyon reports that failure
and then leaves it alone for six hours instead of repeating it on every launch. A
newer release is never held back by an older one's failure, and `veyyon update`
ignores the pause entirely, so you can always ask to see the error again:

```console
$ veyyon update
```

An update also rewrites the shell completion files you already have, so
tab completion knows about the subcommands and flags the new version added. It
rewrites only files that are already there. It never creates one, because
choosing which shells get completions is the installer's job, not an update's.
If a completion cannot be rewritten, Veyyon names the file and tells you it
still describes the previous version; the update itself is unaffected. Both
install channels do this: a binary update regenerates from the new binary, a
source update from the checkout's launcher.

The native addon is cached per version under `~/.veyyon/natives/<version>/`,
around 150MB each. When a new version stages its own cache, the previous
version's copy is removed: it can never be loaded again, because Veyyon looks
only under its own version. Only directories named like a version are touched,
and a copy that cannot be removed is reported and retried on the next update.

Running several sessions at once is safe. Only the first one to start installs;
the others see that an install is under way and skip it rather than writing over
the same binary at the same time.

## Tab completion

The installer sets up tab completion for you. On macOS and Linux it writes one
file per shell into the directory bash, zsh, and fish each autoload from. If a
shell will not load that directory (zsh's `$fpath` often does not include it,
and bash needs the `bash-completion` package), the installer says so and prints
the exact line to add, rather than leaving you a file nothing reads.

Completion knows more than the command names. It offers the models in the
catalog for `--model`, your saved sessions for `--resume`, and for `veyyon
config` it offers the settings that exist and the values each one accepts:

```console
$ veyyon config set startup.<Tab>
startup.autoUpdate  startup.checkUpdate  startup.quiet  startup.setupWizard
$ veyyon config set startup.autoUpdate <Tab>
true  false
```

Those candidates come from the installed binary itself, so they describe the
version you are running rather than the version the script was written for. A
value only you know, an API key or a search term, is left alone: completion
offers nothing rather than a list of your files.

Attachments complete as paths. A word starting with `@` names a file to send
along with your message, so the shell completes it the way it completes any
path:

```console
$ vey @src/ma<Tab>
@src/main.ts
```

Windows works differently, because PowerShell has no directory it autoloads
completions from. The installer writes `veyyon-completions.ps1` next to your
profile and adds one line to the profile that loads it:

```powershell
# added by the veyyon installer
. "C:\Users\you\Documents\PowerShell\veyyon-completions.ps1"
```

Uninstall removes that line and the script, and leaves the rest of your profile
exactly as it was.

If you already have your own `vey` command, the installer never creates that
alias, and the completions it writes do not bind the name either. Every
generated script normally completes both `veyyon` and `vey`, so binding it
anyway would give your tool Veyyon's subcommands. You can ask for that form
yourself:

```console
$ veyyon completions zsh --no-alias
```

Updates keep that decision. When Veyyon rewrites your completion files it reads
the ones already there to see whether they bind `vey`, and regenerates them the
same way, so an update never starts completing a command that is not ours.

## Uninstall

The installer removes everything it added, and only what it added: the binary, the `vey` alias, the shell completions it wrote, the cached native addon, and a source checkout if you made one.

Two things it deliberately leaves behind. If you already had your own `vey` command, the installer never created that alias in the first place (it says so at install time and tells you to launch with `veyyon`), so uninstall does not touch it or its completion file. And if your source checkout has uncommitted edits or commits on a local branch that is on no remote, it is moved to `~/.veyyon/src.bak-<timestamp>` instead of being deleted, so nothing you wrote is lost.

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
