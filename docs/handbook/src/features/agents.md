# Agents

An agent is a second veyyon session that your session starts, hands one piece of
work to, and collects a report from. The parent spawns it with the `task` tool; the
agent has its own context window, so bulk reading and long grinding work stay out
of the conversation you are having.

Everything about them is configured in one place: the **Agents** tab in
`/settings`, backed by the `agent.*` settings. `/agents` is the live picture of a
run in progress: which agents are working right now and what they are saying to each
other. It does not configure anything.

## Default configuration

One agent type, the general-purpose worker, and delegation that the prompt requests:

```yaml
agent:
  delegation: preferred   # the default; the prompt requests that substantial work be delegated
```

Each agent runs the model and effort set on its own page in the roster. An agent
that names neither runs the profile's default model at medium effort. Changing the
model you are talking to moves that session and nothing else.

Veyyon also ships five specialists (`scout`, `reviewer`, `designer`, `librarian`,
`sonic`), and they are **disabled** by default. During first-run setup, the
**Choose agents** step shows every available role with only `task` checked.
Enable the specialists you want the model to start on its own. Each enabled type
adds its description to future requests, so leave roles off when you do not use
them.

## How hard to push

`agent.delegation` sets how hard this session is pushed to delegate:

| Value | What happens |
| --- | --- |
| `allowed` | The tool is there; the model judges when it helps, and the prompt does not request it. |
| `preferred` | The default. The prompt instructs the model to fan substantial work out instead of doing it alone. |
| `required` | The same, plus a first-turn reminder that delegation is the default here. |

The strength applies only when an enabled role matches the work. If `task` is
enabled, it acts as the general-purpose fallback. If only specialists are
enabled, work that matches none of their descriptions stays in the main
session. With no enabled agent, the delegation preamble is omitted.

The separate `agent.enabled` boolean (default on) is the kill switch: off removes the `task`
tool and every delegation instruction from the prompt, so nothing can be spawned. A legacy
`delegation: off` migrates to `agent.enabled: false`.

The instructions follow the exact roles you enable. With only `task` offered,
the prompt uses it as the general-purpose route. Enabling `designer` or
`reviewer` adds those separate roles without changing what `task` means.

### What counts as delegable work

`agent.delegation` sets how strongly the model is pushed to delegate.
The description of each enabled agent scopes the work that role covers.
These are separate settings.

Veyyon preserves concrete roles. It does not infer a second role category from
the tools an agent can call. For example, `designer` remains a designer and
`reviewer` remains a reviewer. The model chooses the closest matching
specialist for each independent slice:

```yaml
# ~/.veyyon/subagents/accessibility-reviewer.md frontmatter
name: accessibility-reviewer
description: Reviews terminal interfaces for accessibility problems and reports findings
tools: read, search
```

Enable that role when you want it available:

```console
$ veyyon config set agent.agents.accessibility-reviewer.enabled true
```

When `task` is enabled, the model can use it for substantial work that does not
fit a specialist. When `task` is disabled, the model keeps unmatched work
inline. This prevents a specialist name from becoming a generic worker merely
because no closer role is available.

An agent role is routing guidance, not a security boundary. Use the
[sandbox](./sandbox.md) when you need to restrict filesystem or process access.

## Choosing agents

`agent.agents` holds one row per agent name. You choose initial permissions in
the first-run **Choose agents** step, then edit them through **`/settings` →
Agents → Roster**. The roster lists every discovered agent with its state,
resolved model, and deciding setting. Enter opens one agent to set its state,
model, and effort, or reset it to defaults.

To add an agent, put a markdown definition in `~/.veyyon/subagents/`, or start
from the shipped definitions by running `veyyon agents unpack`. The definition
makes the role available. Enable its row before the model may start it.
[Writing an agent](./agents-authoring.md) covers the frontmatter fields, the
system prompt and enabling the result.

That directory is read by every profile, and the file is the whole definition.
Which profile may spawn the agent is a separate, per-profile answer:
`agent.agents.<name>.enabled`. Write the agent once, enable it where you want
it.

A definition that lists a tool veyyon does not recognize is reported at startup
rather than ignored. The tool grants nothing, and the guidance for it is left out
of the agent's system prompt, so a typo used to read as an agent that simply
chose to do nothing.

A row has two states:

| State | Meaning |
| --- | --- |
| **Enabled** | Listed in the `task` tool and choosable by the model. Only the bundled `task` worker defaults to enabled. |
| **Disabled** | Refused even when named, with a message pointing at the setting. Specialists and user or project agents default to disabled. |

The built-in flows still work with the specialists disabled because a command can grant its
agent for the turn: `/review` requests `agent: "reviewer"` through a per-turn grant, and so can
you ("use the scout agent to map the parser").

