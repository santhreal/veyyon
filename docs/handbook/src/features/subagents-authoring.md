# Writing a subagent

A subagent is one markdown file: YAML frontmatter that states its name, what it is
for and what it may use, and a body that is its system prompt. Veyyon reads the file
at startup, the roster lists it beside the bundled agents, and the `task` tool can
spawn it once its row is enabled.

## Where the file goes

```console
$ mkdir -p ~/.veyyon/subagents
$ $EDITOR ~/.veyyon/subagents/accessibility-reviewer.md
```

`~/.veyyon/subagents/*.md` is the only place veyyon reads user-authored agents from.
Every profile reads that directory, so an agent is written once. Whether a profile
may spawn it is a separate answer, `subagent.agents.<name>.enabled`, stored per
profile.

There is no project-level directory. A definition supplied by a repository could
shadow a bundled agent by name, and first-run setup would then offer that role as an
ordinary row.

Extensions ship agents in their own `agents/` directory, which veyyon discovers from
the extension roots. That spelling is the plugin-author contract and is not a path
to type by hand.

## The shape of the file

```markdown
---
name: accessibility-reviewer
description: Reviews terminal interfaces for accessibility problems and reports findings.
tools: read, search, bash
model: anthropic/claude-opus-4-5
thinkingLevel: high
---

You review terminal interfaces for accessibility problems.

Report each finding with the file, the line and the input that reproduces it.
Report nothing you have not reproduced.
```

`name` and `description` are required; a file missing either is skipped. Everything
else is optional.

| Field | Effect |
| --- | --- |
| `name` | The name the model spawns, and the roster row. Match the filename to keep the two findable together. |
| `description` | What the role covers. This is the text the model routes on, so state the work, not the job title. |
| `tools` | The tools this agent may call, as a list or a comma-separated string. Omitted grants the default set. `yield` is added if you list any tools at all. |
| `spawns` | Which agents this one may spawn: a list, or `*` for any. Omitted means none. |
| `model` | The model this agent runs when its roster row names none. A list is a fallback chain. |
| `thinkingLevel` | The effort it runs at when its roster row names none: `off`, `minimal`, `low`, `medium`, `high`, `max`, `auto`, or `inherit`. `thinking` is accepted as a synonym. |
| `blocking` | `true` runs the agent to completion before the parent continues. |
| `autoloadSkills` | Skills loaded into the agent's context at spawn. |
| `readSummarize` | `false` makes its `read` tool return verbatim file content instead of structural summaries. |
| `output` | A JSON schema the agent's `yield` payload is validated against. |

A two-word key is read in either spelling: `thinkingLevel` and `thinking-level` reach
the same field, and so do `autoloadSkills` and `readSummarize`. An underscore does
not, so `thinking_level` is ignored. The bundled definitions use the dashed form, so
an unpacked agent reads `thinking-level: medium` where the table above says
`thinkingLevel`.

A name in `tools` that matches no built-in tool and carries no `mcp__` or extension
namespace is reported at startup. The tool grants nothing and its guidance is left
out of the system prompt, so a typo reads as an agent that chose to do nothing.

## The body is the system prompt

Everything after the frontmatter is the agent's system prompt, rendered with
Handlebars. Write it as instructions to the worker: what it owns, what it must not
touch, what it returns. The worker sees this instead of the main assistant's prompt,
not in addition to it, so state the constraints that matter for the lane.

## Enable it

Discovery makes the role available. Spawning it needs the row enabled in the profile
you want it in:

```console
$ veyyon config set subagent.agents.accessibility-reviewer.enabled true
```

Or open **`/settings` → Subagents → Roster**, select the agent, and set its state
there. The same page sets that agent's model and effort, which outrank the `model:`
and `thinkingLevel:` in the file.

## Start from a bundled agent

`veyyon agents unpack` writes the shipped definitions to `~/.veyyon/subagents/` as
ordinary markdown files, frontmatter and all. Copy one under a new name and edit it.

```console
$ veyyon agents unpack --dir ./unpacked-agents
```

`--dir` writes them somewhere else, which keeps the unedited copies out of the
directory discovery reads.

A definition that keeps a bundled agent's `name` replaces that agent: a file in
`~/.veyyon/subagents/` outranks the bundled definition of the same name, so writing
`reviewer.md` there means your reviewer is the reviewer.

## Check the result

Open **`/settings` → Subagents → Roster**. The agent is listed there with its state,
the model it resolves to, and which setting decided. An agent that is discovered but
not enabled is listed and refused when named, with the setting to change.

A file that is skipped says why on startup: a missing `name` or `description`, a
file that cannot be read, or a tool name that matches nothing.
