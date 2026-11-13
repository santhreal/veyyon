# 0005. Agents keep their names, are mentioned with `@`, and load on demand

- **Status:** proposed
- **Date:** 2026-11-12

## Context

Measured against `f7dc42030`. Paths are under `packages/coding-agent/src/` unless stated. Screen
observations come from `proof/scenes/agents-ux-audit.sh`, recorded through `proof/record.sh`.

### Bundled agents

Six agents ship (`task/agents.ts`, `prompts/agents/*.md`):

| Agent | `tools` | `spawns` | Output schema | Enabled by default |
| --- | --- | --- | --- | --- |
| `deep` | unset (full set) | `*` | none | yes |
| `sonic` | unset (full set) | unset | none | no |
| `scout` | read, search, web_search | unset | yes | no |
| `reviewer` | read, search, bash, lsp, web_search | scout | yes | no |
| `librarian` | read, search, bash, lsp, web_search | unset | yes | no |
| `designer` | unset (full set) | unset | none | no |

- One `description` serves two readers. It is the routing text the model reads in the `task` tool
  description, and it is the only text the settings pages can show about an agent. `deep` reads
  "Vague outcome, multi-step, owned end to end: works out what to change, changes it, tests it, and
  reviews its own work before returning. Scale it can carry: building a whole package from nothing.
  The most expensive lane, so do not reach for it when the outcome is already clear."
- `sonic` is a name with no relation to its job, which is a contained change with a clear outcome.
- `reviewer` and `librarian` describe themselves as read-only and carry `bash`. `isReadOnlyAgent`
  (`task/index.ts`) requires every tool to be in `READ_ONLY_TOOL_NAMES`, so neither receives the
  `READ-ONLY` marker, and nothing tells the model that they run commands.
- An agent is enabled or disabled. A disabled agent cannot run at all, so the five agents other
  than `deep` are unreachable on a stock install until their row is changed.

### Settings

Settings → Agents shows, in order: `Agents`, `Agent Delegation`, `Roster` (value `defaults`),
`Max Nested Spawn Depth`, `Same Model for All Agents`, then limits, idle, isolation, coordination
and two advanced rows.

- The list of agents is one row among fourteen, named `Roster`, with the value `defaults`. Its
  description is cut at the panel width after "Subagents are the agent types the model".
- `Roster` opens a page that lists subagents and helpers together. A helper is a one-shot model
  call a feature makes (title, commit message, vision, memory and others; `HELPER_IDS` in
  `task/helper-settings.ts`) and spawns nothing. `task/helper-settings.ts` has 17 importers in 12
  directories, none of which spawns an agent.
- `Same Model for All Agents` hides every per-agent Model and Effort row while it is on.
- Model per nesting depth is a recursive lane tree under `agent.agents.<name>.agents`.
  `task/agent-settings.ts` (954 lines) resolves it with the shared switch, the blanket depth and
  two retired keys. The page that edits it, `modes/terminal/components/selectors/agents-submenu.ts`,
  is 1,149 lines.
- Searching settings for `agent` returns 39 rows in 11 categories and places the cursor on
  `Session Memory Limit` under Resources.
- "Roster" also names the `/agents` dashboard's list of live agents and
  `session/runtime/advisor-roster.ts`.

### Invocation

There is no way to direct a message at one agent. The route is a prompt to the main model, which
picks among enabled agents and cannot pick a model through `task` (`taskItemSchema`,
`task/types.ts`); eval `agent()` (`eval/agent-bridge.ts`) can. A custom command may grant one agent
for one turn through `PromptCommands.agentGranted` (`session/runtime/prompt-commands.ts`).

The composer already has the parts a mention needs:

- `@` opens file completion (`packages/utils/src/autocomplete.ts`), and a submitted `@path` is
  read by `utils/file-mentions.ts`.
- Magic keywords (`modes/keywords/`) are detected in prose only, painted while typing with an
  animated highlight (`createGradientHighlighter`, `CustomEditor.decorateText`), and turned into a
  hidden notice appended after the user message (`session/magic-keyword-notices.ts`).
- An `@` word that matches no file closes the popup and shows nothing: `@rev` reads as a file
  search with no result.
- `ultrathink` is drawn with a full-spectrum hue sweep; nothing else in the composer is drawn.

### What the model reads

`renderDescription` (`task/index.ts`) writes every enabled agent into the `task` tool description
with its full `description`, from the first turn to the last, whether or not the session ever
spawns it. Plugin and user agents copied from other harnesses often carry descriptions of several
thousand characters with worked examples. Enabling or disabling an agent mid-session changes the
tool description and with it the cached prompt prefix.

