# Skills

Skills are reusable capabilities Veyyon can draw on. They are defined as data on the filesystem rather than compiled into the Veyyon binary. This structure lets you add, customize, and share capabilities without editing code.

For general information on Veyyon extension capabilities, see [Tools, skills, and extension data](../using/extending.md).

## Skill locations

Veyyon loads skills from several locations depending on the desired scope.

| Scope | Location | Description |
| --- | --- | --- |
| **User** | `$HOME/.veyyon/agent/skills` | User-installed skills (per profile: `$HOME/.veyyon/profiles/<name>/agent/skills`). |
| **Project** | `.veyyon/skills` | Project skills; discovered by walking up from the working directory, closest ancestor first. |
| **Agents layout** | `.agent/skills`, `.agents/skills`, `$HOME/.agents/skills` | Skills in the cross-tool agents layout (project walk-up plus user home). |
| **Managed** | `$HOME/.veyyon/agent/managed-skills` | Auto-learn skills Veyyon writes itself; a same-named authored skill always wins. |
| **Other tools** | `$HOME/.claude/skills`, `.github/skills/<name>/SKILL.md`, … | Foreign-tool skills imported when discovery of other tools' config is on (next section). |

Full provider list, priorities, and dedup rules: [`docs/skills.md`](../../../skills.md).

## Other tools' skills and config (on by default)

By default Veyyon also discovers skills, context files (`CLAUDE.md`, standalone
`AGENTS.md`), rules, and MCP servers authored for other AI coding tools —
Claude, Codex, Gemini, Cursor, opencode, Windsurf, Cline, and similar — found on
disk. Your global `CLAUDE.md` and existing external skills load as a shared base
layer, so Veyyon works with the config you already have.

To run Veyyon on its **own** config only, turn off the single toggle in
**Settings › Providers › Discovery › Import Other Tools' Config**, or set it in
`config.yml`:

```yaml
discovery:
  importForeignConfig: false
```

When it is off, those foreign sources are skipped entirely — they never appear
in `/extensions`, in the enable/disable list, or in the model's context. When it is
on (the default), the per-source toggles under `skills.*` (for example
`skills.enableClaudeUser`) give finer control. Veyyon's own `AGENTS.md` lives in
`.veyyon/` (project) and `$HOME/.veyyon/agent` (user); those are always read and
are not affected by this toggle.

## Profiles isolate skills

Each [profile](./profiles.md) is a separate config root
(`$HOME/.veyyon/profiles/<name>/agent`). Every skill source Veyyon owns — user
skills, managed (auto-learn) skills, and plugin skills — resolves under that
root, so profiles never share a skill directory:

- Switching profiles re-homes user and managed skills to the active profile.
- The `discovery.importForeignConfig` toggle and all `skills.*` settings are
  stored per profile, so one profile can import other tools' skills while
  another stays clean.

Two things are shared on purpose: **project** skills (`.veyyon/skills` next to
your code) belong to the repository, not a profile; and another tool's own skill
directory (`$HOME/.claude/skills`, ...) is global to the machine — a profile
cannot relocate it, so per-profile isolation there means each profile decides
independently whether to import it (via `discovery.importForeignConfig`, which
is stored per profile and on by default).

## Skill structure

Each skill is defined in its own subdirectory containing a `SKILL.md` file.

### The skill file (`SKILL.md`)

The `SKILL.md` file defines the skill's system prompt instructions and must start with a YAML frontmatter block delimited by `---`.

Here is an example `SKILL.md` file.

```markdown
---
name: my-custom-skill
description: Performs a custom code audit or analysis.
metadata:
  short-description: Audit code for typical issues.
---

# My Custom Skill

Use this skill when analyzing source files. Ensure you focus on:
1. Logic errors.
2. Unhandled edge cases.
```

The frontmatter contains these fields.

- `name`: The name of the skill (optional). Defaults to the name of the parent folder.
- `description`: A description of what the skill does (optional).
- `metadata`: Nested metadata block (optional).
  - `short-description`: A short summary of the skill (optional).

### Optional configuration (`agents/openai.yaml`)

You can configure dependencies, policy settings, and interface preferences by adding an `agents/openai.yaml` file in the skill's subdirectory. This file name is inherited from oh-my-pi's upstream skill format.

Here is an example `agents/openai.yaml` file.

```yaml
interface:
  display_name: "Code Auditor"
  short_description: "Audit code for typical issues"
  brand_color: "#C6CBD4"
  default_prompt: "Audit the files in the current workspace"
dependencies:
  tools:
    - type: "command"
      value: "cargo check"
      description: "Checks Rust project compilation"
policy:
  allow_implicit_invocation: true
  products:
    - veyyon
```

The following fields are available in `agents/openai.yaml`.

- `interface`: TUI presentation settings (optional).
  - `display_name`: The display name shown in TUI lists (optional).
  - `short_description`: A short description (optional).
  - `icon_small` / `icon_large`: Filesystem paths to icons (optional).
  - `brand_color`: A hex color code or color name (optional).
  - `default_prompt`: Pre-filled text when launching the skill (optional).
- `dependencies`: List of tools needed for the skill (optional).
  - `tools`: A list of dependency blocks. Each block can specify a `type` (for example, `command` or `url`), a `value` (for example, the command name or URL), a `description`, an optional `transport`, an optional `command` path, and an optional `url`.
- `policy`: Restrict how the skill is invoked (optional).
  - `allow_implicit_invocation`: A boolean (defaults to `true`). If `false`, the skill will not be implicitly suggested or automatically injected by the model.
  - `products`: A list of product names to restrict the skill to (for example, `veyyon`). If set, the skill only loads for matching products.

## Configuration

Skills are configured in the `skills` block of Veyyon's `config.yml` file.

### Master switch

`skills.enabled` (default `true`) turns skill discovery off entirely:

```yaml
skills:
  enabled: false
```

### Enable or disable discovery sources

Each discovery source has its own toggle, all defaulting to `true`: `enableCodexUser`,
`enableClaudeUser`, `enableClaudeProject`, `enablePiUser`, `enablePiProject`,
`enableAgentsUser`, `enableAgentsProject`. `customDirectories` adds extra directories to
scan, and `enableSkillCommands` (default `true`) controls whether skills also register as
`/skill:name` commands.

```yaml
skills:
  enableClaudeUser: false
  customDirectories:
    - /opt/team-skills
```

### Manage individual skills

`includeSkills` and `ignoredSkills` are glob lists matched against skill names. An empty
`includeSkills` means every discovered skill is active; `ignoredSkills` then subtracts.

```yaml
skills:
  ignoredSkills:
    - my-custom-skill
    - internal-*
```

## Interactive TUI controls

In the terminal user interface, you can manage and list skills interactively.

### Slash commands

- `/extensions` opens the Extension Control Center, which lists every discovered skill alongside tools and hooks, and lets you enable or disable individual skills.

When you close the toggle list, the TUI displays a status message stating how many skills were enabled or disabled.

## Related recipes

For goal-shaped "give the agent a new capability" flows that stitch skills with MCP and
plugins, see [Task guides](../using/task-guides.md).

Engineering detail: [`docs/skills.md`](../../../skills.md).
