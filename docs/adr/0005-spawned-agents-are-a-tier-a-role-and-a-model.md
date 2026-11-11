# 0005. A spawned agent is a tier, an optional role, and a model, chosen per spawn

- **Status:** proposed
- **Date:** 2026-11-10

## Context

Measured against `cd6aaecb3`. Paths are under `packages/coding-agent/src/` unless stated.

### One name carries three axes

Every spawnable agent is one flat name. The name selects the prompt body, the tool allowlist, the
output schema, the spawn right and the settings row that holds its model. Six agents ship
(`task/agents.ts`, `prompts/agents/*.md`):

| Agent | `tools` | `spawns` | Output schema | Enabled by default |
| --- | --- | --- | --- | --- |
| `deep` | unset (full set) | `*` | none | yes |
| `sonic` | unset (full set) | unset | none | no |
| `scout` | read, search, web_search | unset | yes | no |
| `reviewer` | read, search, bash, lsp, web_search | scout | yes | no |
| `librarian` | read, search, bash, lsp, web_search | unset | yes | no |
| `designer` | unset (full set) | unset | none | no |

Consequences of the flat name:

- `deep` and `sonic` are described to the model as a cost ladder, and neither sets a model, an
  effort or a tool list, so both run the session model on the full toolset. Their remaining
  difference is `spawns: "*"`. With the default `agent.maxNestedSpawnDepth: 0`, a direct child runs
  at depth 1 and `canSpawnAtDepth(0, 1)` (`task/types.ts`) is false, so `spawns: "*"` has no effect
  either. At defaults the two rungs differ only in prompt text.
- `reviewer` and `librarian` describe themselves as read-only and carry `bash`. `isReadOnlyAgent`
  (`task/index.ts`) requires every tool to be in `READ_ONLY_TOOL_NAMES`, so neither receives the
  `READ-ONLY` marker in the tool description, and `bash` can write.
- A role cannot run at a different capability level or on a different model for one spawn. A
  reviewer on a cheap model, or a scout on a strong one, is set on that agent's settings row and
  applies to every later spawn of it.

### The model is chosen in two different ways

The `task` tool schema (`taskItemSchema`, `task/types.ts`) accepts `name`, `agent`, `task`, `cwd`
and `isolated`. The eval bridge's `agent()` (`eval/agent-bridge.ts`) also accepts `model`. The same
spawn has two contracts depending on which tool issued it.

### Five mechanisms decide model and depth

- `agent.agents.<name>`: a recursive lane (`AgentLaneSettings`) whose `agents` field nests without
  bound; model and effort are read from the level indexed by `taskDepth - 1` and walk upward.
- `agent.sharedModel` with `agent.model` and `agent.thinkingLevel`: an exclusive switch that hides
  the per-agent rows.
- `agent.maxNestedSpawnDepth`: the blanket depth.
- `maxNestedSpawnDepth` on a lane row: still read for old config files.
- `agent.modelByDepth`: retired, still reported.

`task/agent-settings.ts` (954 lines) resolves all five. The settings page that edits them is
`modes/terminal/components/selectors/agents-submenu.ts` (1,149 lines).

### "Roster" names three things

- The settings row `agent.agents`, labelled "Roster", which lists subagents and helpers.
- The `/agents` dashboard (`modes/terminal/components/dashboard/agent-dashboard.ts`), which calls
  its list of live agents a roster.
- `session/runtime/advisor-roster.ts`, the set of advisors watching a session.

### Helpers sit inside the agents area

A helper is a one-shot model call a feature makes (session title, commit message, vision, memory,
auto thinking, speech and others; `HELPER_IDS` in `task/helper-settings.ts`). Helpers spawn
nothing, yet they are configured under `agent.helpers`, drawn on the Roster page, and defined in
`task/`. `task/helper-settings.ts` has 17 importers in 12 directories (`commit`, `eval`, `goals`,
`memory`, `modes`, `session`, `speech`, `thinking`, `tools`, `utils`), and none of them spawns an
agent.

### Three spawn preparation paths

`task/spawn-run.ts` (`prepareSpawn`), `eval/agent-bridge.ts` and `session/vibe-runtime.ts` each
resolve the definition, call `resolveAgentModel` and `resolveAgentThinkingLevel`, inherit skills
and prompt templates, and build `ExecutorOptions` on their own. The child's tool list is then
adjusted in `resolveChildToolNames` (`task/executor.ts`, 2,459 lines): `task` is added or removed
by depth, `irc` is always added, `exec` expands to `bash` and `eval`.

### No interactive spawn

An interactive session has no command that starts a chosen agent on a chosen model. The route is a
prompt to the main model, which picks among enabled agents and cannot pick a model through `task`.
`/agents` opens the dashboard. A custom command may grant one agent for one turn
(`session/runtime/prompt-commands.ts`).

### Authoring location

