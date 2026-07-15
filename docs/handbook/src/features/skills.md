# Skills

Skills are reusable capabilities Veyyon can draw on. They are defined as data on the filesystem rather than compiled into the Veyyon binary. This structure lets you add, customize, and share capabilities without editing code.

For general information on Veyyon extension capabilities, see [Tools, skills, and extension data](../using/extending.md).

## Skill locations

Veyyon loads skills from several locations depending on the desired scope.

| Scope | Location | Description |
| --- | --- | --- |
| **System** | `$VEYYON_HOME/skills/.system` | Embedded first-party skills unpacked from the binary at startup. |
| **Admin** | `/etc/veyyon/skills` | Machine-wide skills configured by administrators (on Unix-like systems). |
| **User** | `$HOME/.agents/skills` | User-installed skills. `$VEYYON_HOME/skills` is also supported as a legacy fallback. |
| **Project** | `.veyyon/skills` | Project-scoped skills placed at the root of a repository. |
| **Repository** | `.agents/skills` | Local skills discovered incrementally in directories between the working directory and the project root. |

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
  brand_color: "#B8BDC7"
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

### Include instructions

By default, Veyyon formats and appends system instructions for all active skills to the system rules block on every turn. You can disable this automatic injection.

```yaml
skills:
  include_instructions: false
```

### Enable or disable bundled skills

To disable all embedded system skills, use this configuration.

```yaml
skills:
  bundled:
    enabled: false
```

### Manage individual skills

You can selectively enable or disable individual skills by name or by their absolute path.

```yaml
skills:
  config:
    - name: my-custom-skill
      enabled: false
    - path: /home/user/.agents/skills/other-skill/SKILL.md
      enabled: true
```

## Interactive TUI controls

In the terminal user interface, you can manage and list skills interactively.

### Slash commands

- `/skills` opens a selection menu with these choices.
  - **List skills** shows all active skills. Typing `@` or `$` (depending on whether the `mentions_v2` feature is active) in the composer opens the mentions list directly.
  - **Enable/Disable Skills** opens a toggle list of all discovered skills. You can select individual skills to turn them on or off.

When you close the toggle list, the TUI displays a status message stating how many skills were enabled or disabled.

## Related recipes

For goal-shaped "give the agent a new capability" flows that stitch skills with MCP and
plugins, see [Task guides](../using/task-guides.md).