### Three spawn preparation paths

`task/spawn-run.ts` (`prepareSpawn`), `eval/agent-bridge.ts` and `session/vibe-runtime.ts` each
resolve the definition, the model and the effort on their own and build `ExecutorOptions`.
`resolveChildToolNames` (`task/executor.ts`, 2,459 lines) adjusts the child's tools afterwards.

### Module structure

Measured over relative value imports, test files excluded, grouped by top-level directory of
`packages/coding-agent/src`:

| Measure | Value |
| --- | --- |
| `packages/coding-agent` share of first-party TypeScript source | 450,061 of 837,282 lines |
| Files under `packages/coding-agent/src` | 1,476 |
| Top-level directories under it | 42 |
| Directories in one strongly connected component | 38 of 42 |
| Directory pairs that import each other | 70 |
| File-level import cycles | 0 (`test/architecture/no-import-cycles.test.ts`) |
| Files over 1,000 lines / over 2,000 lines | 76 / 12 |
| Largest file | `session/agent-session.ts`, 4,560 lines |

`task/` and `session/` import each other (5 and 18 edges), as do `task/` and `tools/` (20 and 14),
and `src/utils/` imports `task/helper-settings.ts`.

## Decision

### The bundled agents stay

The six agents keep their prompts, tools and `agent.agents.<name>` rows. There are no tiers.
Capability is what an agent's `tools` and `spawns` already say, and every surface shows it as four
marks derived from them: reads, runs commands, edits, spawns.

One rename: `sonic` becomes `quick`, through `RETIRED_AGENT_NAMES` (`task/spawn-policy.ts`), which
already resolves `task` to `deep`. `sonic` keeps resolving in config files, `task` calls, eval
`agent()` and mentions.

Each definition gains two optional frontmatter fields, so the model's routing text stops being the
operator's only description:

| Field | Reader | Limit | Example (`reviewer`) |
| --- | --- | --- | --- |
| `summary` | settings, completion popup, dashboard | 60 characters | Finds bugs in existing code; never edits |
| `hint` | composer placeholder after a mention | 60 characters | what to review, e.g. the diff against main |

A definition without `summary` shows the first sentence of `description`. Bundled summaries:

| Agent | Summary | Marks |
| --- | --- | --- |
| `deep` | Owns a vague, multi-step job end to end | reads, runs, edits, spawns |
| `quick` | Makes a clear, contained change | reads, runs, edits |
| `scout` | Maps unfamiliar code; never edits | reads |
| `reviewer` | Finds bugs in existing code; never edits | reads, runs, spawns |
| `librarian` | Answers library questions from source | reads, runs |
| `designer` | Builds and polishes user-facing UI | reads, runs, edits |

`spawns` is drawn dim while `agent.maxNestedSpawnDepth` is `Parent only`, the default, because a
spawned agent then receives no `task` tool.

The model-facing marker becomes accurate: `READ-ONLY` for an agent whose tools are all read-only,
and `RUNS COMMANDS, DOES NOT EDIT` for one whose only non-read tools are `bash`, `eval` and `lsp`.

### Availability replaces enabled

`agent.agents.<name>.availability`:

| Value | Label | The model may choose it | A mention runs it |
| --- | --- | --- | --- |
| `auto` | Whenever useful | yes | yes |
| `mention` | When mentioned | no | yes |
| `off` | Off | no | no |

Defaults: `deep` is `auto`; every other bundled agent, every user agent and every plugin agent is
`mention`. A new agent is usable the moment its file exists, and costs nothing in the prompt until
it is mentioned.

### Mentions

`@name` in the composer names an agent or a model for that message. There is no spawn command.

- **Completion.** `@` opens one popup with three sections: Agents (name, summary, marks, model),
  Models (shortcuts from `agent.modelShortcuts`, then catalog models), Files. Off agents are listed
  dimmed. An agent name wins over a bare file name; `@./name` names the file.
- **Grammar.** `@<agent>` names an agent. `@<model>[:<effort>]` names a model by shortcut, id or
  fuzzy name, with an optional effort. A model mention that follows an agent mention in the same
  sentence binds to it (`@reviewer @strong check the diff`); a model mention alone names the model
  for whatever the message delegates, as in T3 Code. Several agent mentions in one message are
  several spawns.
