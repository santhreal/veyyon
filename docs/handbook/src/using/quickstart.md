# Quickstart

This is the short path: install Veyyon, start a session, and make one small edit. For the full walkthrough, see [Getting started](./getting-started.md).

## Before you start

Check whether Veyyon is already on your machine:

```shell
which vey
vey --version
```

If it is missing, the one-command installer wires up your PATH, shell completions, and the `vey` alias:

```shell
curl -fsSL https://get.veyyon.dev | sh
```

You can also pin a release binary with `curl -fsSL https://get.veyyon.dev | sh -s -- --ref v1.0.11`. The installer only ever downloads a published release binary. To run an unreleased ref instead, clone the repository yourself and run `bun run setup && bun dev` in that checkout. See [Install](./install.md).

## Check the environment

```shell
veyyon plugin doctor
```

Inside the TUI, `/debug` opens interactive diagnostics. See [Diagnostics and health](../features/doctor.md).

By default, your config and sessions live under `~/.veyyon/profiles/default/agent/`. Two environment variables move them: `VEYYON_CONFIG_DIR` renames the home-relative config directory, and `VEYYON_CODING_AGENT_DIR` relocates the agent base. Named profiles use `~/.veyyon/profiles/<name>/agent/`.

## Start your first session

```shell
cd my-project
vey
```

The first interactive launch shows the first-run setup (splash, providers, glyphs, theme, outro), then the welcome screen and composer. Resuming a session, or setting `VEYYON_SKIP_SETUP=1`, skips it. You can re-open provider setup later with `/setup`, or run `veyyon setup` from the shell. To manage the accounts you already have, use `/providers`.

After setup, you should see the TUI composer, the model indicator, and your workspace path.

## Ask for a small edit

```text
> Add a name argument to greet() in greet.py, default 'world'.
```

Veyyon reads the file, proposes an `edit` or hashline change, and may pause for approval depending on `tools.approvalMode`. Choose **Approve** (or **Deny**) and press Enter when it prompts you.

## Composer conveniences

A few keys do a lot in the composer:

- `@` completes file paths (fuzzy file references).
- `/` opens the slash commands, such as `/help`, `/tree`, and `/settings`.
- `Esc` interrupts a running turn.
- `/hotkeys` lists the active keyboard shortcuts.

## Next steps

- [Editing and repair](./editing.md)
- [Safety](./safety.md)
- [Configuration](./configuration.md)
- [CLI reference](../reference/cli.md)

You now know the loop: start `veyyon`, ask, approve the tools, and inspect the diffs.
