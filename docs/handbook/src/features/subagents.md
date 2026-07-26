# Subagents

A subagent is a second veyyon session that your session starts, hands one piece of
work to, and collects a report from. The parent spawns it with the `task` tool; the
subagent has its own context window, so bulk reading and long grinding work stay out
of the conversation you are having.

Everything about them is configured in one place: the **Subagents** tab in
`/settings`, backed by the `subagent.*` settings. `/agents` opens the same agent
table with a live view of what each agent will run.

## What you get out of the box

One agent type, the general-purpose worker, and delegation that is available but
never pushed:

```yaml
subagent:
  delegation: allowed   # the task tool is offered; the model decides when to use it
```

Every subagent runs the model you are working with. Change the model you are talking
to and your subagents follow it.

Veyyon also ships five specialists (`scout`, `reviewer`, `designer`, `librarian`,
`sonic`), and they are **not offered** by default. Each agent type you enable adds its
description to every request you send for the rest of the session, so you pay for the
ones you use and nothing else. Enable one in the Subagents tab or with `/agents`.

## How hard to push

`subagent.delegation` is the one switch for "does this session delegate":

| Value | What happens |
| --- | --- |
| `off` | No delegation at all. The `task` tool is not offered, and every delegation instruction leaves the prompt. |
| `allowed` | The default. The tool is there; the model judges when it is worth it. |
| `preferred` | The prompt asks the model to fan substantial work out instead of doing it alone. |
| `required` | The same, plus a first-turn reminder that delegation is the default here. |

The instructions follow what you have enabled. With only the worker offered, nothing
in the prompt talks about picking an agent type, and nothing tells the model to send
research to a `scout` it cannot spawn.

## Choosing agents

`subagent.agents` holds one row per agent name. Two places edit it, and both show
the same thing:

- **`/settings` → Subagents → Agents.** Every discovered agent, with its state, the
  model it resolves to, and the setting that decided. Enter opens one agent to set
  its state, model and effort, or reset it back to defaults.
- **`/agents`.** The same rows next to the agent files themselves, so this is where
  you write a new agent. `space` cycles a row's state.

A row can express three states:

| State | Meaning |
| --- | --- |
| **Offered (default)** | Your own agents and the general worker. Listed in the `task` tool and choosable by the model. |
| **Not offered (default)** | The bundled specialists. Not listed, so they cost nothing, but they still run when something names them. |
| **Blocked** | Refused even when named, with a message pointing at the setting. |

The middle state is what keeps the built-in flows working with the specialists off:
`/review` asks for `agent: "reviewer"` by name, and so can you ("use the scout agent
to map the parser"). Blocking is the stronger, explicit choice.

Writing an agent file is itself the opt-in: an agent under your own or the project's
`agents/` directory is offered as soon as it exists.

## Choosing models

Four things can name the model a subagent runs. The first that names one wins:

1. that agent's own row, `subagent.agents.<name>.model`
2. the blanket `subagent.model`
3. the agent definition's own `model:` frontmatter, for an agent you wrote
4. otherwise the subagent inherits the model you are working with

```yaml
subagent:
  model: openai/gpt-5:high             # every subagent
  agents:
    reviewer:
      enabled: true
      model: anthropic/claude-opus-4-5 # except this one
```

No bundled agent pins a model, so layer 4 is the normal case and `subagent.model`
moves all of them together. `subagent.thinkingLevel` does the same for effort, and an
explicit `:effort` suffix on a model pattern always wins over an agent's own default.

Effort is chosen from a list — `off`, `minimal` through `max`, `auto`, or `Inherit` —
in both places, so you cannot set a level that does not exist. If a hand-written config
holds one that does not, veyyon says so and names the levels that work, rather than
treating it as `Inherit` and leaving you with a setting that reads as configured and
changes nothing.

A configured model that matches nothing available does **not** quietly fall through to
the next layer. The spawn is refused and the message names the setting to fix, because
falling through is indistinguishable from your setting having no effect. Both agent
surfaces show, for the selected agent, the pattern, the model it resolves to, and
which of the four layers decided.

## Limits and isolation

The remaining groups in the tab are operational: how many subagents run at once
(`subagent.maxConcurrency`), how deep they may spawn their own (`maxRecursionDepth`),
per-run wall clock and request budgets, how long an idle subagent stays in memory
before being parked to disk (`idleTtlMs`), and whether their edits land in an isolated
copy of the tree first (`subagent.isolation.*`, see [Safety](../using/safety.md)).

A subagent's working directory is its own. If a subagent calls `set_cwd`, only that
subagent moves: its tool paths resolve against the new directory and its system prompt
is rebuilt for it, while your session and every other subagent stay where they were.

That matters because subagents run inside the same process you do. The main session
also moves the process working directory when it re-roots, so that a command you run
and a relative path you write agree with the project you have open. A subagent doing
the same would move the ground under everyone else, and the symptom would be a command
running in the wrong repository with nothing on screen to explain it.

The trade is that a subagent working elsewhere does not pick up that project's
settings, capabilities or plugins, because those are read once for the process. Give a
subagent a task in another project only when the work is self-contained, and re-root
your own session instead when you want that project's configuration to apply.

The full key list is in the [settings reference](../../../settings.md#subagents).