- **Drawing.** An accepted agent mention is drawn bold on the accent glow background with a
  shimmer: a `createGradientHighlighter` spec whose hue sweeps the accent band (18° to 42°), stepped
  every `SHIMMER_FRAME_MS` while the composer has focus. A model mention is drawn on the same
  background with a low-saturation silver sweep. Magic keywords keep their full-spectrum sweep, so
  the three read apart. The sent message keeps the static form. An unknown name stays plain text.
- **Filling in.** While an `@` word is being typed, the rest of the selected candidate is drawn as
  dim ghost text and Tab accepts it. A word that matches no name within edit distance 2 of an agent
  is plain text, and the preview line offers the nearest agent (`no agent reveiwer; tab: @reviewer`).
  After a model mention, `:` completes the effort levels.
- **Placeholder.** After `@reviewer ` the composer shows the agent's `hint` as dim placeholder text
  until the first character is typed. The part of the hint after `e.g.` is a suggested request,
  and Tab inserts it. A message that is only mentions delegates the current conversation's work as
  the agent's `hint` describes.
- **Preview.** While a mention is in the draft, the line under the composer states what Enter does:
  agent, resolved model and effort with the setting that chose them, and marks. It warns when the
  sentence asks an agent for something its marks exclude (`reviewer does not edit; @quick does`)
  and when the agent is off, with a key that sets it to `When mentioned`.
- **Sending.** Each mention adds a hidden notice after the user message, as a magic keyword does,
  rendered from `prompts/turn-control/agent-mention-notice.md`: the agent, the bound model and
  effort, and the sentence it was named in. The mention grants the agent and the bound model for
  that turn through the `PromptCommands` grant set, which the enabled checks in `task/index.ts`,
  `task/spawn-run.ts` and `eval/agent-bridge.ts` already consult (`agentGrantedThisTurn`). The main
  model writes the assignment; a spawned agent starts blank and needs the context only the main
  model has.

### Loading: preloaded or on demand

`agent.loading`:

| Value | `task` tool description | When an agent is mentioned |
| --- | --- | --- |
| `preloaded` (default) | every `auto` agent with its full `description` and markers | its full definition is appended to that turn unless the tool description already holds it |
| `on-demand` | every `auto` agent as one line: name, summary, marks | its full definition is appended to that turn |

`mention` agents are never in the tool description in either mode. An appended definition is part
of the turn notice after the user message; it is never written into the system prompt or the tool
description, so the cached prefix does not change when a definition loads. A definition already
appended in the session is not appended again. The spawned agent loads its own prompt, skills and
rules at spawn in both modes.

### Models

- `agent.defaultModel` and `agent.defaultEffort` replace `Same Model for All Agents`. They are a
  layer, not a switch: agent row, then default, then the agent's frontmatter, then the session.
- `agent.modelShortcuts`: names such as `fast`, `strong`, `local`, each a model chain. Usable in
  mentions and in `task` calls.
- `model` and `effort` on the `task` schema, governed by `agent.modelChoice`: `off` (fields absent),
  `shortcuts` (default; names in `agent.modelShortcuts`), `any`. A model bound by a mention is
  accepted for that turn regardless.
- The lane tree stays and moves to the agent's page as `Model for Agents It Spawns`. Its config
  shape is unchanged.

### Settings → Agents

```
◆ Delegation
Agents                     On
When to Delegate           When it helps          (allowed / preferred / required: unchanged values)
◆ Agents
deep        Whenever useful   session model      reads · runs · edits · spawns
quick       When mentioned    session model      reads · runs · edits
scout       When mentioned    fast               reads
reviewer    When mentioned    strong             reads · runs
librarian   When mentioned    session model      reads · runs
designer    Off               session model      reads · runs · edits
+ New agent…
◆ Loading
Agent Definitions          Preloaded
◆ Models
Default Agent Model        session model
Default Agent Effort       session effort
Model Shortcuts            fast, strong, local
Agents May Pick Models     Shortcuts only
◆ Nesting
Nested Agents              Parent only        (agent.maxNestedSpawnDepth: unchanged)
◆ Limits · Idle · Isolation · Coordination   (unchanged)
```

- Each agent is a row of the category, not a page behind a `Roster` row. Space cycles
  availability; Enter opens the agent's page: summary, file, Availability, Model, Effort, Model for
  Agents It Spawns, tools, output fields, prompt, `e` to edit the file, `d` to duplicate it as a user
  agent.
