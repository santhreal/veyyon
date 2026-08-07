# task

> Spawn subagents: one per call, or a `tasks[]` batch per call (`subagent.batch`, default on). With `async.enabled=true`, spawns run in the background; otherwise the call blocks until they finish. Execution mode is per item: an item whose agent type declares `blocking: true` in its frontmatter runs inline and returns its result in the call, while non-blocking items in the same call still spawn as background jobs. No bundled agent type declares `blocking`.

## Source
- Entry: `packages/coding-agent/src/task/index.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/task.md`
- Key collaborators:
  - `packages/coding-agent/src/task/types.ts`: dynamic schema, progress/result types, output caps.
  - `packages/coding-agent/src/task/discovery.ts`: discover project/user/plugin/bundled agents.
  - `packages/coding-agent/src/task/agents.ts`: bundled agent definitions and frontmatter parsing.
  - `packages/coding-agent/src/task/executor.ts`: create child sessions, run subagents, collect output, hand finished sessions to the lifecycle manager.
  - `packages/coding-agent/src/registry/agent-lifecycle.ts`: idle-TTL parking and revival of finished subagents.
  - `packages/coding-agent/src/registry/agent-registry.ts`: process-global agent directory (`running | idle | parked | aborted`).
  - `packages/coding-agent/src/async/job-manager.ts`: background job registration, progress, and result delivery.
  - `packages/coding-agent/src/task/parallel.ts`: `Semaphore` used for the session-scoped concurrency bound.
  - `@veyyon/natives` (`crates/veyyon-iso`): isolation PAL: `isoResolve` / `isoStart` / `isoStop` backend resolution and fallback.
  - `packages/coding-agent/src/task/worktree.ts`: isolation mode mapping (`parseIsolationMode`) and lifecycle (`ensureIsolation`/`cleanupIsolation`), patch capture, branch merge.
  - `packages/coding-agent/src/task/output-manager.ts`: session-scoped `agent://` id allocation.
  - `packages/coding-agent/src/task/name-generator.ts`: default AdjectiveNoun agent ids.
  - `packages/coding-agent/src/internal-urls/agent-protocol.ts`: resolve `agent://<id>` to saved subagent output.
  - `packages/coding-agent/src/internal-urls/history-protocol.ts`: resolve `history://<id>` to a concise transcript.
  - `packages/coding-agent/src/tools/index.ts`: tool registration and recursion-depth gating.
  - `packages/coding-agent/src/sdk.ts`: child-session router/tool wiring and per-subagent `AgentOutputManager`.
  - `docs/internal/task-agent-discovery.md`: deeper discovery and precedence notes.

## Inputs

The wire schema is shape-swapped by `subagent.batch` (default on). One unit of work is the task item `{ name?, agent?, task, cwd?, isolated? }` (`isolated` only when `subagent.isolation.mode` is not `none`):

- **Batch shape** (`subagent.batch` on): `{ context, tasks: item[] }`: one subagent per item, all run under the same fan-out rules; there is no top-level agent field. `context` is **required** shared background rendered into every spawned subagent's system prompt (`CONTEXT` section); `agent` and `isolated` are per item, so one call may mix agent types.
- **Flat shape** (`subagent.batch` off): `{ ...item }`: exactly one spawn per call. Shared background goes into a `local://` file (e.g. `local://ctx.md`) that each spawn's `task` references; subagents share the parent's `local://` root.

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `context` | `string` | Yes (batch) | Shared background prepended to every spawn of the call via the subagent system prompt. Rejected when `subagent.batch` is off. |
| `tasks` | `array` | Yes (batch) | One task item per subagent. Provided names must be unique within the call (case-insensitive). Rejected when `subagent.batch` is off. |
| `name` | `string` | No | Stable agent name, becomes the registry/IRC id. Defaults to a generated AdjectiveNoun name. Uniquified per session by `AgentOutputManager`. Item field in batch shape, top-level in flat shape. |
| `agent` | `string` | No | Agent type to run this item (e.g. `scout`). Defaults to the spawn policy's default agent (`deep` under an unrestricted `spawns: "*"`, otherwise the first name the parent's `spawns` list allows); items in one batch call may use different agent types. Item field in batch shape, top-level in flat shape. |
| `task` | `string` | Yes | The work, complete, self-contained instructions. Empty-after-trim is rejected. Item field in batch shape, top-level in flat shape. |
| `cwd` | `string` | No | Per-spawn working-directory override. Item field in batch shape, top-level in flat shape. |
| `isolated` | `boolean` | No | Run in an isolated workspace and return patches. Exists only when `subagent.isolation.mode` is not `none`; per item in batch shape, top-level in flat shape. Isolated agents are torn down at completion, not revivable. |

