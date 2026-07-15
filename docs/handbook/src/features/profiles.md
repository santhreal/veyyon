# Profiles

A **profile** is a named config root that relocates Veyyon's user-level agent directory. It lets you keep separate settings, sessions, MCP config, skills, and hooks for different kinds of work (for example `work` vs `bounty`) while sharing one `veyyon` binary.

For the mental model and roles, see [Roles and profiles](../using/roles-and-profiles.md).

## What a profile owns (shipped)

When `--profile <name>` is active (or `VEYYON_PROFILE` is set), native Veyyon paths under `~/.veyyon/agent/` resolve to:

```text
~/.veyyon/profiles/<name>/agent/
```

That relocation is uniform across settings, sessions, blobs, slash commands, rules, prompts, hooks, tools, extensions, skills, MCP, keybindings, theme, and top-level instruction files (`SYSTEM.md`, `RULES.md`, `AGENTS.md`) discovered from the user agent dir. A named profile does **not** read another profile's `agent/` tree at runtime.

**Keybindings:** each profile owns `agent/keybindings.*`. New profiles seeded with `veyyon profile new --from default` copy the default profile's keybindings once. On first launch of an older named profile that has no keybindings file, Veyyon performs the same one-time seed and logs it. There is no live merge from the default profile after that.

Project-level dirs (`<cwd>/.veyyon`, `.claude`, etc.) are **not** profile-scoped; they follow the working directory.

## Activating a profile

- **CLI:** `veyyon --profile <name>` (no short form; `-p` is `--print`).
- **Env:** `VEYYON_PROFILE=<name>` (legacy: `OMP_PROFILE`, `PI_PROFILE`).
- **Shell alias:** `veyyon --profile work --alias mywork` installs a managed block in your shell rc (see `cli/profile-alias.ts`).

Profiles are chosen at process start. There is no `/profile` slash command in the shipped TUI; start a new `veyyon` invocation to switch.

## Creating and managing profiles

```console
$ veyyon profile list
$ veyyon profile new work
$ veyyon profile new bounty --from blank
$ veyyon profile rm work --yes
```

- `new` creates `~/.veyyon/profiles/<name>/agent/` with the expected identity dirs (`skills/`, `commands/`, …).
- `--from default` (default) seeds `config.yml`, keybindings, MCP, skills, and other identity files from the default profile. Sessions, blobs, and databases are **not** copied.
- `--from blank` creates an empty agent tree.
- `rm` refuses the default profile, the active profile, and destructive deletes without `--yes`.

You can still create a profile implicitly by running `veyyon --profile <name>` once; use `profile new` when you want seeding without launching the TUI.

Do not document inline `[profiles.<name>]` tables or standalone `<name>.config.yml` files as shipped; settings use `config.yml` under the active agent dir.

## Model slots and roles (per profile)

Each profile's `config.yml` owns the three model slots and optional roles:

```yaml
model: openai/gpt-5                 # interactive (also set live with /model)
subagent:
  model: deepseek/deepseek-chat
compaction:
  model: openai/gpt-5-mini
  strategy: handoff                 # or snap
  thresholdPercent: 80
modelRoles:                         # optional; settings → Models → Roles
  plan: openai/o3
```

`default` is not a model or role. Switching profiles switches these assignments with the profile.

## See also

- [Models, roles, and profiles](../using/roles-and-profiles.md)
- [Configuration](../using/configuration.md)
- [File locations](../reference/file-locations.md)
