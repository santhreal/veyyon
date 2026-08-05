# Install

Veyyon installs as a single self-contained binary. The release installer stages the download and proves it has the published checksum, the requested version, and working native support before it changes the active install or your shell. It then links a short `vey` launch command next to `veyyon`. Under the hood Veyyon is a TypeScript and Bun agent loop, with Rust natives handling the hot paths: grep, the file walker, the shell and PTY, and tree-sitter block resolution for hashline block edits. The prebuilt binary bundles all of that, so you do not need Bun, Node, or a package manager to run it.

## Install on Linux or macOS

```console
$ curl -fsSL https://get.veyyon.dev | sh
```

That installs the `veyyon` binary to `~/.local/bin`, links `vey` beside it, and runs a `doctor:` self-check. Before it replaces an existing binary, creates the alias, edits a shell profile, or writes completions, it checks the staged download in this order:

1. Its SHA-256 digest matches the release sidecar.
2. `veyyon --version` reports the exact release tag you requested.
3. A real `veyyon grep` finds a known file, proving the native addon loads on this platform.

The checksum proves which bytes you received, but it cannot prove that the release uploaded the right version or a usable native build. If any preflight fails, the installer removes the staged file when it can and leaves the active binary and shell files unchanged. After the verified file moves into place, `doctor:` repeats the version and native checks from the final path. When `~/.local/bin` is not on your `PATH` yet, the installer then adds it to your shell profile. A profile is read when a shell starts, and the shell you ran the installer from has already started, so the final message gives you the exact reload command before the normal next steps:

The installer records a small ownership receipt beside each binary and completion file it creates. A reinstall or uninstall changes only receipt-backed files. An older Veyyon install is adopted when its exact launcher or generated completion signature identifies it. If another executable or completion already occupies a target path, the installer leaves it byte-for-byte unchanged and tells you to move it yourself before retrying.

```console
Next steps:
  1. Reload your shell:        exec $SHELL -l
     (or, without a new shell: source /home/you/.bashrc)
  2. Launch in any repository: veyyon
  3. Connect API providers:    veyyon setup
  4. See every command:        veyyon --help
```

When the directory was already on your `PATH`, there is nothing to reload and the list starts at the launch step.

The installer never calls the GitHub API. It finds the newest release from where `https://github.com/santhreal/veyyon/releases/latest` redirects to, and downloads the binary from that same host. The API is capped at 60 requests an hour per address, shared by everyone behind it, so a CI fleet or an office network that installs Veyyon repeatedly used to start getting a rate-limit failure on a machine where nothing was wrong. Nothing needs a token, and setting one changes nothing about the install.

## Install on Windows

```powershell
irm https://veyyon.dev/install.ps1 | iex
```

That works in both shells Windows ships: Windows PowerShell 5.1, which is what `powershell.exe` opens on a stock machine, and PowerShell 7. The installer enables TLS 1.2 before it fetches anything, because 5.1 still offers SSL 3.0 and TLS 1.0 by default and GitHub has required TLS 1.2 since 2018.

Like the Unix installer, it never calls the GitHub API, and it puts the install directory at the front of your user `PATH`. The one-liner above runs in the window you typed it in, so `veyyon` works there straight away, with no restart. A `PATH` entry reaches every other program when that program starts, so terminals you already have open elsewhere will not see it until they restart. The closing steps say which case you are in: run the installer as a file (`pwsh -File install.ps1`) and it is a separate process whose `PATH` change cannot reach your shell, so the first step is to open a new window.

## Prebuilt release platforms

GitHub Releases publishes these application binaries:

| Operating system | Architecture | Release binary |
| --- | --- | --- |
| Linux (glibc) | x64 | `veyyon-linux-x64` |
| Linux (glibc) | arm64 | `veyyon-linux-arm64` |
| macOS | x64 (Intel) | `veyyon-darwin-x64` |
| macOS | arm64 (Apple silicon) | `veyyon-darwin-arm64` |
| Windows | x64 | `veyyon-windows-x64.exe` |

There is no native Windows arm64 release. On Windows arm64, run the Windows x64 binary under emulation. Linux release binaries require glibc. On a musl system such as Alpine, the installer stops before downloading and tells you to clone the repository and build it yourself.

## After install

```console
$ vey --version
```

The first interactive `vey` opens the first-run setup, which moves through a splash, providers, glyphs, theme, and an outro. To run it again later, use `veyyon setup`. To re-open just the providers panel inside a session, use `/setup`. To manage the accounts you already have, use `/providers`. See [Getting started](./getting-started.md).

