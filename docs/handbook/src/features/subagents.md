# Subagents

A subagent is a second veyyon session that your session starts, hands one piece of
work to, and collects a report from. The parent spawns it with the `task` tool; the
subagent has its own context window, so bulk reading and long grinding work stay out
of the conversation you are having.

Everything about them is configured in one place: the **Subagents** tab in
`/settings`, backed by the `subagent.*` settings. `/agents` is the live picture of a
run in progress: which agents are working right now and what they are saying to each
other. It does not configure anything.

## What you get out of the box

One agent type, the general-purpose worker, and delegation that the prompt asks for:

```yaml
subagent:
  delegation: preferred   # the default; the prompt asks for substantial work to be delegated
```

Every subagent runs the model you are working with. Change the model you are talking
to and your subagents follow it.

Veyyon also ships five specialists (`scout`, `reviewer`, `designer`, `librarian`,
`sonic`), and they are **disabled** by default. During first-run setup, the
**Choose subagents** step shows every available role with only `task` checked.
Enable the specialists you want the model to start on its own. Each enabled type
adds its description to future requests, so leave roles off when you do not use
them.

## How hard to push

`subagent.delegation` decides how hard this session is pushed to delegate:

| Value | What happens |
| --- | --- |
| `allowed` | The tool is there; the model judges when it is worth it, and is never asked. |
| `preferred` | The default. The prompt asks the model to fan substantial work out instead of doing it alone. |
| `required` | The same, plus a first-turn reminder that delegation is the default here. |

The strength applies only when an enabled role matches the work. If `task` is
enabled, it acts as the general-purpose fallback. If only specialists are
enabled, work that matches none of their descriptions stays in the main
session. With no enabled agent, the delegation preamble is omitted.

The separate `subagent.enabled` boolean (default on) is the kill switch: off removes the `task`
tool and every delegation instruction from the prompt, so nothing can be spawned. A legacy
`delegation: off` migrates to `subagent.enabled: false`.

The instructions follow the exact roles you enable. With only `task` offered,
the prompt uses it as the general-purpose route. Enabling `designer` or
`reviewer` adds those separate roles without changing what `task` means.

### What counts as delegable work

`subagent.delegation` decides how strongly the model is pushed to delegate.
The description of each enabled agent decides which work that role can own.
These are separate settings.

Veyyon preserves concrete roles. It does not infer a second role category from
the tools an agent can call. For example, `designer` remains a designer and
`reviewer` remains a reviewer. The model chooses the closest matching
specialist for each independent slice:

```yaml
# agents/accessibility-reviewer.md frontmatter
name: accessibility-reviewer
description: Reviews terminal interfaces for accessibility problems and reports findings
tools: read, grep, glob
```

Enable that role when you want it available:

```console
$ veyyon config set subagent.agents.accessibility-reviewer.enabled true
```

When `task` is enabled, the model can use it for substantial work that does not
fit a specialist. When `task` is disabled, the model keeps unmatched work
inline. This prevents a specialist name from becoming a generic worker merely
because no closer role is available.

An agent role is routing guidance, not a security boundary. Use the
[sandbox](./sandbox.md) when you need to restrict filesystem or process access.

## Choosing agents

`subagent.agents` holds one row per agent name. You choose initial permissions in
the first-run **Choose subagents** step, then edit them through **`/settings` →
Subagents → Agents**. The settings screen lists every discovered agent with its
state, resolved model, and deciding setting. Enter opens one agent to set its
state, model, and effort, or reset it to defaults.

To add an agent, put a markdown definition in your own or the project's
`agents/` directory, or start from the shipped definitions by running
`veyyon agents unpack`. The definition makes the role available. Enable its row
before the model may start it.

A row has two states:

| State | Meaning |
| --- | --- |
| **Enabled** | Listed in the `task` tool and choosable by the model. Only the bundled `task` worker defaults to enabled. |
| **Disabled** | Refused even when named, with a message pointing at the setting. Specialists and user or project agents default to disabled. |

The built-in flows still work with the specialists disabled because a command can grant its
agent for the turn: `/review` asks for `agent: "reviewer"` through a per-turn grant, and so can
you ("use the scout agent to map the parser").

Writing an agent file makes the role available but does not grant spawn
permission. Enable the role during setup or in the Agents settings table.

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
moves all of them together. `subagent.thinkingLevel` does the same for effort. **Inherit** passes the
current session's effective effort into the child, while an explicit `auto` asks the provider to
choose. An explicit `:effort` suffix on a model pattern always wins over an agent's own default.

### Fallback models

Every one of those four places takes a list, not just one model:

```yaml
subagent:
  model: anthropic/claude-opus-4-5,openai/gpt-5
```

The first entry is what subagents run on. The rest are held in reserve: when a run errors on the
model in use, that agent retries on the next entry rather than failing. The settings picker writes
the value for you: open the model row, add a fallback, and press Enter on any entry to move it up
the list.

