# Install

The fastest path is the one-command installer: it downloads a checksum-verified binary from GitHub
releases, wires your PATH and shell completions, creates the short `vey` alias, and finishes with a
doctor self-test.

```console
$ curl -fsSL https://get.veyyon.dev | sh
$ vey --version
```

Windows (PowerShell):

```powershell
irm https://veyyon.dev/install.ps1 | iex
```

Veyyon is a TypeScript + Bun agent loop with Rust natives (`@veyyon/pi-natives`) for hot paths
(grep, walker, shell/PTY, hashline edits). Both `veyyon` and the shorter `vey` launch it.

## Requirements

- **Git** — most workflows expect a repository.

There is no OS-level shell sandbox (no Landlock/seccomp/Seatbelt/bubblewrap requirement); the
approval mode is the safety boundary — see [Approvals and autonomy](../features/sandbox.md).

## Install (npm / Bun)

If you prefer to run from the package registry, Veyyon ships as **`@veyyon/pi-coding-agent`**
and installs the `veyyon` executable:

```console
$ bun install -g @veyyon/pi-coding-agent
$ veyyon --version
```

npm works too:

```console
$ npm install -g @veyyon/pi-coding-agent
$ veyyon --version
```

`bun install` also builds `@veyyon/pi-natives`. Config and state default to `~/.veyyon`.

## After install

The first interactive `veyyon` opens the setup ceremony (splash → providers → glyphs → theme →
outro). Force it again with `veyyon setup`. Re-open providers inside a session with `/setup` or
`/providers`. See [Getting started](./getting-started.md).

## Build from source

```console
$ git clone https://github.com/santhreal/veyyon.git
$ cd veyyon
$ bun setup      # installs workspace deps and builds @veyyon/pi-natives
$ bun dev --version
```

`bun dev` runs the in-repo build; use it while evaluating or contributing.

## Shell completions

The one-command installer wires these for you. From a package install:

```console
$ veyyon completions bash|zsh|fish
```

## Verify the install

```console
$ vey --version
$ veyyon plugin doctor
$ veyyon plugin doctor --fix
```

`veyyon plugin doctor` checks plugin health and warns when optional external binaries (`sd`, `sg`,
`git`) or common API keys are missing. See [Diagnostics](../features/doctor.md).

## Uninstall

Installed with the one-command installer:

```console
$ curl -fsSL https://get.veyyon.dev | sh -s -- --uninstall
```

That removes the binary, the `vey` alias, the global package, and the shell completions.
