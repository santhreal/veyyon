# Task Agent Discovery and Selection

This document describes how the task subsystem discovers agent definitions, merges multiple sources, and resolves a requested agent at execution time.

It covers runtime behavior as implemented today, including precedence, invalid-definition handling, and spawn/depth constraints that can make an agent effectively unavailable.

## Implementation files

- [`src/task/discovery.ts`](../../packages/coding-agent/src/task/discovery.ts)
- [`src/task/agents.ts`](../../packages/coding-agent/src/task/agents.ts)
- [`src/task/types.ts`](../../packages/coding-agent/src/task/types.ts)
- [`src/task/index.ts`](../../packages/coding-agent/src/task/index.ts)
- [`src/task/commands.ts`](../../packages/coding-agent/src/task/commands.ts)
- [`src/prompts/agents/deep.md`](../../packages/coding-agent/src/prompts/agents/deep.md)
- [`src/prompts/tools/task.md`](../../packages/coding-agent/src/prompts/tools/task.md)
- [`src/discovery/helpers.ts`](../../packages/coding-agent/src/discovery/helpers.ts)
- [`src/config.ts`](../../packages/coding-agent/src/config.ts)
- [`src/task/executor.ts`](../../packages/coding-agent/src/task/executor.ts)

---

## Agent definition shape

Task agents normalize into `AgentDefinition` (`src/task/types.ts`):

- `name`, `description`, `systemPrompt` (required for a valid loaded agent)
- optional `tools`, `spawns`, `model`, `thinkingLevel`, `output`, `blocking`, `autoloadSkills`, `readSummarize`
- `source`: `"bundled" | "user" | "project"`
- optional `filePath`

Parsing comes from frontmatter via `parseAgentFields()` (`src/discovery/helpers.ts`):

- missing `name` or `description` => invalid (`null`), caller treats as parse failure
- `tools` accepts CSV or array; if provided, `yield` is auto-added
- `spawns` accepts `*`, CSV, or array
- backward-compat behavior: if `spawns` missing but `tools` includes `task`, `spawns` becomes `*`
- `output` is passed through as opaque schema data
- `read-summarize: false` (parsed as `readSummarize`) forces the subagent's `read` tool to return verbatim file content instead of structural summaries: `runSubprocess` applies it as a `read.summarize.enabled: false` override on the subagent's isolated settings (`src/task/executor.ts`). `scout` and `librarian` ship with it disabled. Defaults to enabled when the field is absent.

## Bundled agents

Bundled agents are embedded at build time (`src/task/agents.ts`) using text imports.

`EMBEDDED_AGENT_DEFS` defines:

- `scout`, `designer`, `reviewer`, `librarian` from their own prompt files, frontmatter included
- `deep` (`agents/deep.md`) and `sonic` (`agents/sonic.md`) from their own prompt bodies plus frontmatter injected in code, because `name`, `description`, `spawns` and `thinkingLevel` are the cost-ladder rungs and are written next to each other rather than in two files

`task` was renamed `deep` (`RETIRED_AGENT_NAMES` in `src/task/spawn-policy.ts`). The old name still resolves through `currentAgentName`, so a `subagent.agents.task` row, a saved transcript, or an SDK caller passing `agent: "task"` keeps working. An alias never shadows a real agent: resolution tries the literal name first, so a hand-written `task.md` still wins.

Loading path:

1. `loadBundledAgents()` parses embedded markdown with `parseAgent(..., "bundled", "fatal")`
2. results are cached in-memory (`bundledAgentsCache`)
3. `clearBundledAgentsCache()` is test-only cache reset

Because bundled parsing uses `level: "fatal"`, malformed bundled frontmatter throws and can fail discovery entirely.

## Filesystem and plugin discovery

`discoverAgents(cwd, home, agentDir)` (`src/task/discovery.ts`) merges agents from Veyyon-native roots and Claude plugin roots before appending bundled definitions. Cross-harness roots such as `.claude/agents`, `.codex/agents`, and `.gemini/agents` are intentionally skipped, their frontmatter schema is not the Veyyon task-agent contract (`TASK_AGENT_CONFIG_SOURCE = ".veyyon"` filters the dir list). `agentDir` selects the profile for all three profile-scoped sources at once (the user `agents/` dir, that profile's `extensions:` settings and installed plugins, and that profile's marketplace registry); leave it undefined and each source resolves the process-active profile.

### Discovery inputs

