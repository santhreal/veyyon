# Skills

A skill is a folder of instructions you drop next to your code or in your profile, and the agent picks it up on its own. Use one to teach Veyyon a repeated task: how your project runs its tests, the steps of a release, the shape of a code review. Skills live on disk, not in the binary, so you add or change one by editing a file, with no rebuild.

For general information on Veyyon extension capabilities, see [Tools, skills, and extension data](../using/extending.md).

## Skill locations

Skills load only from the active profile. Veyyon reads these three locations,
all under `$HOME/.veyyon/profiles/<profile>/agent` (`profiles/default/` when you
have not selected a profile):

| Scope | Location | Description |
| --- | --- | --- |
| **User** | `.../agent/skills` | Skills you author or install for the active profile. |
| **Managed** | `.../agent/managed-skills` | Auto-learn skills Veyyon writes itself. A same-named user skill always wins. |
| **Plugins** | plugins installed into the active profile | Skills bundled with a plugin you added to this profile. |

Nothing else contributes skills. There is no autodiscovery from across your
computer: another tool's skill directory (`$HOME/.claude/skills`,
`$HOME/.codex/skills`, `$HOME/.agents/skills`, `.github/skills`, and the rest) is
never scanned, and a project-local `.veyyon/skills` directory next to your code is
not read either. Skills belong to your profile, so switching profiles switches
the whole skill set, and no repository you open can inject a skill into a session.

Full provider list and dedup rules: [`docs/skills.md`](../../../skills.md).

## Importing another tool's skills

Because foreign skills never load on their own, you bring one into Veyyon by
importing it. The onboarding import scan finds user-level skills and instruction
files that other AI tools (Claude, Codex, Gemini, Cursor, and similar) left on
disk, and copies the ones you pick into the active profile's `skills` directory.
The copy is profile-owned from then on, so it loads like any other profile skill
and is not affected by the original tool.

A separate setting, `discovery.importForeignConfig`, governs whether Veyyon reads
other tools' context files (`CLAUDE.md`, standalone `AGENTS.md`), rules, and MCP
servers, and whether it offers the import scan at all. Turn it off to run Veyyon
on its own config only:

```yaml
discovery:
  importForeignConfig: false
```

It does not change skill loading: foreign skills are never loaded ambiently
whether it is on or off. Veyyon's own `AGENTS.md` lives in `.veyyon/` (project)
and the profile's agent dir (user), and is always read.

## Profiles isolate skills

Each [profile](./profiles.md) is a separate config root
(`$HOME/.veyyon/profiles/<name>/agent`), and every skill source resolves under
that root, so profiles never share a skill directory. Switching profiles re-homes
user skills, managed (auto-learn) skills, and plugin skills to the active
profile, and all `skills.*` settings are stored per profile. One profile can hold
a large skill set while another stays empty.

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

### Skill commands

`enableSkillCommands` (default `true`) controls whether skills also register as
`/skill:name` commands.

```yaml
skills:
  enableSkillCommands: false
```

There are no per-source toggles and no `customDirectories` setting. Skills load
only from the active profile (see [Skill locations](#skill-locations)), so there
is nothing to enable or disable per source. To use a skill from another tool,
import it into your profile.

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
