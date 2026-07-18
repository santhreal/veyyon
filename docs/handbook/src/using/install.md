# Install

Veyyon ships as the npm package **`@veyyon/coding-agent`** and installs the `veyyon`
executable. It is a TypeScript + Bun agent loop with Rust natives (`@veyyon/natives`) for hot paths
(grep, walker, shell/PTY, hashline edits). After install, run `veyyon plugin doctor`.

## Requirements

- **Bun** (recommended runtime) or a recent Node.js.
- **Git** — most workflows expect a repository.

## Install (npm / Bun)

```console
$ bun install -g @veyyon/coding-agent
$ veyyon --version
```

npm works too:

```console
$ npm install -g @veyyon/coding-agent
$ veyyon --version
```

`bun install` also builds `@veyyon/natives`. Config home: `~/.veyyon`; default profile agent dir: `~/.veyyon/profiles/default/agent/`.

## After install

The first interactive `veyyon` opens the first-run setup (splash → providers → glyphs → theme → outro). Force it again with `veyyon setup`. Re-open providers inside a session with `/setup` or `/providers`. See [Getting started](./getting-started.md).

## Build from source

```console
$ git clone https://github.com/santhreal/veyyon.git
$ cd veyyon
$ bun setup      # installs workspace deps and builds @veyyon/natives
$ bun dev --version
```

`bun dev` runs the in-repo build; use it while evaluating or contributing.

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

`veyyon plugin doctor` checks plugin health and warns when optional external binaries (`sd`, `sg`,
`git`) or common API keys are missing. For interactive diagnostics use `/debug` in the TUI. See
[Diagnostics](../features/doctor.md).

### Relocate the config directory

By default Unix uses `~/.veyyon`. `VEYYON_CONFIG_DIR` renames the
home-relative config directory; `VEYYON_CODING_AGENT_DIR` relocates
the agent base (`config.yml`, `agent.db`, sessions, and more):

```console
$ export VEYYON_CODING_AGENT_DIR=/path/to/veyyon-agent
$ veyyon plugin doctor
```

Layout: [File locations](../reference/file-locations.md).

## First credentials

On first interactive launch, first-run setup (or `veyyon setup`) walks sign-in and API keys.
Inside a session, use `/setup` / `/providers` to re-open that panel, `/login` (or `/login <provider>`)
for OAuth and key entry, or export the provider's environment variable and skip the interactive step.
See [Authentication](./authentication.md) and [Configuring providers](./configuring-providers.md).

## Uninstall

Remove the global package:

```console
$ bun remove -g @veyyon/coding-agent
$ # or: npm uninstall -g @veyyon/coding-agent
```

Then remove state if you want a clean machine:

```console
$ rm -rf ~/.veyyon          # irreversible: config, secrets, sessions, plugins, skills, logs
$ # if you relocated the agent base:
$ rm -rf "$VEYYON_CODING_AGENT_DIR"
```

Project-local files (`AGENTS.md`, `.veyyon/` in a repo) are **not** removed by deleting the
home directory — clean those per repository if desired.

To keep projects but wipe only sessions:

```console
$ rm -rf ~/.veyyon/profiles/default/agent/sessions
```

## Next

- [Getting started](./getting-started.md) — first interactive edit with sample terminal output.
- [Model contract](../concepts/model-contract.md) — choose credentials with the harness boundary in mind.
- [Safety](./safety.md) — approvals and fail-closed behavior.
- [Troubleshooting](./troubleshooting.md) / [FAQ](./faq.md) — when the doctor is not enough.