Definitions are read from `~/.veyyon/subagents` (`getGlobalSubagentsDir`,
`packages/utils/src/config-root.ts`). The doc comment on `DEFAULT_ENABLED_BUNDLED_AGENT` in
`config/settings-domains/agents.ts` states `~/.veyyon/agents/`. A repository's `.veyyon/agents/` is
not read, because a definition carries a prompt, a tool list, a model and a spawn right.

### Module structure

The agents area is one instance of a structure problem across `packages/coding-agent/src`.
Measured over value imports (`import` and `export … from` with a relative specifier, `import type`
excluded, test files excluded), grouped by top-level directory:

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

File-level cycles are tested and absent. Directory-level layering is not tested, and every major
directory reaches every other one. Examples in the agents area: `task/` and `session/` import each
other (5 and 18 edges), `task/` and `tools/` import each other (20 and 14 edges), and `src/utils/`
imports `task/helper-settings.ts` and `session/cpu-limit.ts`.

## Decision

### Three axes, one spawn request

A spawn names a **tier**, an optional **role**, and optionally a **model** and an **effort**.

**Tier** is the capability level. It sets the tool ceiling and the spawn right. The set is fixed in
code, because tools are code and the prompt of every role relies on what its tier allows.

| Tier | Tools | May spawn | Replaces |
| --- | --- | --- | --- |
| `read` | `READ_ONLY_TOOL_NAMES` | no | scout's tool list |
| `run` | `read` plus `bash`, `eval`, `lsp` | no | reviewer's and librarian's tool lists |
| `edit` | full set without `task` | no | `sonic` |
| `deep` | full set with `task`, bounded by `agent.maxDepth` | yes | `deep` |

`READ-ONLY` is rendered for `read` only. `run` is described as able to run commands.

**Role** is an optional markdown definition: description, prompt body, the tiers it accepts (the
first is its default), an optional `tools` list that narrows within the tier, an output schema,
`autoloadSkills` and `read-summarize`. A `tools` entry outside every accepted tier is a load error
naming the file and the tool. Bundled roles: `scout` (read), `reviewer` (run), `librarian` (run),
`designer` (edit). `deep` and `sonic` stop being roles: their bodies become the generic prompts for
the `deep` and `edit` tiers, used when a spawn names no role. Custom roles are read from
`~/.veyyon/roles/`. `~/.veyyon/subagents` is read once more for one release and each file there is
reported with its new path.

**One request type** reaches every entry point:

```ts
interface SpawnRequest {
	task: string;
	role?: string;
	tier?: Tier;
	model?: string;
	effort?: string;
	name?: string;
	cwd?: string;
	isolated?: boolean;
}
```

- Tier: the request's tier, else the role's default tier, else `agent.defaultTier`. A tier the role
  does not accept is refused with the accepted list.
- Model: the request's model, else the role's settings row, else the tier's settings row, else the
  session model. Effort follows the same order. A `:level` suffix on the model wins, as today.
- A model or effort that resolves to nothing is refused with the setting path or argument that
  named it, as `resolveAgentModel` does today.

**`agent.modelChoice`** controls the `model` and `effort` fields on calls the model makes:

| Value | Schema | Accepts |
| --- | --- | --- |
| `off` | fields absent | nothing |
| `aliases` (default) | fields present | names in `agent.modelAliases` |
| `any` | fields present | any model pattern |

Interactive spawns accept any model regardless. The tool description lists each enabled tier, each
enabled role with its tier, and the aliases when `modelChoice` is not `off`.

### Settings

| Key | Shape | Notes |
| --- | --- | --- |
| `agent.enabled` | boolean | unchanged |
| `agent.delegation` | `allowed` \| `preferred` \| `required` | unchanged |
| `agent.defaultTier` | tier | default `deep` |
| `agent.tiers.<tier>` | `{ enabled, model, effort }` | four rows |
| `agent.roles.<name>` | `{ enabled, model, effort }` | one row per discovered role |
| `agent.modelChoice` | `off` \| `aliases` \| `any` | default `aliases` |
| `agent.modelAliases` | record of alias to model chain | e.g. `fast`, `strong` |
| `agent.maxDepth` | number | renamed from `agent.maxNestedSpawnDepth`; applies to `deep` |
| `helpers.<id>` | `{ model, effort }` | moved from `agent.helpers` |

Limits, idle, isolation and `worktree.base` keys are unchanged. `agent.agents`, `agent.sharedModel`,
`agent.model`, `agent.thinkingLevel`, lane `maxNestedSpawnDepth` and `agent.modelByDepth` are
retired through `config/settings-migrations.ts`:

- `agent.agents.deep` and `agent.agents.task` map to `agent.tiers.deep`, `agent.agents.sonic` to
  `agent.tiers.edit`, every other name to `agent.roles.<name>`. Depth-0 `enabled`, `model` and
  `thinkingLevel` carry over.
- A nested `agents` level has no target. It is reported once with its full path and the per-spawn
  `model` field as the replacement.
- `agent.sharedModel: true` writes `agent.model` and `agent.thinkingLevel` into every tier row.
- `agent.helpers.<id>` moves to `helpers.<id>`.