Your configuration home is `~/.veyyon`, and the default profile keeps its agent directory at `~/.veyyon/profiles/default/agent/`.

If an install is interrupted before the final replacement, run it again. The installer stages the binary beside its final path, so a partial download never overwrites an existing `veyyon`. On Linux and macOS, the verified file takes the live path with one same-filesystem rename. On Windows, the installer moves the old binary aside immediately before replacement and restores it if moving the staged file fails.

Ctrl-C removes the staged file on the way out. A kill the process cannot catch can leave that staged file behind, and the next install reclaims it and names it:

```console
  ok  removed /home/you/.local/bin/.veyyon.download.48213 left by an interrupted install (pid 48213)
```

A staged file belonging to an installer that is still running is left alone, so two installs at once cannot delete each other's download.

## Install a specific release

### Linux or macOS

The POSIX installer takes long options. Pass them after `-- ` when you pipe the script:

```console
$ curl -fsSL https://get.veyyon.dev | sh -s -- --help
$ curl -fsSL https://get.veyyon.dev | sh -s -- --binary --ref v1.0.11   # a specific release binary
$ curl -fsSL https://get.veyyon.dev | sh -s -- --ref v1.0.11            # the same thing: --binary is the default
$ curl -fsSL https://get.veyyon.dev | sh -s -- --local                  # install a binary you built yourself
```

### Windows

The PowerShell installer uses named PowerShell parameters. Create a script block from the downloaded installer so you can pass them:

```powershell
& ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Help
& ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Binary -Ref v1.0.11  # a specific release binary
& ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Ref v1.0.11          # the same thing: -Binary is the default
& ([scriptblock]::Create((irm https://veyyon.dev/install.ps1))) -Local                # install a binary you built yourself
```

You cannot append parameters to `irm ... | iex`. Use the script-block form above whenever you need an option. If you downloaded `install.ps1` as a file instead, use the same parameters with `pwsh -File install.ps1`.

Release tags carry a leading `v`, and `--ref 1.0.11` on POSIX or `-Ref 1.0.11` on Windows works as well as the leading-`v` form. The installer looks for the tag you named, then for the `v` form, and prints which one it resolved to before it downloads anything. It does that only for something that reads as a version. `--ref` names a published release tag and nothing else, so a branch or a commit is looked up once and then refused.

### Run an unreleased ref, or an unsupported platform

The installer only installs a published release binary. It never clones the repository, never runs `bun install`, and never builds anything. To run an unreleased branch or commit, or to get Veyyon onto a platform with no release, clone the repository yourself:

```console
$ git clone https://github.com/santhreal/veyyon.git
$ cd veyyon
$ bun run setup      # installs workspace deps and builds @veyyon/natives
$ bun dev --version
```

To pin a ref, check it out before you run setup:

```console
$ git clone https://github.com/santhreal/veyyon.git
$ cd veyyon
$ git checkout v1.0.11
$ bun run setup
$ bun dev --version
```

Clone it into whatever directory you want it in. That tree is a developer checkout you own: you chose where it lives, you decide when it moves or goes away, and the installer never creates one and never writes into one. `bun dev` runs Veyyon straight from TypeScript in that tree, so there is no separate build step. Use it while you are evaluating Veyyon or contributing to it.

