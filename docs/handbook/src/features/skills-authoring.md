# Skills authoring

A skill is a folder that adds a reusable capability to Veyyon. This page explains how to write one from scratch. For background on how skills are discovered and loaded, see [Skills](skills.md).

## Directory structure

Skills are placed on the filesystem according to the scope where they should apply. Veyyon loads skills from these locations in order:

| Scope | Directory | Purpose |
| --- | --- | --- |
| System | `$VEYYON_HOME/skills/.system` | Bundled first-party skills unpacked from the Veyyon binary. |
| Admin | `/etc/veyyon/skills` | Machine-wide skills managed by administrators. |
| User | `$HOME/.agents/skills` | Skills available to the current user. `$VEYYON_HOME/skills` is also supported as a legacy path. |
| Project | `.veyyon/skills` | Skills shipped with a project. Placed at the project root. |
| Repository | `.agents/skills` | Local skills discovered incrementally in directories between the working directory and the project root. |

Create a new skill by making a directory inside one of these scopes and adding a `SKILL.md` file. The name of the directory is the default name of the skill.

A skill directory may contain additional files:

```
my-skill/
├── SKILL.md
├── agents/
│   └── openai.yaml
└── scripts/, references/, assets/ ...optional
```

Only `SKILL.md` is required. The other files are loaded when the skill is active or when the model explicitly asks for them.

## SKILL.md frontmatter

Every `SKILL.md` must begin with a YAML frontmatter block between `---` lines.

```markdown
---
name: my-skill
description: Describe what this skill does and when to use it.
metadata:
  short-description: Short summary shown in skill lists.
---
```

The frontmatter fields are:

* `name`: The skill identifier. Optional; defaults to the parent directory name. Use lowercase letters, digits, and hyphens. Keep it under 64 characters.
* `description`: A clear explanation of what the skill does and when it should be triggered. This is the main signal the model uses to decide whether to invoke the skill.
* `metadata.short-description`: A short summary shown in the TUI and other skill lists. Optional; keep it to one line.

Be specific in the description. A vague description makes the skill less likely to be selected at the right moment.

## Writing the body

The body of `SKILL.md` is a Markdown document that contains the instructions, context, and workflow for the skill. The body is loaded only after the skill has been selected, so the frontmatter acts as the gate and the body acts as the guide.

Guidelines for the body:

* State the purpose at the top.
* List the conditions that trigger this skill.
* Provide a step-by-step workflow or a set of rules the model should follow.
* Include examples of inputs and expected outputs.
* Mention any bundled scripts, references, or assets and when to use them.
* Keep it concise. Long skills consume context and may be ignored. Split detailed reference material into files under `references/` and link to them from `SKILL.md`.

Example body:

```markdown
# Code review

Use this skill when the user asks for a review of a code change or pull request.

1. Check for logic errors, unhandled edge cases, and test coverage.
2. Verify that the change matches the project style and conventions.
3. Flag any breaking changes or missing documentation.
4. Report findings as a numbered list with file paths and line numbers.

Do not leave comments on external platforms unless the user explicitly asks for it.
```

## Optional agents/openai.yaml

The `agents/openai.yaml` file controls how the skill appears in the TUI and how it may be invoked. It is optional but recommended for skills that users interact with directly.

Example:

```yaml
interface:
  display_name: "Code Review"
  short_description: "Review code for quality and correctness"
  brand_color: "#C6CBD4"
  default_prompt: "Review the current diff"
dependencies:
  tools:
    - type: "command"
      value: "git diff"
      description: "Inspect local changes"
policy:
  allow_implicit_invocation: true
  products:
    - veyyon
```

Available fields:

* `interface`: Presentation settings.
  * `display_name`: Name shown in the TUI skill list.
  * `short_description`: One-line description shown in the TUI.
  * `icon_small` / `icon_large`: Paths to optional icons relative to the skill directory.
  * `brand_color`: A hex color or color name for the skill chip.
  * `default_prompt`: Pre-filled text when the skill is opened from the TUI.
* `dependencies`: Tools the skill needs.
  * `tools`: A list of dependency blocks. Each block may specify `type`, `value`, `description`, `transport`, `command`, and `url`.
* `policy`: Invocation restrictions.
  * `allow_implicit_invocation`: Whether the skill may be suggested or injected automatically. Defaults to `true`. Set to `false` to require explicit selection.
  * `products`: A list of product names that may load this skill (for example, `veyyon`). If omitted, the skill loads for all products that support it.

## Registering in config.yml

Skills are configured under the `skills` section of `config.yml`. You can control whether skill instructions are included automatically, whether bundled skills are enabled, and which individual skills are on or off.

Disable automatic inclusion of all skill instructions:

```yaml
skills:
  include_instructions: false
```

Disable all bundled system skills:

```yaml
skills:
  bundled:
    enabled: false
```

Enable or disable individual skills by name or by absolute path:

```yaml
skills:
  config:
    - name: my-skill
      enabled: true
    - path: /home/user/.agents/skills/other-skill/SKILL.md
      enabled: false
```

## Worked example: a project-local skill

This example creates a skill inside a project that adds a custom onboarding check.

Create the skill directory:

```bash
mkdir -p .veyyon/skills/onboarding-check
```

Create `.veyyon/skills/onboarding-check/SKILL.md`:

```markdown
---
name: onboarding-check
description: Review the project for missing onboarding files and recommend improvements.
metadata:
  short-description: Check onboarding completeness.
---

# Onboarding check

Use this skill when the user asks whether the project is ready for a new contributor.

1. Check that the project has a README, CONTRIBUTING guide, and LICENSE file.
2. Verify that the build command is documented and can be run from the README.
3. List any missing or incomplete files.
4. Suggest concrete additions that would help a new contributor start quickly.

Report the result as a short checklist with `done` or `missing` for each item.
```

Create `.veyyon/skills/onboarding-check/agents/openai.yaml`:

```yaml
interface:
  display_name: "Onboarding Check"
  short_description: "Check project onboarding completeness"
  default_prompt: "Is this project ready for a new contributor?"
policy:
  allow_implicit_invocation: true
  products:
    - veyyon
```

Register it in the project `config.yml`:

```yaml
skills:
  config:
    - name: onboarding-check
      enabled: true
```

### Invoking the skill

In the TUI, you can invoke the skill in two ways:

1. Type `/skills` and select **List skills**, then choose **Onboarding Check** from the list. The `default_prompt` will be pre-filled if one is configured.
2. Type a natural request such as "Is this project ready for a new contributor?" in the composer. The model reads the skill description and selects the skill automatically when the request matches.

From a command-line invocation, refer to the skill by its name. The exact command depends on the Veyyon CLI version; run `veyyon --help` or see the [CLI reference](../reference/cli.md) for the current syntax.
