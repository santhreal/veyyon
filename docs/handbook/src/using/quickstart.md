# Quickstart

Install, first session, and a small edit. Full path: [Getting started](./getting-started.md).

## Before you start

```shell
which vey
vey --version
```

If missing, the one-command installer (wires PATH, completions, and the `vey` alias):

```shell
curl -fsSL https://get.veyyon.dev | sh
```

Or from the npm registry: `bun install -g @veyyon/coding-agent`. From source: `bun setup && bun dev`
in the repo root. See [Install](./install.md).

## Check the environment

```shell
veyyon plugin doctor
```

In the TUI, `/debug` opens interactive diagnostics. See [Diagnostics and health](../features/doctor.md).

Config and sessions live under `~/.veyyon/profiles/default/agent/` by default (`VEYYON_CONFIG_DIR` / `VEYYON_CONFIG_DIR` / `VEYYON_CONFIG_DIR` can rename the home-relative dir). Named profiles use `~/.veyyon/profiles/<name>/agent/`.

## Start your first session

```shell
cd my-project
vey
```

**First interactive launch** shows the first-run setup (splash → providers → glyphs → theme → outro), then the welcome screen and composer. Resume / `VEYYON_SKIP_SETUP=1` skips it. Re-open providers later with `/setup` or `/providers`, or run `veyyon setup` from the shell.

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
