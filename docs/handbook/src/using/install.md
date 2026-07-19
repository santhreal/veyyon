# Install

Veyyon ships as the npm package `@veyyon/coding-agent`, and installing it gives you the `veyyon` executable. Under the hood it is a TypeScript and Bun agent loop, with Rust natives in `@veyyon/natives` handling the hot paths: grep, the file walker, the shell and PTY, and hashline edits. After you install, run `veyyon plugin doctor` to confirm everything is wired up.

## Requirements

You need two things:

- **Bun**, which is the recommended runtime, or a recent Node.js.
- **Git**, because most workflows expect to run inside a repository.

## Install with npm or Bun

```console
$ bun install -g @veyyon/coding-agent
$ veyyon --version
```

npm works too:

```console
$ npm install -g @veyyon/coding-agent
$ veyyon --version
```

The install step also builds `@veyyon/natives`. Your configuration home is `~/.veyyon`, and the default profile keeps its agent directory at `~/.veyyon/profiles/default/agent/`.

## After install

The first interactive `veyyon` opens the first-run setup, which moves through a splash, providers, glyphs, theme, and an outro. To run it again later, use `veyyon setup`. To re-open just the providers panel inside a session, use `/setup` or `/providers`. See [Getting started](./getting-started.md).

## Build from source

```console
$ git clone https://github.com/santhreal/veyyon.git
$ cd veyyon
$ bun setup      # installs workspace deps and builds @veyyon/natives
$ bun dev --version
```

`bun dev` runs the in-repo build. Use it while you are evaluating Veyyon or contributing to it.

## Shell completions

```console
$ veyyon completions bash|zsh|fish
```

## Verify the install

```console
$ veyyon --version
$ veyyon plugin doctor
$ veyyon plugin doctor --fix
```

`veyyon plugin doctor` checks plugin health and warns you when an optional external binary (`sd`, `sg`, or `git`) or a common API key is missing. For interactive diagnostics, use `/debug` in the TUI. See [Diagnostics](../features/doctor.md).

### Relocate the config directory

On Unix, Veyyon uses `~/.veyyon` by default. Two environment variables let you move it. `VEYYON_CONFIG_DIR` renames the home-relative config directory, and `VEYYON_CODING_AGENT_DIR` relocates the agent base, which holds `config.yml`, `agent.db`, your sessions, and more.

```console
$ export VEYYON_CODING_AGENT_DIR=/path/to/veyyon-agent
$ veyyon plugin doctor
```

The [File locations](../reference/file-locations.md) chapter shows the full layout.

## First credentials

On the first interactive launch, the first-run setup (or `veyyon setup`) walks you through sign-in and API keys. Inside a session you have three ways to manage credentials: open the panel again with `/setup` or `/providers`, run `/login` (or `/login <provider>`) for OAuth and key entry, or export the provider's environment variable and skip the interactive step. See [Authentication](./authentication.md) and [Configuring providers](./configuring-providers.md).

## Uninstall

Remove the global package:

```console
$ bun remove -g @veyyon/coding-agent
$ # or: npm uninstall -g @veyyon/coding-agent
```

Then remove your state if you want a clean machine:

```console
$ rm -rf ~/.veyyon          # irreversible: config, secrets, sessions, plugins, skills, logs
$ # if you relocated the agent base:
$ rm -rf "$VEYYON_CODING_AGENT_DIR"
```

Deleting the home directory does not remove project-local files such as a repository's `AGENTS.md` or its `.veyyon/` directory. Clean those per repository if you want to.

To keep your projects but wipe only sessions:

```console
$ rm -rf ~/.veyyon/profiles/default/agent/sessions
```

## Next

- [Getting started](./getting-started.md) walks through a first interactive edit, with sample terminal output.
- [Model contract](../concepts/model-contract.md) helps you choose credentials with the harness boundary in mind.
- [Safety](./safety.md) covers approvals and fail-closed behavior.
- [Troubleshooting](./troubleshooting.md) and the [FAQ](./faq.md) are there for when the doctor is not enough.
