# Quickstart

From install to a first approved code change in about five minutes. Full path: [Getting started](./getting-started.md).

## Before you start

```shell
which vey
vey --version
```

If missing, the one-command installer (wires PATH, completions, and the `vey` alias):

```shell
curl -fsSL https://get.veyyon.dev | sh
```

Or from the npm registry: `bun install -g @veyyon/pi-coding-agent`. From source: `bun setup && bun dev`
in the repo root. See [Install](./install.md).

## Check the environment

**Shipped today:** plugin and extension health checks:

```shell
veyyon plugin doctor
```

Optional: `/debug` in the TUI for interactive diagnostics.

> **Spec — not shipped:** a top-level `veyyon doctor` install health command. Use `veyyon plugin doctor` and the TUI `/debug` today. See [Diagnostics and health](../features/doctor.md).

Config and sessions live under `~/.veyyon/agent/` by default (`VEYYON_CONFIG_DIR` / `OMP_CONFIG_DIR` / `PI_CONFIG_DIR` can rename the home-relative dir).

## Start your first session

```shell
cd my-project
vey
```

**First interactive launch** shows the setup ceremony (splash → providers → glyphs → theme → outro), then the welcome screen and composer. Resume / `VEYYON_SKIP_SETUP=1` skips it. Re-open providers later with `/setup` or `/providers`, or run `veyyon setup` from the shell.

After that you should see the TUI composer, model indicator, and workspace path.

## Ask for a small edit

```text
> Add a name argument to greet() in greet.py, default 'world'.
```

Veyyon reads the file, proposes an `edit` or hashline change, and may pause for approval depending on `tools.approvalMode`. Press `y` to accept when prompted.

## Composer conveniences

- `@` — file/skill/plugin completion
- `/` — slash commands (`/help`, `/tree`, `/settings`, …)
- `Esc` — interrupt a running turn
- `?` — shortcut hints on empty composer

## Next steps

- [Editing and repair](./editing.md)
- [Safety](./safety.md)
- [Configuration](./configuration.md)
- [CLI reference](../reference/cli.md)

You now know the loop: start `veyyon`, ask, approve tools, inspect diffs.