1. User `.veyyon` agents dir: `path.resolve(agentDir, "agents")` when `agentDir` is passed, otherwise `getConfigDirs("agents", { project: false })` filtered to `.veyyon`, first hit only. A repository's `.veyyon/agents/` is not read: an agent definition carries a system prompt, a tool allowlist, a model, and a `spawns` field, so a checked-in one could shadow a bundled agent by name. `discoverAgents` returns `projectAgentsDir: null` unconditionally; the field survives only because `task/index.ts` plumbs it into `TaskToolDetails` for display.
2. Veyyon extension-package `agents/` dirs (`listVeyyonExtensionRoots`): only when `isProviderEnabled("veyyon-plugins")`; consumed in source-precedence order (CLI roots > user `extensions:` settings > installed npm/link plugins, marketplace installs excluded by realpath)
3. Claude marketplace plugin roots (`listClaudePluginRoots(home, cwd)`) with `agents/` subdirs: only when `isProviderEnabled("claude-plugins")`; project-scope plugin installs are filtered out
4. Bundled agents (`loadBundledAgents()`)

### Actual source order

1. user `~/.veyyon/profiles/<name>/agent/agents`
2. Veyyon extension-package `agents/` dirs (CLI > user settings > installed plugins)
3. Claude plugin `agents/` dirs (user-scope only)
4. bundled agents last

## Merge and collision rules

Discovery uses first-wins dedup by exact `agent.name`:

- A `Set<string>` tracks seen names.
- Loaded agents are flattened in directory order and kept only if name unseen.
- Bundled agents are filtered against the same set and only added if still unseen.

Implications:

- User and extension-package agents override bundled agents with the same name.
- Name matching is case-sensitive (`Task` and `task` are distinct).
- Within one directory, markdown files are read in lexicographic filename order before dedup.

## Invalid/missing agent file behavior

Per directory (`loadAgentsFromDir`):

- a missing directory contributes nothing and says nothing; one that exists and cannot be listed is reported through `readdirIfPresent(dir, "agent definitions")`, because a user's subagents vanishing from `/agents` with no sign of why is a different failure from having no directory
- a file that cannot be read or parsed is reported through `reportFault({ source: "agents", … })` and skipped, so the loss reaches the operator rather than only a log file
- parse path uses `parseAgent(..., level: "warn")`

Frontmatter failure behavior comes from `parseFrontmatter`:

- parse error at `warn` level logs warning
- parser falls back to a simple `key: value` line parser
- if required fields are still missing, `parseAgentFields` fails, then `AgentParsingError` is thrown and caught by caller (file skipped)

Net effect: one bad custom agent file does not abort discovery of other files.

## Agent lookup and selection

Lookup is exact-name linear search:

- `getAgent(agents, name)` => `agents.find(a => a.name === name)`

In spawn execution (`TaskTool.#executeSync` → `#runSpawn`):

1. agents are rediscovered at execution time (`discoverAgents(this.session.cwd)`)
2. requested `params.agent` is resolved through `getAgent`
3. missing agent returns immediate tool response:
   - `Unknown agent "...". Available: ...`
   - no subprocess runs

### Description vs execution-time discovery

`TaskTool.create()` builds the tool description from discovery results at initialization time. `#executeSync` rediscovers agents, so the runtime set can differ from what was listed in the earlier tool description if agent files changed mid-session. The async entry path still uses the initialization-time list to decide whether an agent is marked `blocking` before scheduling.

### What the model is actually told

The roster the model reads is built in `renderDescription` (`src/task/index.ts`) and rendered by the `Available Agents` block in `src/prompts/tools/task.md`. Per enabled agent it emits four things and nothing else: `name`, `description`, a `READ-ONLY` marker when every entry in `tools` is a read-only tool (`isReadOnlyAgent`), and a `BLOCKING` marker. No cost field, no context size, no model, no thinking level. Selection is therefore driven entirely by one description line each, and that is the whole reason those lines are written the way they are.

The agents are a cost ladder, not a taxonomy. Each description states how much is unknown and how large a change the lane carries, because those are the only two axes the model can route on with the information it has. The routing instruction above the list says to take the cheapest lane that can carry the work, to move up only when the outcome is vague enough that the agent must discover, build and verify it alone, and never to substitute a wider lane for a disabled one. The same axis is repeated once in the system prompt (`src/system-prompt-builder/statements/tool-policy/delegation-gates.md`) so the two surfaces cannot drift into saying different things.

This replaced a rule that read "spawn the one whose description covers the task". The general-purpose lane is enabled by default, and its description was "General-purpose subagent with full capabilities for delegated multi-step tasks", which covers every task by construction, so the rule resolved to it every time. Turning an agent off did not remove the work it was doing: the work rerouted there, at whatever the session model is, with a larger prompt, and the operator got no signal that the cheaper path was gone.

Two related facts still hold and still bound how much the descriptions can do:

