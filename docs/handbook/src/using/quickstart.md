# Quickstart

From install to a first approved code change in about five minutes. Full path: [Getting started](./getting-started.md).

## Before you start

```shell
which veyyon
veyyon --version
```

If missing:

```shell
bun install -g @veyyon/pi-coding-agent
```

Or from source: `bun setup && bun dev` in the repo root.

## Check the environment

**Shipped today:** plugin and extension health checks:

```shell
veyyon plugin doctor
```

Optional: `/debug` in the TUI for interactive diagnostics.

> **Spec — not shipped:** a top-level `veyyon doctor` install health command. Use `veyyon plugin doctor` and the TUI `/debug` today. See [Diagnostics and health](../features/doctor.md).

Config and sessions live under `~/.veyyon/agent/` by default (`PI_CONFIG_DIR` can rename the home-relative dir).

## Start your first session

```shell
cd my-project
veyyon
```

You should see the TUI composer, model indicator, and workspace path.

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