Building from a checkout needs Bun and Git, and you install those yourself. It also needs [git-lfs](https://git-lfs.com) if the ref you checked out tracks files through Git LFS, because without git-lfs those files arrive as small pointer text files that look present and then fail at runtime.

If you build a release binary in that checkout, you can put it on your `PATH` with the installer rather than copying it by hand. Pass `--local` on POSIX or `-Local` on Windows. That installs the binary you already built, with the same alias, `PATH`, and completion handling a download gets, and it still clones nothing.

## Verify the install

```console
$ vey --version
$ vey plugin doctor
$ vey plugin doctor --fix
```

`vey plugin doctor` checks plugin installation health (directories, manifests, entry paths, enabled features). Binary and provider-key checks live in `vey setup status`. For interactive diagnostics, use `/debug` in the TUI. See [Diagnostics](../features/doctor.md).

### When the staged binary would not run

The preflight runs from the staging path inside the install directory. If the binary cannot start or its native search fails, the error includes the exit status and repeats what the system said. A missing shared library means the machine needs that package. A permission error usually means the install directory is mounted `noexec`, so choose another with `VEYYON_INSTALL_DIR`. A native-addon load error usually means the release does not support that platform, so clone the repository and build it yourself instead.

This failure occurs before the active binary, alias, `PATH`, and completion files change. Fix the reported cause and run the installer again rather than trying to finish by hand.

To ask the same questions later, on the machine as it is now, run `veyyon setup status`.
It repeats the install checks and adds the two the installer cannot make: whether a second
copy of `veyyon` earlier on your `PATH` is shadowing this one, and whether the completion
files are still there. It exits non-zero when something is actually broken, so a script can
gate on it. See [Diagnostics and health](../features/doctor.md).

### Relocate the config directory

On Unix, Veyyon uses `~/.veyyon` by default. Two environment variables let you move it. `VEYYON_CONFIG_DIR` renames the home-relative config directory, and `VEYYON_CODING_AGENT_DIR` relocates the agent base, which holds `config.yml`, `agent.db`, your sessions, and more.

```console
$ export VEYYON_CODING_AGENT_DIR=/path/to/veyyon-agent
$ vey plugin doctor
```

The [File locations](../reference/file-locations.md) chapter shows the full layout.

## First credentials

On the first interactive launch, the first-run setup (or `veyyon setup`) walks you through sign-in and API keys. Inside a session you have three ways to manage credentials: open the setup panel again with `/setup`, manage the accounts you already have with `/providers`, run `/login` (or `/login <provider>`) for OAuth and key entry, or export the provider's environment variable and skip the interactive step. See [Authentication](./authentication.md) and [Configuring providers](./configuring-providers.md).

## Updating

Veyyon keeps itself current. On startup it checks GitHub Releases for a newer
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

The check costs one request to `github.com`, and no request to the GitHub API.
It reads the newest version out of where `https://github.com/santhreal/veyyon/releases/latest`
redirects to, the same way the installer does, because the API is capped at 60
requests an hour per address and that cap is shared by everyone behind it. A
laptop is nowhere near it; an office, a CI fleet or a container host running
several agents spent it on startup checks alone, and then every machine behind
that address reported that it could not check for updates. Nothing here needs a
token, and setting one changes nothing.

The one thing that still asks the API is the version list behind `veyyon
rollback`, because a list of every published version has no redirect to read it
from. That runs when you open the picker, not on startup.

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
Current version: 1.0.37
New version available: 1.0.38
  ok  Checksum verified
  ok  Updated to 1.0.38. Restart veyyon to run it.
Changelog for 1.0.38: https://veyyon.dev/changelog#v1-0-38
```

The last line is the same changelog link `veyyon rollback` prints, so however you
change version you are told where to read what changed. If an update fails,
Veyyon points you at `veyyon rollback` in the same breath, since a failed update
is the moment you most want the way back.

A checkout install uses the same recoverable contract. That is a `veyyon` on your `PATH` that runs out of a git clone you made yourself. Before it fast-forwards, Veyyon requires a clean tracked tree and records the current Git revision. If dependency installation, generated artifacts, native provisioning, version verification, or the runtime search probe fails after the merge, it resets to that revision, restores the old dependencies and generated artifacts, and proves the restored launcher runs before it reports the failure.

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
machine has been on before. Every version change is recorded, whether it came
from an update, from a background automatic update, or from a rollback, so
`previously run` marks the whole path this install has taken rather than only the
times it went backwards. Then name the one you want:

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

Building that list is the one thing Veyyon asks the GitHub API for, so it is also
the one thing that can be refused because of the API's per-address limit. When it
is, the error says so and says what still works: updating forward does not touch
the API, so `veyyon update` is unaffected. Wait a few minutes and the list comes
back.

You can also reach the picker without leaving a session. Open `/settings`, go to
the `Interaction` tab, and you will find `Roll back version` directly under
`Automatic Updates`, showing the version you are running now. It opens the same
picker, and choosing a version closes the settings panel first so you can watch
the install and read anything it has to tell you. The row appears only on an
install that can actually perform the move, so you will not see it on a source
checkout.

Veyyon is distributed only two ways, and it updates the way it was installed. A
binary install fetches its replacement from GitHub Releases. The updater stages
the download beside the live executable, then performs the same ordered
preflight as the installer: published SHA-256 checksum, exact release version,
and a real native-backed search. The search is skipped only when rolling back to
an old version that has no `veyyon grep` command, which the staged binary must
confirm through its own `--help`. If any preflight fails, the staged file is
removed and the binary you started with stays live.

After preflight, Veyyon preserves the current executable as a backup without
removing its live path, using a hard link where the filesystem permits it and a
completed copy otherwise. One atomic rename then switches the live path to the
verified replacement. A hard kill can therefore leave the old binary or the new
one at that path, but never no binary. If the final installed check fails, the
backup is atomically restored. A backup that is still locked on Windows, or is
left by a hard kill, is reclaimed by a later update.

A source checkout updates in its own terms: `veyyon update` fast-forwards the
checkout, reinstalls dependencies, regenerates build artifacts, and refreshes
the native addon, all in one command. It then reads the checkout's own version
back and refuses to report success unless the checkout really is at the new
release. A fast-forward only advances the branch you are on, so a checkout on a
feature branch, or on a fork whose upstream lags, can merge cleanly and stay
behind; Veyyon tells you that instead of claiming a version you do not have. The
background updater leaves source checkouts alone and never runs git against your
working tree. It tells you a version exists, and you run `veyyon update` when
you want it. There is no npm, Homebrew, or other package-manager channel to go
through. If an update fails, Veyyon says so and tells you to retry with `veyyon
update`; it never fails quietly and leaves you on an old version without a word.

Veyyon works out which of the two you have by following the `veyyon` on your
PATH to what it really runs. A symlink is followed, and so is a small wrapper
script that hands off to something else: if what it hands off to is a checkout's
launcher, the install runs from that checkout and gets the checkout update. That
matters if you keep your own wrapper in front of a checkout, to set an
environment variable or pick a different interpreter, because without following
it Veyyon would treat the wrapper as a binary and overwrite it with a downloaded
release, leaving your checkout orphaned. A wrapper is recognized on either
platform: a `.cmd` or `.bat` file, or any file starting with `#!`. The release
binary itself is never read looking for one.

If the same version fails to install twice, the cause is usually the machine
rather than the release: a binary owned by another user, a read-only image, or a
directory that needs elevated permissions to write. Veyyon reports that failure
and then leaves it alone for six hours instead of repeating it on every launch. A
newer release is never held back by an older one's failure, and `veyyon update`
ignores the pause entirely, so you can always ask to see the error again:

```console
$ veyyon update
```

An update also rewrites the shell completion files you already have, so tab
completion knows about the new version's subcommands and flags. It rewrites only
files that are already there because the installer owns the choice of shells.
If a file cannot be rewritten, a manual update names the path and says it still
describes the previous version. A background automatic update adds a visible
warning to the TUI update notice, counts the stale completion files, and tells
you to re-run the installer to rewrite them. The binary update remains
installed. A binary update generates completions from the new binary; a source
update generates them from the checkout's launcher.

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

The `PATH` line goes too. When the install directory was not already on your `PATH`, the installer appended two lines to your shell profile: a comment naming itself, and the line that adds the directory. On bash and zsh the pair looks like this, with the directory in single quotes so a name containing `$`, a backtick or a space is used literally rather than expanded when the profile is sourced:

```sh
# added by the veyyon installer
export PATH='/home/you/.local/bin':"$PATH"
```

On fish it is `fish_add_path '/home/you/.local/bin'` instead. Uninstall removes that exact line, and the comment directly above it when the comment is still there, and nothing else: a line you wrote yourself that happens to name the same directory stays. Installs made before the quoting was added wrote `export PATH="/home/you/.local/bin:$PATH"`, and uninstall recognizes that older form too, so upgrading and then uninstalling does not strand a line in your profile.

Because a profile is read when a shell starts, the shell you ran the uninstall in still has the old entry on its `PATH`, and bash and zsh also remember where they last found a command. The uninstall says so:

```console
veyyon uninstalled.
  your shell keeps the old PATH entry until it reloads: exec $SHELL -l
```

Without that, typing `veyyon` straight after uninstalling answers "No such file or directory" for a path you can see is gone, which reads as a half-finished uninstall.

It also reclaims what an UPDATE may have left. An update stages the new binary
beside the old one and keeps the one it replaces as a backup until the new one
has proved itself, and on Windows that backup cannot be deleted while the process
holding it is still running, so a `veyyon.new` or a `veyyon.<numbers>.bak` can
outlive the update that made it. Uninstall removes those too, so the install
directory is left empty rather than holding a few hundred megabytes you have no
name for.

Two things it deliberately leaves behind. If you already had your own `vey` command, the installer never created that alias in the first place (it says so at install time and tells you to launch with `veyyon`), so uninstall does not touch it or its completion file. And if a checkout at `~/.veyyon/src` has uncommitted edits or commits on a local branch that is on no remote, it is moved to `~/.veyyon/src.bak-<timestamp>` instead of being deleted, so nothing you wrote is lost. Older installers created that tree. The current installer never does, so uninstall only ever cleans up one an older version left behind.

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