- `+ New agent…` asks for a name, one sentence of what it does, and the agent to start from, which
  sets the tools. The file is generated by `prompts/agent/agent-creation-architect.md`, shown for
  review, and written to `~/.veyyon/subagents/<name>.md` on save, as `veyyon agents unpack` writes
  today.
- Helpers move to Settings → Model → Helpers. Their key, `agent.helpers`, is unchanged.
- "Roster" is removed from labels and keywords. Terms: agent, helper, advisor.

### Migration

`config/settings-migrations.ts` gains one step:

- `agent.agents.<name>.enabled: true` → `availability: auto`; `false` → `off`; absent → the new
  default.
- `agent.agents.sonic` → `agent.agents.quick`.
- `agent.sharedModel: true` → `agent.defaultModel` and `agent.defaultEffort` from `agent.model` and
  `agent.thinkingLevel`; per-agent Model and Effort values, which the switch had made inactive, are
  cleared and listed. `agent.sharedModel: false` is dropped.
- Every other key keeps its name and value, including `agent.helpers`, the lane tree,
  `agent.delegation` and `agent.maxNestedSpawnDepth`.

The first session after the migration shows one card: what was renamed, which agents became
mentionable, any cleared values with the backup path, and Enter to open Settings → Agents.

### Code layout

```
src/agents/
  definitions/   bundled agents, frontmatter parsing, discovery, marks
  policy/        resolveSpawn(request, ctx) -> ResolvedSpawn; availability; grants
  mentions/      mention detection and notice text (no drawing)
  runtime/       executor, scheduler, lifecycle, registry, irc bus
  surfaces/      task tool, eval agent() adapter, vibe adapter
src/helpers/     helper model selection
modes/terminal/  mention drawing, completion, settings rows, agent page
```

`task/spawn-run.ts`, `eval/agent-bridge.ts` and `session/vibe-runtime.ts` call `resolveSpawn` and
keep no resolution of their own. An architecture test fixes the direction: `agents/definitions`,
`agents/policy` and `agents/mentions` import nothing from `session/`, `modes/` or `tools/`; code
outside `agents/` imports `agents/index.ts`; `helpers/` imports nothing from `agents/`.

A second test records the directory-level value-import graph of `packages/coding-agent/src` and
fails on an edge outside its allowlist. The allowlist starts at today's edges and only shrinks.

### Sequence

Each step is one pull request and leaves the product working.

1. `resolveSpawn` with the three entry points routed through it, no behavior change; parity test
   over every discovered agent.
2. `summary`, `hint`, marks, the accurate model-facing marker, the `quick` rename.
3. `availability` and the migration step with its card.
4. Mentions: completion, drawing, placeholder, preview line, notice, per-turn grant.
5. `agent.loading`.
6. Settings → Agents rows, the agent page, `+ New agent…`, Helpers under Model, `Roster` removed.
7. `agent.defaultModel`, `agent.modelShortcuts`, `model` and `effort` on `task`.
8. Move files into `src/agents/` and `src/helpers/`; both architecture tests.

## Consequences

- A user agent is usable by mention as soon as its file exists, and the model does not see it until
  it is mentioned or set to `auto`.
- Configs carry over with one rename and one field change. No value is lost except per-agent models
  that `Same Model for All Agents` had already made inactive, and those are listed with the backup.
- `On demand` shortens the tool description to one line per `auto` agent; the model routes on the
  summary instead of the full description.
- `docs/internal/task-agent-discovery.md`, `docs/handbook/src/features/agents.md`,
  `docs/handbook/src/features/agents-authoring.md`, the settings reference and the `task` tool
  prompt are rewritten in the step that changes their subject.

## Alternatives considered

- **Tiers and roles** (the first revision of this record). Replaces the six names with four
  capability tiers plus optional roles. Every config and every habit built on the names changes,
  for a distinction the `tools` field already states.
- **A spawn command** (`/spawn reviewer …`). Starts the agent without the main model, so the
  assignment is the operator's sentence alone and the agent starts without the conversation's
  context. A mention keeps the main model writing the assignment.
- **A separate sigil for agents** (`#reviewer`, `$reviewer`). `#` is pull-request completion and
  `$` is skills in other harnesses; `@` already means "this, specifically" in the composer, and T3
  Code uses it for models and threads.
- **On demand as the default.** Changes what the model reads on every upgraded install. Preloaded
  keeps today's behavior; the setting states the size of each choice.
- **Remove the lane tree.** Loses configured values. It moves to the agent's page instead.
