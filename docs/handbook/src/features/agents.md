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

Each agent runs the model and effort set on its own page in the roster. An agent with
neither set runs the model and effort your session runs when it spawns. Changing the
model you are talking to moves that session and every agent it spawns from then on
that has no model of its own.

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
| `allowed` | The tool is available; the model delegates when it chooses to, and the prompt does not request it. |
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
of the agent's system prompt.

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

Off, the default, each agent uses its own settings. Open **Agents → Roster**, press Enter on an
agent, and set the model and the effort on that agent's own page. The first of these
that sets a model wins:

1. that agent's lane, `agent.agents.<name>.model`, and for a nested spawn the
   `agents` level under it that governs that depth
2. the agent definition's own `model:` frontmatter, for an agent you wrote
3. the spawning session's live model

The value `inherit` on either of the first two also runs the spawning session's live
model, which is how a lane overrides a model the definition names.

```yaml
agent:
  agents:
    reviewer:
      enabled: true
      model: anthropic/claude-opus-4-5
      thinkingLevel: high
```

Effort resolves on the same three layers, ending at the session's live effort. An explicit `:effort`
suffix on the resolved model pattern outranks all of them. The level `inherit` takes the
spawning session's live effort and fits it to the agent's model: a session at `xhigh`
spawning an agent on a model whose highest level is `high` runs that agent at `high`, and
its badge shows `high`.

When enabled, one pair applies to the whole roster, and the per-agent Model and Effort rows are
hidden. **Shared Model** (`agent.model`) and **Shared Effort**
(`agent.thinkingLevel`) sit under the switch; an unset chain runs every agent on the
session's model:

```yaml
agent:
  sharedModel: true
  model: openai/gpt-5
  thinkingLevel: high
```

A lane retains its configuration while the switch is on, and re-evaluates when the
switch goes off.

A temporary pick, model cycling and plan mode move the live session model, and so the
model of every agent spawned afterwards that has none of its own. Set a model on an
agent's page to keep that agent on it.

`agent.modelByDepth` bound a chain to a spawn depth rather than to an agent and has
no effect. A config that still contains it is reported once, with the roster page that
replaces it.

### Fallback models

Every one of those places takes a list of models:

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

A chain only covers errors at run time. A model pattern that matches nothing is a
configuration mistake, so veyyon does not spawn the agent and states the setting rather
than running it on the next entry in the chain.

In the `Agents` block above the composer, an agent that fell back is marked with `↓` before its
model badge, which distinguishes a fallback model from the configured one.

Effort is chosen from a list: `off`, `minimal` through `max`, `auto`, or `Inherit`.
`Inherit` on an agent's own page means the agent definition's effort, and the session's
effort when the definition names none; on a nested page it means the
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
the spawn gave none. It is generated with the `title` helper when one is
configured and with the session's live model otherwise, the way a session title is.
The badge is the model the agent runs on: the resolved `agent.model` or
per-agent override when one matched, else the session's own model that the agent
inherited. An agent that fell back to another model shows a dim `↓` before its badge.
`agent.showResolvedModelBadge: false` drops the badge.

Light travels down the rail while agents are working. The head crosses the whole block,
so the cycle belongs to the block rather than the row. Where `display.transitions` is
off, the block is still.

There is no elapsed clock and no context gauge. `/agents` shows the roster with
those numbers.

Narrow the terminal and the model badge comes off first, then the label shortens to
what is left. Nothing wraps: the block draws no row it cannot fit, and draws nothing
at all rather than overflow.

Eight rows are drawn. Past that the block states how many more are running under the
last row and points at `/agents`, which is the full roster. That row is the only place
a count appears; the header is bare.

## Limits and isolation

The remaining groups in the tab are operational: how many agents run at once
(`agent.maxConcurrency`), how deeply they may nest (`agent.maxNestedSpawnDepth`),
per-run wall clock and request limits, how long a finished agent stays live
before it falls asleep (`agent.idleTtlMs`), and whether its edits land in an isolated
copy of the tree first (`agent.isolation.*`, see [Safety](../using/safety.md)).

### Running, idle, asleep

An agent is `running`, `idle` or `asleep`.

- `running`: a turn is in flight.
- `idle`: the turn finished and the session is still in memory.
- `asleep`: the session is released and its transcript is on disk.

An idle agent falls asleep after `agent.idleTtlMs` ("Sleep Idle Agents After", five
minutes by default). Its process, MCP clients and memory are released and its transcript
is flushed to disk. `0` ("Never") keeps idle agents live until the session exits.

Messaging or opening an asleep agent wakes it from its transcript. Every agent with a
transcript can be woken for the rest of the session, including one that was stopped,
failed, timed out or hit its request limit. No status is terminal and no agent is removed
from the roster.

`running` moves to `idle` when the turn drains, or to `asleep` when the run is stopped or
ran in an isolated copy of the tree. `idle` moves to `running` on the next turn, or to
`asleep` on the idle timeout or a stop. `asleep` moves to `idle` when woken. Any other move
is rejected, so a turn event that arrives after a stop cannot restart the agent.

### Stopping an agent

`x` on the `/agents` roster, `job cancel` and a collab guest's kill stop an agent: its turn
is aborted and it and every agent it spawned fall asleep. Message it to continue.

### The roster

`irc list` names every running and idle agent and the ten asleep agents active most
recently. Older asleep agents are counted on one line and still wake when messaged by id.
The `/agents` dashboard lists every agent.

### When the idle timeout starts counting

The idle timeout counts from the agent's last activity; a woken agent starts it again from
the wake. An agent read back from a previous run is aged from when its transcript was last
written, not from when this session found it.

A `running` agent has no deadline. An agent waiting on an approval prompt is mid-turn and
stays `running`.

### An agent on screen does not fall asleep

Opening an agent's session from the `/agents` dashboard keeps it live for as long as the
main view points at it. A sleep deadline that elapses meanwhile is deferred; the idle
timeout counts again from the moment Esc returns the view to your own session.

### If the session cannot be saved

Falling asleep flushes the agent's session to disk before releasing it. If the flush
fails, the agent stays live, its timer is re-armed, and the next expiry tries again.

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

Agents run inside the same process as your session. The main session also moves the
process working directory when it re-roots, so that a command you run and a relative
path you write agree with the project you have open. An agent does not move the process
working directory, so its `set_cwd` cannot make another session's command run in the
wrong repository.

An agent working elsewhere does not pick up that project's settings, capabilities or
plugins, because those are read once for the process. Give an agent a task in another
project only when the work is self-contained, and re-root
your own session instead when you want that project's configuration to apply.

The full key list is in the [settings reference](../reference/settings.md#agents).
