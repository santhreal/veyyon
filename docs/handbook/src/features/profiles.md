# Profiles

A **profile** is a directory under `~/.veyyon/profiles/<name>/` holding that identity’s settings, sessions, MCP, skills, hooks, logs, plugins, and caches. One binary; multiple profile trees.

Roles and profile layout: [Roles and profiles](../using/roles-and-profiles.md).

## Layout

Every profile — **including `default`** — lives under the same tree:

```text
~/.veyyon/
  config.yml            # GLOBAL settings (defaultProfile, ...) — not a profile's settings
  install-id            # per-install UUID, shared by all profiles
  profiles/
    default/            # the default profile — a real profile like any other
      agent/            # settings, sessions, skills, MCP, keybindings, ...
      logs/  plugins/  cache/  wt/  ...
    work/
      agent/
      ...
```

See [File locations](../reference/file-locations.md) for the full per-profile tree and the
one-time migration from the legacy bare-root layout.

## Which profile launches

Resolution order for every `veyyon` / `vey` invocation:

1. `--profile <name>`.
2. `VEYYON_PROFILE`. An explicitly **empty**
   `VEYYON_PROFILE=` forces `default`, bypassing step 3.
3. `defaultProfile` in the global `~/.veyyon/config.yml` — set or show it with
   `veyyon profile default [name]`.
4. `default`.

## What a profile owns (shipped)

When a profile `<name>` is active, native Veyyon paths resolve under:

```text
~/.veyyon/profiles/<name>/agent/
```

That resolution is uniform across settings, sessions, blobs, slash commands, rules, prompts, hooks, tools, extensions, skills, MCP, keybindings, theme, and top-level instruction files (`SYSTEM.md`, `RULES.md`, `AGENTS.md`) discovered from the user agent dir. Operational state (logs, plugins, caches, worktrees) resolves under the profile root `~/.veyyon/profiles/<name>/` the same way. A profile never reads another profile's tree at runtime.

**Keybindings:** each profile owns `agent/keybindings.*`. New profiles seeded with `veyyon profile new --from default` copy the default profile's keybindings once. On first launch of an older named profile that has no keybindings file, Veyyon performs the same one-time seed and logs it. There is no live merge from the default profile after that.

Project-level dirs (`<cwd>/.veyyon`, `.claude`, etc.) are **not** profile-scoped; they follow the working directory.

**Other tools' config** (skills and `CLAUDE.md`/`AGENTS.md` written for Claude, Codex, and similar) is on by default and controlled per profile by `discovery.importForeignConfig`, so one profile can keep importing it while another opts out to run native-only. Another tool's own global dir (`~/.claude/skills`, …) cannot be relocated into a profile — see [Skills › Profiles isolate skills](./skills.md#profiles-isolate-skills).

## Activating a profile

- **CLI:** `veyyon --profile <name>` (no short form; `-p` is `--print`).
- **Env:** `VEYYON_PROFILE=<name>`.
- **TUI:** `/profile <name>` ends the current conversation and relaunches Veyyon on that profile (a fresh session — profiles are chosen at process start, so there is no hot-swap). Bare `/profile` lists profiles with the active one marked.
- **Shell alias:** `veyyon --profile work --alias mywork` installs a managed block in your shell rc (see `cli/profile-alias.ts`).

## Profile names and renaming

A profile's directory name (`~/.veyyon/profiles/<name>`) is its stable identity and never changes. Each profile can additionally carry a **display name** — the `profile.displayName` setting, stored in that profile's own `config.yml`:

- **Settings:** `/settings` › Interaction › Profile › Profile Name.
- **TUI:** `/profile rename to <new>` renames the active profile; `/profile <name> rename to <new>` renames another one. The default profile is renamable too.

`/profile list` shows `name (Display Name)` when they differ, and `/profile <input>` resolves a directory name first, then a unique display name. A copied settings file never carries the source's display name — `profile new` clears it so two profiles cannot answer to one name.

## Creating and managing profiles

```console
$ veyyon profile list
$ veyyon profile new work
$ veyyon profile new bounty --from blank
$ veyyon profile rm work --yes
$ veyyon profile default work
```

- `new` creates `~/.veyyon/profiles/<name>/agent/` with the expected identity dirs (`skills/`, `commands/`, …).
- `--from default` (default) seeds `config.yml`, keybindings, MCP, skills, and other identity files from the default profile. Sessions, blobs, and databases are **not** copied.
- `--from blank` creates an empty agent tree.
- `rm` refuses the default profile, the active profile, and destructive deletes without `--yes`.
- `default [name]` shows or sets the global `defaultProfile` (which profile a bare `vey` launches); `default --clear` removes it.

In the TUI, `/profile new <name>` opens a picker listing every carry-over item — AGENTS.md, settings, MCP servers, SSH targets, skills, commands, tools, prompts, themes, extensions, keybindings — each individually toggleable (all selected by default). The new profile is seeded from the **active** profile with exactly the chosen items.

You can still create a profile implicitly by running `veyyon --profile <name>` once; use `profile new` when you want seeding without launching the TUI.

## Onboarding import

On first run (and once after upgrading past setup version 2), the setup wizard scans the machine for user-level config written for other tools — skills and `CLAUDE.md`/`AGENTS.md` from Claude Code, Codex, Cursor, and similar — and offers each item for import into your default profile. Imports **copy**: skills land in the profile's `skills/`, instruction files append to the profile's `AGENTS.md` under a source marker (re-imports are idempotent). The originals keep loading ambiently as the machine-wide base layer unless you turn off `discovery.importForeignConfig`.

Do not document inline `[profiles.<name>]` tables or standalone `<name>.config.yml` files as shipped; settings use `config.yml` under the active agent dir.

## Model slots and roles (per profile)

Each profile's `config.yml` owns the three model slots and optional roles:

```yaml
modelRoles:
  default: openai/gpt-5             # interactive (also set live with /model)
  plan: openai/o3
  smol: deepseek/deepseek-chat
subagent:
  model: deepseek/deepseek-chat     # optional override of modelRoles.task
compaction:
  model: openai/gpt-5-mini
  strategy: handoff                 # or snap
  thresholdPercent: 80
```

**Unset slots and roles inherit the live main model.** The compaction model and every model role default to "inherit": when unset, they resolve to whatever the main model is *at use time*, so switching with `/model` changes them instantly. Only an explicit assignment pins a different model. (The advisor role is the one exception — unset, it follows its thinking-model chain; the settings UI labels each role's unset behavior.) Switching profiles switches all of these assignments with the profile.

## See also

- [Models, roles, and profiles](../using/roles-and-profiles.md)
- [Configuration](../using/configuration.md)
- [File locations](../reference/file-locations.md)