Writing an agent file makes the role available but does not grant spawn
permission. Enable the role during setup or in the Agents settings table.

## Choosing models

Two scopes choose an agent's model and effort, and **Agents → Same Model for All
Agents** selects which one is in force. They are exclusive, not layered: the rows of the
scope that is off are not drawn.

Off, the default, each agent decides. Open **Agents → Roster**, press Enter on an
agent, and set the model and the effort on that agent's own page. The first of these
that names a model wins:

1. that agent's lane, `agent.agents.<name>.model`, and for a nested spawn the
   `agents` level under it that governs that depth
2. the agent definition's own `model:` frontmatter, for an agent you wrote
3. the profile's `default` model role

```yaml
agent:
  agents:
    reviewer:
      enabled: true
      model: anthropic/claude-opus-4-5
      thinkingLevel: high
```

Effort resolves on the same three layers, ending at `medium`. An explicit `:effort`
suffix on the resolved model pattern outranks all of them.

When enabled, one pair applies to the whole roster, and the per-agent Model and Effort rows are
hidden. **Shared Model** (`agent.model`) and **Shared Effort**
(`agent.thinkingLevel`) sit under the switch; an unset chain runs every agent on the
`default` model role:

```yaml
agent:
  sharedModel: true
  model: openai/gpt-5
  thinkingLevel: high
```

A lane retains its configuration while the switch is on, and re-evaluates when the
switch goes off.

The `default` model role is the model the main assistant starts on, and it is the
one keystroke path for the common case: `/model` writes it, and every agent with no
model of its own follows it. A temporary pick, role cycling and plan mode move the
live session model only, so an agent never changes model because of a keystroke
aimed at the main assistant.

`agent.modelByDepth` bound a chain to a spawn depth rather than to an agent and no
longer applies. A config still holding it is reported once, naming the roster page that
replaces it.

### Fallback models

Every one of those places takes a list, not just one model:

```yaml
agent:
  agents:
    reviewer:
      model: anthropic/claude-opus-4-5,openai/gpt-5
```

The first entry is what that agent runs on. The rest are held in reserve: when a run errors on the
model in use, that agent retries on the next entry rather than failing. The settings picker writes
the value for you: open the model row, add a fallback, and press Enter on any entry to move it up
the list.

A longer chain reads better as a list, and both spellings mean the same thing:

```yaml
agent:
  agents:
    reviewer:
      model:
        - anthropic/claude-opus-4-5
        - openai/gpt-5
```

Write it whichever way suits the file. `compaction.model` takes a chain the same two ways.

A chain only covers errors at run time. A model pattern that matches nothing is still a
configuration mistake, so veyyon will not spawn the agent and states the setting, rather than
quietly running it on the next entry: a typo must not silently downgrade the agent you spawn.

In the `Agents` block above the composer, an agent that fell back is marked with `↓` before its
model badge, so you can tell a deliberate model from a retried one at a glance.

Effort is chosen from a list: `off`, `minimal` through `max`, `auto`, or `Inherit`.
`Inherit` on an agent's own page means the default effort; on a nested page it means the
page above it. `auto` requests that the provider choose. The same list appears in both
places, so you cannot set a level that does not exist. If a hand-written config
holds one that does not, veyyon reports the levels that work, rather than
treating it as `Inherit` and leaving you with a setting that reads as configured and
changes nothing.

A configured model that matches nothing available does **not** quietly fall through to
the next layer. The spawn is rejected and the message states the setting to fix, because
falling through is indistinguishable from your setting having no effect. Both agent
surfaces show, for the selected agent, the pattern, the model it resolves to, and
which of the three layers decided.

## Watching a run

While a spawn is in flight, the `Agents` block sits above the composer with one
row per agent. A row reads left to right: the rail, a mark, the agent's id, the
one-line label of what it was given, and the model and effort it runs on.

```text
Agents
 ▏ ▪ DockerSecretHarness: Run the workspace tests in Docker · claude-opus-5 high
 ▏ ▪ SecretModeFlowUX: Review the secret mode flow · claude-opus-5 high
 ▏ ▪ SecretModularityAudit: Audit secrets subsystem modularity · gemini-3.7-flash med
```

The id is painted in that agent's own accent, the same hue the status line gives its
name and the same one a delegated todo row uses to point back at it.

The label is the spawn description, or a label generated from the assignment when
the spawn gave none. It is generated with the tiny, commit or smol role when one is
configured and with the session's live model otherwise, the way a session title is.
The badge is the model the agent runs on: the resolved `agent.model` or
per-agent override when one matched, else the session's own model that the agent
inherited. An agent that fell back to another model shows a dim `↓` before its badge.
`agent.showResolvedModelBadge: false` drops the badge.

Light travels down the rail while agents are working. The head crosses the whole block,
so the cycle belongs to the block rather than the row. Where `display.transitions` is
off, the block is still.