### Names

| Term | Meaning | Surface |
| --- | --- | --- |
| Tier | capability level | Settings → Agents → Tiers |
| Role | a definition file | Settings → Agents → Roles |
| Agent | a running or asleep instance | `/agents` dashboard |
| Advisor | a session watcher | `session/runtime/advisors.ts` |
| Helper | a one-shot model call by a feature | Settings → Models → Helpers |

"Roster" is removed from labels, keywords and file names.

### Interactive spawning

- `/spawn [role] [--tier t] [--model m] [--effort e] <task>` builds a `SpawnRequest` and runs it
  with no main-model turn. The result is delivered into the conversation as an async `task` result
  is. Completion offers role names, tiers and aliases. An explicit spawn ignores `enabled`, as a
  command grant does today, and is bound by the limits.
- `n` on the `/agents` dashboard opens the same request as a picker: role, tier, model, task.
- Settings → Agents → Roles → New role writes `~/.veyyon/roles/<name>.md`, generated by the
  existing `prompts/agent/agent-creation-architect.md` flow.

### Code layout

```
src/agents/
  definitions/   tier table, role parsing and discovery
  policy/        resolveSpawn(request, ctx) -> ResolvedSpawn
  runtime/       executor, scheduler, semaphore, lifecycle, registry, irc bus
  surfaces/      task tool, eval agent() adapter, vibe adapter, views
src/helpers/     helper model selection
```

`ResolvedSpawn` holds the role, tier, final tool list, spawn right, model patterns with the
deciding source, effort and depth. `task/spawn-run.ts`, `eval/agent-bridge.ts` and
`session/vibe-runtime.ts` call `resolveSpawn` and keep no resolution of their own.
`resolveChildToolNames` moves into `policy/`.

An architecture test fixes the dependency direction: `agents/definitions` and `agents/policy`
import nothing from `session/`, `modes/`, or `tools/`; code outside `agents/` imports
`agents/index.ts` only; `helpers/` imports nothing from `agents/`.

### Directory layering

A second architecture test records the directory-level value-import graph of
`packages/coding-agent/src` and fails on any edge not in its allowlist. The allowlist starts at
today's edges and only shrinks; a removed edge that reappears fails. The size of the largest
strongly connected component is reported by the test and is expected to fall with each change in
the sequence below. The full layer assignment for every directory is a separate decision.

### Sequence

Each step is one pull request and leaves the product working.

1. Move helpers to `src/helpers/` and `helpers.*`, with the settings migration.
2. Add `resolveSpawn` and route the three entry points through it, with no behavior change. Parity
   test: every bundled agent and a custom one resolve to the same model, effort and tool list before
   and after.
3. Tiers, roles, the new settings and the migration; tool description rendering.
4. `model` and `effort` on the `task` schema, `agent.modelChoice`, `agent.modelAliases`.
5. `/spawn`, the dashboard picker, the role wizard, and the rename away from "Roster".
6. Move files into `src/agents/` and add both architecture tests.

## Consequences

- One spawn contract for `task`, eval `agent()`, vibe and `/spawn`.
- The tool list and spawn right of an agent are stated by its tier, and the tier name is what the
  model reads. `READ-ONLY` matches the tools.
- Model and effort can be chosen per spawn by the main model within aliases, and without limit from
  the terminal.
- Model per nesting depth is no longer configurable. A `deep` agent that wants a different model
  for its children passes `model` on its own spawn.
- Config files that set `agent.agents` are rewritten once by the migration. Nested lane values are
  reported, not migrated.
- Custom definitions move from `~/.veyyon/subagents` to `~/.veyyon/roles`, with one release of
  overlap.
- `docs/internal/task-agent-discovery.md`, `docs/handbook/src/features/agents.md`,
  `docs/handbook/src/features/agents-authoring.md`, the settings reference and the `task` tool
  prompt are rewritten in the step that changes their subject.

## Alternatives considered

- **Add `model` to the `task` schema and keep the flat names.** Fixes per-spawn models only. Tool
  levels remain a property of each name, and `deep` and `sonic` remain the same toolset.
- **Roles only, no tiers.** Every role restates a tool list, and a spawn with no role has no stated
  capability. The `deep`/`edit` distinction is lost or becomes two more roles.
- **Custom tiers.** A tier is a tool contract the prompts rely on. Custom behavior belongs in a role,
  which may narrow tools within a tier.
- **Unrestricted model choice by default.** A model choosing its own subagent model can select the
  most expensive one on every spawn. `aliases` limits the choice to models a config file names.
- **Extract agents into `plugins/`.** A plugin may not import `packages/coding-agent` internals, and
  the executor constructs sessions. This becomes possible after `src/agents/` has the dependency
  direction above.
- **Keep the per-depth lane tree and add a picker.** The tree is the largest single source of
  resolution code and settings UI in the area, and a per-spawn model covers the case it serves.