- `deep` is the only agent enabled by default (`DEFAULT_ENABLED_BUNDLED_AGENT` in `src/config/settings-domains/subagents.ts`, read by `subagentEnabledByDefault`) and the default spawn target (`DEFAULT_SPAWN_AGENT`). An operator can turn it off with `subagent.agents.deep.enabled: false`, but on a stock install it is where every unqualified spawn lands, so the descriptions are what keep work off it, not the enablement set.
- The only pressure toward a narrower agent is advisory and rarely fires: `buildSpecializationAdvisory`, reached through `composeSpawnAdvisory` (`src/task/index.ts`), nudges only when one call resolves two or more items to `deep` or `sonic` (`GENERIC_SPAWN_AGENTS`), the spawner still holds spawn capacity, and at least one non-generic agent is enabled. A single spawn gets nothing.

`sonic` owns `src/prompts/agents/sonic.md` and `deep` owns `src/prompts/agents/deep.md`. They are separate bodies, so a change to one no longer silently changes the other; `sonic` used to render the general-purpose body byte for byte and so told a contained worker it had "FULL access to all tools" and nothing about staying contained. `sonic` runs at `Effort.Medium` with a 100-request soft budget (`SOFT_REQUEST_BUDGET` in `src/task/executor.ts`, which `scout` also carries; every other agent gets 200), and `deep` inherits the parent's thinking level. Neither pins a model, so both resolve through `resolveSubagentModel` to the session model unless the operator fills in an agent row.

Any change here is measured against one question: does enabling or disabling this agent move where work lands, or only what the prompt says?

## Structured-output guardrails and schema precedence

Runtime output schema precedence in `TaskTool.#runSpawn`:

1. agent frontmatter `output`
2. parent session `outputSchema`

(`effectiveOutputSchema = effectiveAgent.output ?? this.session.outputSchema`, the task call itself never carries a schema; ad-hoc structured workflows go through the eval bridge's `agent(prompt, schema)`.)

The model-facing prompt (`src/prompts/tools/task.md`) no longer carries the old structured-output mismatch warning. What it does carry per agent is the `READ-ONLY` and `BLOCKING` markers and the description line; there is no separate warning about offloading reasoning, and the `explore` agent it once named no longer exists.

## Command discovery interaction

`src/task/commands.ts` is parallel infrastructure for workflow commands (not agent definitions), but it follows the same overall pattern:

- discover from capability providers first
- deduplicate by name with first-wins
- append bundled commands if still unseen
- exact-name lookup via `getCommand`

In `src/task/index.ts`, command helpers are re-exported with agent discovery helpers. Agent discovery itself does not depend on command discovery at runtime.

## Availability constraints beyond discovery

An agent can be discoverable but still unavailable to run because of execution guardrails.

### Per-agent profile settings

`TaskTool.#executeSync` checks `subagent.agents.<name>.enabled` after resolving the agent, through `isSubagentEnabled` — one predicate, and the same one that decides what goes in the tool description, so the set the model is offered and the set it may spawn cannot diverge. A disabled agent is refused, and the refusal names the setting and lists the enabled agents. The one thing that also passes is a per-turn grant: a `/` command declares the agents its prompt names (`CustomCommand.spawnsAgents`), the session grants them for the turn that prompt starts, and `TaskTool` consults `session.agentGrantedThisTurn`. That is how `/review` spawns `reviewer` on a stock install where every other agent is disabled.

### Parent spawn policy

`TaskTool.#executeSync` checks `session.getSessionSpawns()`:

- `"*"` => allow any
- `""` => deny all
- CSV list => allow only listed names

If denied: immediate `Cannot spawn '...'. Allowed: ...` response.

### Blocked self-recursion env guard

`VEYYON_BLOCKED_AGENT` is read at tool construction. If request matches, execution is rejected with recursion-prevention message.

### Recursion-depth gating (task tool availability inside child sessions)

In `runSubprocess` (`src/task/executor.ts`):

- depth computed from `taskDepth`
- `subagent.maxNestedSpawnDepth` controls the cutoff
- when at max depth:
  - `task` tool is removed from child tool list
  - child `spawns` env is set to empty

So deeper levels cannot spawn further tasks even if the agent definition includes `spawns`.

## Plan mode behavior

When parent plan mode is enabled, `TaskTool.#runSpawn` builds an `effectiveAgent` before launching subprocesses:

- prepends the plan-mode subagent system prompt
- restricts tools to `read`, `grep`, `glob`, `lsp`, and `web_search`, plus `ast_grep`/`report_finding` when the agent's own tool list declares them (`PLAN_MODE_AGENT_TOOL_ALLOWLIST`)
- clears child spawns

The same `effectiveAgent` is used for subprocess launch, model/thinking overrides, and output-schema selection.

*Verified against `7e4c6374` on 2026-08-06.*