There is no elapsed clock and no context gauge. Total age ranks agents by seniority,
which nothing acts on, and a parent does not use a agent's remaining
window. `/agents` carries the roster with the numbers.

Narrow the terminal and the model badge comes off first, then the label shortens to
what is left. Nothing wraps: the block draws no row it cannot fit, and draws nothing
at all rather than overflow.

Eight rows are drawn. Past that the block states how many more are running under the
last row and points at `/agents`, which is the full roster. That row is the only place
a count appears; the header is bare.

## Limits and isolation

The remaining groups in the tab are operational: how many agents run at once
(`agent.maxConcurrency`), how deeply they may nest (`agent.maxNestedSpawnDepth`),
per-run wall clock and request budgets, how long a finished agent stays live
before parking (`agent.idleTtlMs`) and how long it stays listed after that
(`agent.prune.*`), and whether its edits land in an isolated
copy of the tree first (`agent.isolation.*`, see [Safety](../using/safety.md)).

A spawned agent that has finished its turn is `idle`. After `agent.idleTtlMs` ("Park Idle
Agents After", five minutes by default) it is `parked`: its process, MCP clients and memory
are released, its transcript is flushed to disk, and its roster row stays. Messaging or
opening a parked agent rebuilds it from the transcript. `0` ("Until exit") keeps idle
agents live until the session exits.

After `agent.prune.afterMs` ("Prune After", one hour by default) a parked agent is pruned:
its roster row is removed and it can no longer be messaged or opened. Nothing on disk is
deleted; the transcript stays readable at `history://<name>`. `agent.prune.enabled` off
keeps every parked agent in the roster until the session exits, and does not affect
parking.

`agent.prune.waitingAfterMs` ("Prune After While Waiting", two hours by default) replaces
Prune After for a parked agent whose last message was that it is waiting on another agent.
A value below Prune After is raised to it.

### When each budget starts counting

The park budget counts from the agent's last activity; a revived agent starts it again
from the revival. The prune budget counts from the moment the agent was parked. An agent
read back from a previous run is aged from when its transcript was last written, not from
when this session found it.

### Only idle and parked agents have a deadline

A `running` or `aborted` agent has no deadline. An agent waiting on an approval prompt is
mid-turn and stays `running`, so no park or prune timer applies to it.

### An agent on screen is not parked

Opening an agent's session from the `/agents` dashboard keeps it live for as long as the
main view points at it. A park deadline that elapses meanwhile is deferred; the idle TTL
counts again from the moment Esc returns the view to your own session.

### The status graph

An agent is `running`, `idle`, `parked` or `aborted`. `running` moves to `idle` when the
turn drains, to `parked` when a run finishes with no session to keep, or to `aborted` when
killed. `idle` moves to `running` on the next turn, to `parked` on the idle TTL, or to
`aborted`. `parked` moves to `idle` on revival or to `aborted`. `aborted` is terminal. Any
other move is rejected, so a turn event that arrives after a kill cannot revive the agent.

### Turning it off

`agent.prune.afterMs` set to `0` disables pruning for every parked agent, including one
that is waiting on a peer, whatever `agent.prune.waitingAfterMs` is.

### If the session cannot be saved

Parking flushes the agent's session to disk before releasing it. If the flush fails, the
agent stays live, its timer is re-armed, and the park is attempted again at the next
expiry.

### Nesting depth

`agent.maxNestedSpawnDepth` is inclusive. The default is `0`: the top-level session,
at depth 0, may spawn direct agents, but those children are leaves and cannot spawn
more agents. A value of `1` also lets direct children spawn, producing children at
depth 2. Higher values extend the same rule, and `-1` allows nesting without a depth
limit.

An agent-specific value takes precedence over the blanket value:

```yaml
agent:
  maxNestedSpawnDepth: 0
  agents:
    reviewer:
      maxNestedSpawnDepth: 1
```

Here ordinary direct agents remain leaves. A direct `reviewer` may spawn its own
children because its effective limit is 1.

An agent's working directory is its own. If an agent calls `set_cwd`, only that
agent moves: its tool paths resolve against the new directory and its system prompt
is rebuilt for it, while your session and every other agent stay where they were.

That matters because agents run inside the same process you do. The main session
also moves the process working directory when it re-roots, so that a command you run
and a relative path you write agree with the project you have open. An agent doing
the same would move the ground under everyone else, and the symptom would be a command
running in the wrong repository with nothing on screen to explain it.

The trade is that an agent working elsewhere does not pick up that project's
settings, capabilities or plugins, because those are read once for the process. Give a
agent a task in another project only when the work is self-contained, and re-root
your own session instead when you want that project's configuration to apply.

The full key list is in the [settings reference](../reference/settings.md#agents).