A longer chain reads better as a list, and both spellings mean the same thing:

```yaml
subagent:
  model:
    - anthropic/claude-opus-4-5
    - openai/gpt-5
```

Write it whichever way suits the file. `compaction.model` takes a chain the same two ways.

A chain only covers errors at run time. A model pattern that matches nothing is still a
configuration mistake, so veyyon refuses to spawn the agent and names the setting, rather than
quietly running it on the next entry: a typo must not silently downgrade every subagent you spawn.

In the `Subagents` block above the composer, an agent that fell back is marked with `↓` before its
model badge, so you can tell a deliberate model from a retried one at a glance.

Effort is chosen from a list: `off`, `minimal` through `max`, `auto`, or `Inherit`.
The same list appears in both places, so you cannot set a level that does not exist. If a hand-written config
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
(`subagent.maxConcurrency`), how deeply they may nest (`subagent.maxNestedSpawnDepth`),
per-run wall clock and request budgets, how long a finished subagent stays live
before parking (`subagent.idleTtlMs`) and how long it stays listed after that
(`subagent.autoClose.*`), and whether its edits land in an isolated
copy of the tree first (`subagent.isolation.*`, see [Safety](../using/safety.md)).

`subagent.idleTtlMs` defaults to five minutes for every model and provider. Set
a positive millisecond value to override it. Set `0` to keep idle agents live
until exit. Parking releases the live session but keeps its transcript, so
messaging or opening the agent can revive it.

A parked subagent is eventually closed, which drops it from the roster so a long
session does not accumulate every agent it ever spawned. Closing removes the
revivable reference; it does not touch the transcript, which stays readable at
`history://<name>`.

Four settings in the Auto Close group control the whole lifecycle, in the order they
happen. `subagent.idleTtlMs` ("Park After") is stage one: how long a finished subagent
stays live before parking, five minutes by default. `subagent.autoClose.enabled` is on by
default; turn it off to keep every parked subagent listed and revivable until you exit.
`subagent.autoClose.parkedMs` ("Close After") is how long a parked subagent stays listed,
counted from the moment it parked, and defaults to five minutes.
`subagent.autoClose.waitingMs` ("Close After (Waiting)") is the same budget for a subagent
whose last message said it was waiting on another agent, and defaults to thirty minutes:
it stopped on purpose to let a peer finish, so it is the agent you are most likely to
message next. Set the two equal to treat both the same.

Turning auto-close off does not turn parking off. Parking is what releases the session, and
it happens either way; the toggle only decides whether the parked reference is eventually
dropped. That is why "Park After" sits in this group but is not hidden when the toggle is
off.

### When each budget starts counting

Both budgets count from the agent's last transition, not from when it was spawned. An
idle agent's park budget starts when it went idle. A parked agent's close budget starts
at the moment it parked. A revived agent starts its park budget again from the revival,
so messaging a parked agent gives it a fresh five minutes rather than resuming a clock
that was already half spent.

That is why a long-lived session does not slowly close everything at once: each agent's
deadline moves with its own activity.

### Only idle and parked agents have a deadline

A `running` agent carries no deadline at all, and neither does an `aborted` one. Nothing
parks or closes an agent that is mid-turn.

This matters when an agent looks stuck. A subagent waiting for you to answer an approval
prompt is still mid-turn, so it stays `running` and no park or close timer applies to it.
If a finished agent is not being cleaned up, check its status first: the lifecycle only
acts on `idle` and `parked`, so an agent stuck in `running` is a different problem and the
auto-close settings will not affect it.

### Turning it off

Set `subagent.autoClose.parkedMs` to `0` and no parked agent is ever closed. That also
forces the waiting budget to `0`, whatever `subagent.autoClose.waitingMs` says.

That coupling is deliberate. If a zero parked budget still honoured a separate waiting
budget, the only agents that ever closed would be the ones that stopped to wait on a peer,
which are the agents you are most likely to message next. Zero means never close, for
both kinds.

### If the session cannot be saved

Parking flushes the agent's session to disk before releasing it. If that flush fails, the
park is cancelled and the agent stays live with its timer re-armed. You keep a live agent
rather than losing unsaved state, and the attempt repeats on the next expiry.

### Nesting depth

`subagent.maxNestedSpawnDepth` is inclusive. The default is `0`: the top-level session,
at depth 0, may spawn direct subagents, but those children are leaves and cannot spawn
more subagents. A value of `1` also lets direct children spawn, producing children at
depth 2. Higher values extend the same rule, and `-1` allows nesting without a depth
limit.

An agent-specific value takes precedence over the blanket value:

```yaml
subagent:
  maxNestedSpawnDepth: 0
  agents:
    reviewer:
      maxNestedSpawnDepth: 1
```

Here ordinary direct subagents remain leaves. A direct `reviewer` may spawn its own
children because its effective limit is 1.

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
