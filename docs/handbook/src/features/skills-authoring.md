# Skills authoring

A skill is a folder that adds a reusable capability to Veyyon. This page explains how to write one from scratch. For background on how skills are discovered and loaded, see [Skills](skills.md).

## Directory structure

Skills load only from the active profile. Veyyon reads these locations, all under the profile's agent dir (`profiles/default/` when you have not selected a profile):

| Scope | Directory | Purpose |
| --- | --- | --- |
| User | `$HOME/.veyyon/profiles/<profile>/agent/skills` | Skills you author or install for the active profile. |
| Managed | `$HOME/.veyyon/profiles/<profile>/agent/managed-skills` | Auto-learn skills Veyyon writes itself. A same-named user skill always wins. |
| Plugins | plugins installed into the active profile | Skills bundled with a plugin you added to this profile. |

Nothing else contributes skills. A project-local `.veyyon/skills` directory and another tool's skill directory (`$HOME/.claude/skills`, `$HOME/.codex/skills`, `$HOME/.agents/skills`, and the rest) are never scanned. To use a skill from another tool, import it into your profile, see [Skills](skills.md#importing-another-tools-skills). For the full provider list and dedup rules, see [Skills](skills.md#skill-locations).

Create a new skill by making a directory inside the profile's `skills` dir and adding a `SKILL.md` file. The name of the directory is the default name of the skill.

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

## Configuring in config.yml

There is no registration step: a skill placed in any discovered directory (see
[Skills](./skills.md)) loads automatically. The `skills` section of `config.yml` controls
which discovered skills are active.

Turn skill discovery off entirely:

```yaml
skills:
  enabled: false
```

Filter individual skills by name glob (`includeSkills` allowlist, `ignoredSkills`
denylist):

```yaml
skills:
  ignoredSkills:
    - internal-*
```

Enable or disable individual skills by name or by absolute path:

```yaml
skills:
  config:
    - name: my-skill
      enabled: true
    - path: /home/user/.veyyon/profiles/default/agent/skills/other-skill/SKILL.md
      enabled: false
```

## Worked example: a profile skill

This example creates a skill in your active profile that adds a custom onboarding check.

Create the skill directory under the active profile (`profiles/default` when you have not selected one):

```bash
mkdir -p ~/.veyyon/profiles/default/agent/skills/onboarding-check
```

Create `onboarding-check/SKILL.md` in that directory:

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

Create `onboarding-check/agents/openai.yaml` in the same directory:

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

No registration is needed, a skill under the active profile's `skills` directory is
picked up automatically. If your `config.yml` uses an `includeSkills`
allowlist, add the skill's name to it:

```yaml
skills:
  includeSkills:
    - onboarding-check
```

### Invoking the skill

In the TUI, you can invoke the skill in two ways:

1. Open `/extensions`, find **Onboarding Check** in the skills list, and invoke it from there (or type its name as a slash command directly when `skills.enableSkillCommands` is on).
2. Type a natural request such as "Is this project ready for a new contributor?" in the composer. The model reads the skill description and selects the skill automatically when the request matches.

From a command-line invocation, refer to the skill by its name. The exact command depends on the Veyyon CLI version; run `veyyon --help` or see the [CLI reference](../reference/cli.md) for the current syntax.