There is no wire label field: the one-line UI label shown in the TUI/registry is generated automatically from the `task` text by the tiny/title model (fire-and-forget), so callers never provide it.

Runtime stays permissive: the flat form is accepted even while `subagent.batch` is on (internal callers such as the commit flow's `analyze_files`, and stale transcripts). The model only ever sees one shape.

There is no per-call `schema` parameter. Structured output comes from the agent definition's `output` frontmatter, the inherited parent session schema, or, for ad-hoc workflows, the eval bridge's `agent(prompt, schema)`.

## Outputs

The tool returns one text block plus `details: TaskToolDetails`.

Background response (`async.enabled=true`):
- `content`: `` Spawned agent `<id>` (job `<jobId>`). The result will be delivered when it yields. ... `` plus a coordination hint (`irc` DM when enabled, otherwise `job`). A batch call instead returns `` Spawned N background agents using <agent types>. ... `` (the deduped per-item agent types, comma-joined) with a per-agent `- `<id>` (job `<jobId>`)` listing.
- `details`: `{ projectAgentsDir, results, totalDurationMs, progress: [<AgentProgress per spawn>], async: { state, jobId, type: "task" } }`. The call keeps one shared `progress[]` snapshot; `async.jobId` is the first started job and `async.state` aggregates over the async spawns ("running" until every job settles, "failed" if any spawn failed): jobs that settled before the call returned are already reflected. A mixed call's `results` carries the blocking spawns' inline `SingleResult`s (pure background calls return `results: []`).
- Live progress keeps streaming into the same tool block via `onUpdate(...)`; each final result arrives later as an async-result injection into the parent conversation. The delivery text appends a follow-up hint: `` <id> is now idle — message it via `irc` to follow up; transcript at history://<id> `` (aborted variant points at the transcript only).

Settled response (`async.enabled=false`, no job manager, every item's agent `blocking: true`, or async job body):
- `content`: summary rendered from `packages/coding-agent/src/prompts/tools/task-summary.md` with a preview capped at 5000 chars; `agent://<id>` holds the full output. A sync batch concatenates the per-spawn summaries.
- `details.results`: one `SingleResult` per spawn; `usage`, `outputPaths` populated (aggregated across spawns for a sync batch).

`SingleResult` includes:
- identity: `index`, `id`, `agent`, `agentSource`, `description`, optional `assignment` (internal payload names; the wire fields are `name`/`agent`/`task`)
- status: `exitCode`, optional `error`, optional `aborted`, optional `abortReason`, optional `retryFailure`
- output: `output`, `stderr`, `truncated`, `durationMs`, `tokens`, `requests`, optional `contextTokens`/`contextWindow`
- artifact metadata: `outputPath?`, `patchPath?`, `branchName?`, `nestedPatches?`, `outputMeta?`
- extracted tool data: `extractedToolData?` from registered subprocess tool handlers such as `yield` and `report_finding`

Artifacts and side channels:
- Every subagent with an artifacts dir writes `<id>.md`; `agent://<id>` resolves to that file.
- If the output file is JSON, `agent://<id>/<path>` and `agent://<id>?q=<query>` perform JSON extraction.
- Each subagent gets `<id>.jsonl` session history when the parent persists artifacts; `history://<id>` renders it as a concise transcript (works for live and parked agents).
- Isolated patch mode writes `<id>.patch` before merge.

## Flow
1. `TaskTool.create(...)` discovers agents once per cwd through a process-level memo (`discoverAgentsForCreate`) to render the dynamic prompt description.
2. `execute(...)` repairs raw params (`repairTaskParams`), then validates: `schema` is always rejected; `tasks`/`context` are rejected unless `subagent.batch` is on; batch calls need a non-empty `tasks` (a `task` per item, unique provided names), a non-empty shared `context`, and no top-level `task` alongside `tasks`; flat calls need `task`. The call is then normalized into its spawn list (`resolveSpawnItems`).
3. Per-item execution split: items whose agent type declares `blocking: true` run inline; the rest become background jobs. The whole call runs sync when `async.enabled=false`, the session has no `AsyncJobManager` (orphaned host), or every item is blocking; inline spawns run through `#executeSync(...)` under the session-scoped semaphore.
4. Background execution (any non-blocking item with `async.enabled=true` and an `AsyncJobManager`):
   - agent ids are allocated up front via `AgentOutputManager.allocate(...)`, each item's `name`, or a generated AdjectiveNoun name, one per spawn;
   - one `type: "task"` job per spawn is registered with `session.asyncJobManager` (`id` = agent id, `queued: true`, `ownerId` = caller agent id) and the tool returns immediately;
   - each job body acquires the session-scoped `Semaphore` (one per `TaskTool` instance, sized from `subagent.maxConcurrency` at first use), marks the job running, runs `#executeSync(...)` with that spawn's params, and reports progress through the shared `buildAsyncDetails`/`onUpdate`;
   - a failed or aborted run throws `TaskJobError` so the job lands `failed`, but the agent itself stays registered and interrogable.
   - a mixed call registers the async jobs first, then runs its blocking items inline and returns once they settle: the text combines the inline summaries with the spawned-job listing, and the block keeps rendering the still-running background rows beside the inline results.
5. `#executeSync(...)` runs the spawn path (`#runSpawn`), which rediscovers agents from disk, so runtime resolution can differ from the create-time description.
6. It resolves each spawn's requested `agent` type, rejects unknown agents and any agent that is disabled (`subagent.agents.<name>.enabled: false`, or a bundled specialist with no row, since those ship disabled), and enforces parent spawn policy plus `VEYYON_BLOCKED_AGENT` self-recursion prevention. A disabled agent passes only when a `/` command declared it for this turn (`CustomCommand.spawnsAgents` → `session.agentGrantedThisTurn`), which is how `/review` reaches `reviewer`.
7. Output schema priority: agent frontmatter `output` → inherited parent session schema (the call itself never carries one).
8. Plan mode swaps in an `effectiveAgent` with a read-only tool subset and plan-mode prompt; `runSubprocess(...)` receives the effective agent.
9. If `isolated`, it requires a git repo (`getRepoRoot(...)` / `captureBaseline(...)`), maps `subagent.isolation.mode` to a backend-kind hint (`parseIsolationMode`), and materializes the workspace via the natives PAL (`ensureIsolation` → `isoResolve`/`isoStart`), walking the candidate list when a backend is unavailable.
10. Artifacts dir comes from the parent session file when available, otherwise a temp dir. When the session is executing an approved plan, the plan reference is handed to the subagent.
11. Non-isolated spawns call `runSubprocess(...)` directly with parent cwd; isolated spawns run inside the isolation workspace, then commit to a branch (`mergeMode === "branch"`) or capture a patch, and always clean up the workspace.
12. `runSubprocess(...)` creates a child agent session with an isolated settings snapshot (forcing `async.enabled = false` and `bash.autoBackground.enabled = false`: subagents are internally synchronous), child `agentId` equal to the allocated id, child internal URL router/`AgentOutputManager`, output schema, the shared `context` (batch calls) in the system prompt's `CONTEXT` section, and the IRC peer roster in the system prompt.
13. Child tool availability: explicit `agent.tools` if provided; auto-add `task` when the agent has `spawns` and depth allows; strip `task` past `subagent.maxNestedSpawnDepth`; ensure `irc` is present in explicit tool lists; expand `exec` to `eval` + `bash`; strip parent-owned `todo`.
14. The child must finish through the hidden `yield` tool; up to 3 reminder prompts, the last forcing `toolChoice = yield` when supported. `finalizeSubprocessOutput(...)` reconciles raw text, `yield` payloads, structured schemas, `report_finding` data, and abort states.
15. End-of-run lifecycle (keep-alive, in `runSubprocess`'s finalizer):
    - hard abort (caller signal / wall-clock / budget) → registry status `aborted`, session disposed: terminal;
    - isolated run → status `parked` without a reviver (workspace is merged + cleaned, so the session is not revivable; transcript stays readable via `history://`), then session disposed and detached;
    - everything else (success and failure alike) → status `idle` with the live session attached, and `AgentLifecycleManager.global().adopt(id, { idleTtlMs, revive })` arms the park timer. The reviver reopens the session JSONL (park closed the writer, so the single-writer lock is taken cleanly).
16. Lifecycle thereafter: `idle` agents are parked after `subagent.idleTtlMs`, which defaults to 5 minutes regardless of model or provider. Parking disposes the live session but retains the `AgentRef` and session file; messaging (`irc`), or opening the agent in the Agent Control Center, revives it back to `idle`. `"Main"` is never parked.

## Modes / Variants
- Execution mode
  - Background job: `async.enabled=true`; non-blocking spawns go through `AsyncJobManager`.
  - Sync inline: `async.enabled=false`, no job manager, or the item's agent declares `blocking: true` (per item: a mixed call runs both modes).
- Batch mode (`subagent.batch`, default on)
  - on: `{ context, tasks[] }`: one independent spawn per item, required `context` shared across the call's spawns, `agent`/`isolated` per item. Lifecycle, revival, and concurrency semantics match N parallel single calls.
  - off: single spawn per call; `tasks`/`context` are rejected and removed from the schema.
- Isolation mode (`subagent.isolation.mode`): `none`, `auto`, `apfs`, `btrfs`, `zfs`, `reflink`, `overlayfs`, `projfs`, `block-clone`, `rcopy` (legacy `worktree`, `fuse-overlay`, `fuse-projfs` accepted for back-compat); the PAL resolves the actual backend with fallback.
- Isolation merge strategy: patch mode (capture/apply root patches) or branch mode (commit to `veyyon/task/<id>`, cherry-pick into parent).
- Agent source precedence: project custom agents, then user custom agents, then bundled agents, which are `scout`, `designer`, `reviewer`, `librarian`, `deep`, `sonic` in that order. `task` was the old name for `deep` and still resolves through `RETIRED_AGENT_NAMES` (`packages/coding-agent/src/task/spawn-policy.ts`), so a settings row, a saved transcript, or an SDK caller still carrying it keeps working; the roster itself no longer holds that name.
- Which of those the model may pick is `subagent.agents` (the Subagents settings tab, or `/agents`). Only the general-purpose `deep` worker and agents you wrote yourself are offered by default; the bundled specialists are not, so their descriptions cost nothing until you enable one. There are two states and no third: a disabled agent is refused even when a caller names it outright. The one exception is a `/` command that declares the agent for its own turn (`CustomCommand.spawnsAgents` → `session.agentGrantedThisTurn`), which is how `/review` reaches `reviewer` without `reviewer` being enabled.
- The model each spawn runs comes from `resolveSubagentModel` (`packages/coding-agent/src/task/subagent-settings.ts`), highest layer first: `subagent.agents.<name>.model`, `subagent.model`, the agent definition's `model:`, otherwise the parent session's live model. A configured value that matches no available model refuses the spawn and names the setting, rather than falling through to the next layer.

## Side Effects
- Filesystem
  - Writes `<id>.jsonl` and `<id>.md` under the session artifacts dir or a temp task dir; isolated patch mode writes `<id>.patch`.
  - Creates/removes worktrees or overlay mount directories; branch mode creates temporary worktrees and task branches.
- Network
  - Child sessions may use whichever networked tools/models their active tool set permits.
  - MCP proxy tools can call existing parent MCP connections with a 60_000 ms timeout.
- Subprocesses / native bindings
  - Isolation backends run through the `veyyon-natives` PAL (`crates/veyyon-iso`): kernel `overlay` with `fuse-overlayfs`/`fusermount[3]` fallback on Linux, APFS/Btrfs/ZFS/reflink clones, ProjFS on Windows, recursive copy as last resort.
  - Git operations for baseline capture, patch apply, worktrees, branches, stash, cherry-pick, commits.
- Session state (transcript, memory, jobs, checkpoints, registries)
  - Creates child `AgentSession` instances with isolated settings snapshots; finished sessions stay registered in the process-global `AgentRegistry` as `idle`/`parked` until process teardown or explicit release.
  - With `async.enabled=true`, registers one async job per spawn in `session.asyncJobManager`; completion is injected into the parent as an async-result message.
  - Arms idle-TTL timers in `AgentLifecycleManager` (unref'd; they never hold the process open).
  - Emits `task:subagent:event`, `task:subagent:progress`, and `task:subagent:lifecycle` on the parent event bus.
  - Allocates session-scoped output ids through `AgentOutputManager` so `agent://` stays unique across invocations.
  - Shares the parent `local://` root and `ArtifactManager` with subagents.
- Background work / cancellation
  - `job cancel` (or parent tool-call abort) cancels background jobs; parent tool-call abort cancels sync runs through the call signal. A hard-aborted run lands `aborted` and is torn down.
  - Missing-`yield` recovery sends up to three internal reminder prompts to the child session.

## Limits & Caps
- Concurrency: one session-scoped `Semaphore` sized from `subagent.maxConcurrency` at first use (later setting changes do not resize it) bounds concurrent subagents across parallel `task` calls: both async job bodies and the sync fallback acquire it.
- Idle TTL: `subagent.idleTtlMs`, default 5 minutes. A positive millisecond value overrides it; `<= 0` disables parking and keeps idle sessions live until exit.
- Per-subagent output truncation: `MAX_OUTPUT_BYTES = 500_000` and `MAX_OUTPUT_LINES = 5000` in `packages/coding-agent/src/task/types.ts` (overridable via `VEYYON_TASK_MAX_OUTPUT_BYTES` / `VEYYON_TASK_MAX_OUTPUT_LINES`). Full raw output is still written to `<id>.md`.
- Progress coalescing: `PROGRESS_COALESCE_MS = 150`; recent-output tail: `RECENT_OUTPUT_TAIL_BYTES = 8 * 1024` (last 8 non-empty lines).
- Missing-`yield` reminder retries: `MAX_YIELD_RETRIES = 3`; MCP proxy timeout: `MCP_CALL_TIMEOUT_MS = 60_000`: both in `packages/coding-agent/src/task/executor.ts`.
- Name/label caps: the wire `name` has no schema length cap (prompt text suggests `≤32` chars: guidance only); one-line display text (roster line, registry `displayName`) is normalized by `oneLineLabel(...)` and capped at `LABEL_MAX = 80` chars in `packages/coding-agent/src/task/types.ts`.
- Soft request budget (`subagent.softRequestBudget`) and wall clock (`subagent.maxRuntimeMs`) apply to every spawn.
- Nested spawn depth gate: `subagent.maxNestedSpawnDepth`, or `subagent.agents.<name>.maxNestedSpawnDepth` for one agent. A session may spawn while its own depth is at or below the limit, so the default `0` still permits direct children and forbids grandchildren; `-1` removes the cap. `packages/coding-agent/src/tools/index.ts` hides the `task` tool once depth is past the limit, and `runSubprocess(...)` also strips child `task` access at max depth.
- Final inline summary preview uses `fullOutputThreshold = 5000` chars in `packages/coding-agent/src/task/index.ts`; `agent://<id>` points to the full artifact.

## Errors
- Parameter validation failures are returned as normal tool text with empty `results`:
  - `schema` (never accepted)
  - `tasks` / `context` while `subagent.batch` is disabled
  - batch calls: missing/empty `tasks`, an item without `task`, duplicate provided names, missing shared `context`, top-level `task` alongside `tasks`
  - flat calls: missing/empty `task`
  - unknown or settings-disabled agent type, spawn-policy denial, requesting `isolated` while isolation mode is `none`
- Isolated execution without a git repo returns `Isolated task execution requires a git repository. ...`; unavailable backends fall back through the PAL candidate list (reported via `fellBack`/`fallbackReason`), other backend errors rethrow, and exhausting every candidate errors with the fallback reason.
- Job registration failure returns `Failed to start background task job(s): ...`; a batch that schedules only some jobs reports the failed ids in the immediate text and keeps the started ones running.
- Child failures surface as `SingleResult.exitCode = 1` with `stderr`/`error` populated; the async job is marked failed but the delivery text still carries the output plus a follow-up/transcript hint.
- If the child omits `yield`, `finalizeSubprocessOutput(...)` injects warnings such as `SYSTEM WARNING: Subagent exited without calling yield tool after 3 reminders.`
- `agent://<id>` resolution errors are model-visible when another tool reads them: no session, no artifacts dir, missing id, conflicting extraction syntax, or invalid JSON for extraction.

## Notes
- Parallelism is parallel `task` calls in one assistant message: or, with `subagent.batch`, a `tasks[]` batch in one call; either way the session-scoped semaphore bounds the fan-out. With `async.enabled=true`, each spawn is an independent background job.
- Shared background convention without batch mode: write it once to a `local://` file and reference that path in each spawn's `task`: subagents share the parent's `local://` root. With `subagent.batch`, the required `context` parameter carries the shared background directly into each spawn's system prompt.
- Prefer messaging an existing agent (`irc`) over a fresh spawn for follow-up work: it already holds the relevant context. `irc` op:"list" shows idle/parked candidates; messaging a parked agent revives it. `history://<id>` shows what an agent has done.
- `irc` availability is derived, not configured (`isIrcEnabled` in `packages/coding-agent/src/tools/irc.ts`): it exists exactly when there is someone to message: the session can spawn subagents, or it is a subagent itself. Messaging is the only follow-up path to a finished subagent, so task without irc would strand idle agents.
- `tools.discoveryMode: all` hides non-essential built-ins, and `task` is a carve-out. At `subagent.delegation` `preferred` (the default) or `required` the prompt asks you to delegate, so `task` stays in the request; hiding it would leave an instruction you cannot follow. At `allowed` nothing asks for delegation, so `task` is hidden like any other discoverable built-in and you reach it through `search_tool_bm25`, and the prompt drops its delegation section to match. The decision is made in `sdk.ts` before agent discovery runs, from the strength alone: whether any agent is enabled is not knowable yet at that point.
- Only the general-purpose `deep` agent ships enabled. Every other bundled agent, `scout` included, needs a `subagent.agents.<name>.enabled = true` row before the model may choose it, and a spawn that names a disabled agent is refused with `Agent "<name>" is disabled`. A user-authored agent under `.veyyon/agents/` is on by default: writing the file is the opt-in.
- Subagents are internally synchronous: the executor forces `async.enabled = false` and `bash.autoBackground.enabled = false` in the child settings snapshot, so there are no fire-and-forget grandchildren.
- Agent discovery precedence is first-wins by exact name: project `.veyyon` agents dir before the user `.veyyon` dir (task agents only load from `.veyyon` roots; `.claude`/`.codex`/`.gemini` agent dirs are skipped), Claude plugin agent dirs after config dirs, bundled agents last. Create-time discovery is memoized per cwd for the prompt description; execution-time discovery stays fresh.
- Child sessions do not inherit conversation history. Built-in carry-over is the workspace tree/skills/context files, the shared `local://` root, and the approved-plan reference when one exists.
- When the parent passes `mcpManager`, child sessions disable standalone MCP discovery and get proxy tools that reuse parent connections.
- Branch-mode merge temporarily stashes the parent repo before cherry-picking; a stash-pop conflict does not unmerge the cherry-picked commits: they stay on HEAD, the stash entry is preserved, and the conflict is surfaced separately as `stashConflict`. Patch mode only applies the combined root patch when `git.patch.canApplyText(...)` succeeds; failures leave the `.patch` artifact for manual handling.
- Nested git repos are diffed independently inside isolated workspaces and merged separately with `applyNestedPatches(...)`.
- `agent://` ids are name-based (`Task` first, `Task-2`/`Task-3` only when the name repeats, nested like `Parent.Child`) by `AgentOutputManager`; this is what prevents artifact collisions across repeated or nested invocations.
