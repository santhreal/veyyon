/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with the veyyon coding agent)
 *   - ~/.veyyon/subagents/*.md (authored once, read by every profile)
 *   - agents/*.md shipped by an extension package or a marketplace plugin
 *
 * Supports:
 *   - Single agent spawn per call (parallelism = parallel task calls)
 *   - Batch spawning + shared context per call when `task.batch` is enabled
 *   - Background execution through AsyncJobManager when `async.enabled` is enabled
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */

import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { $env, prompt } from "@veyyon/utils";
import type { ToolSession } from "..";
import { toolsPrompts } from "../prompts/tools/rows";
import type { Theme } from "../theme/theme";
import { isIrcEnabled } from "../tools/agent/irc";
import { truncateForPrompt } from "../tools/core/approval";
import {
	agentsEnabled,
	type EnabledAgentCatalog,
	type EnabledAgentSource,
	isAgentEnabled,
	resolveEnabledAgents,
	resolveSessionMaxNestedSpawnDepth,
} from "./agent-settings";
import { homogeneousTriageRefusal, isHomogeneousTriageFanout } from "./delegation-policy";
import {
	type AgentDefinition,
	canSpawnAtDepth,
	getTaskSchema,
	type TaskItem,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";
// Import review tools for side effects (registers agent tool handlers)
import "../tools/agent/review";
import { TOOL } from "../tools/core/builtin-names";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { repairTaskParams } from "./repair-args";
import { appendAdvisory, composeSpawnAdvisory } from "./spawn-advisory";
import { type CallSpawn, type SpawnCall, SpawnScheduler } from "./spawn-scheduler";
import { taskToolView } from "./task-view";

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export { buildCoordinationAdvisory, buildSpecializationAdvisory, composeSpawnAdvisory } from "./spawn-advisory";
export { formatResultOutputFallback, resolveSpawnCwd } from "./spawn-run";
export type {
	AgentDefinition,
	AgentEventPayload,
	AgentLifecyclePayload,
	AgentProgress,
	AgentProgressPayload,
	SingleResult,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

// Built-in tools whose approval tier is "read" (see tool classes' `approval`).
// An agent is read-only iff its declared tools are a non-empty subset of this set.
// Fail-safe: any unknown tool makes the agent not read-only.
export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	TOOL.read,
	TOOL.search,
	TOOL.web_search,
	TOOL.yield,
	TOOL.irc,
	TOOL.ask,
	TOOL.job,
	TOOL.todo,
	TOOL.recall,
	TOOL.reflect,
	TOOL.retain,
	TOOL.memory_edit,
	TOOL.inspect_image,
	TOOL.checkpoint,
	TOOL.rewind,
	TOOL.resolve,
	TOOL.report_finding,
	TOOL.search_tool_bm25,
]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

/**
 * Render the tool description from a cached agent list and current settings.
 */
function renderDescription(
	catalog: EnabledAgentCatalog,
	isolationEnabled: boolean,
	batchEnabled: boolean,
	asyncEnabled: boolean,
	ircEnabled: boolean,
): string {
	const renderedAgents = catalog.agents.map(agent => ({
		name: agent.name,
		description: agent.description,
		readOnly: isReadOnlyAgent(agent),
		blocking: agent.blocking === true,
	}));
	return prompt.render(toolsPrompts["tools/task"].text, {
		agents: renderedAgents,
		spawningDisabled: renderedAgents.length === 0,
		defaultAgent: catalog.defaultAgent,
		hasDefaultAgent: catalog.defaultAgent !== undefined,
		allowedAgentsText:
			catalog.agents.length > 0 ? catalog.agents.map(agent => `\`${agent.name}\``).join(", ") : undefined,
		isolationEnabled,
		batchEnabled,
		asyncEnabled,
		hasBlockingAgents: renderedAgents.some(agent => agent.blocking),
		ircEnabled,
	});
}

function createTaskModeError(text: string, warning?: TaskToolDetails["warning"]): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		// This helper exists only for refusals (wrong mode, bad params, unknown
		// agent). Every one of them is a failure and must reach the wire as one.
		isError: true,
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0, warning },
	};
}

/**
 * Reject fields the current configuration does not accept. `schema` is never
 * accepted (structured output comes from the agent definition's `output`
 * frontmatter, the inherited session schema, or an eval-workflow
 * `agent(..., schema)` call); `tasks`/`context` require `task.batch`.
 */
function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
	if ((params as Record<string, unknown>).schema !== undefined) {
		return "The task tool does not accept `schema`. Rely on the selected agent definition's `output` schema or the inherited session schema; workflows needing ad-hoc structured output use eval `agent(prompt, schema)`.";
	}
	if (!batchEnabled) {
		const disallowed = (["tasks", "context"] as const).filter(field => params[field] !== undefined);
		if (disallowed.length > 0) {
			return `task.batch is disabled, so the task tool does not accept ${disallowed.map(f => `\`${f}\``).join(" or ")}. Spawn one agent per call with \`task\`, or enable the task.batch setting.`;
		}
	}
	return undefined;
}

/**
 * Validate the spawn parameter contract against the wire shapes. With
 * `task.batch` the model-facing shape is `{ context, tasks[] }` — `tasks`
 * non-empty with per-item `task` instructions and unique names, `context`
 * non-empty, no top-level `task` alongside. The flat `{ agent?, ...item }`
 * form stays accepted at runtime under either setting (internal callers, stale
 * transcripts). Missing `agent` values resolve against the session spawn
 * policy later, in `spawnParamsFor`. Returns a problem description, or
 * undefined when valid.
 */
function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const hasTask = typeof params.task === "string" && params.task.trim() !== "";
	if (batchEnabled && params.tasks !== undefined) return validateBatchParams(params, hasTask);
	if (hasTask) return undefined;
	return batchEnabled
		? "Missing `tasks`. Provide a `tasks` array (one spawned agent per item) with a shared `context`."
		: "Missing `task`. Provide complete, self-contained instructions for the spawned agent.";
}

/** The batch shape's problem: an empty `tasks`, a top-level `task` beside it, a bad item, or no `context`. */
function validateBatchParams(params: TaskParams, hasTask: boolean): string | undefined {
	const tasks = params.tasks;
	if (!Array.isArray(tasks) || tasks.length === 0) {
		return "Missing `tasks`. Provide at least one task item ({ name?, agent?, task }).";
	}
	if (hasTask) {
		return "Top-level `task` is not part of the batch shape. Put the work in `tasks[]` items.";
	}
	const itemProblem = batchItemProblem(tasks);
	if (itemProblem !== undefined) return itemProblem;
	if (typeof params.context !== "string" || params.context.trim() === "") {
		return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
	}
	return undefined;
}

/** The first item without instructions, else the first name another item already took (case-insensitive). */
function batchItemProblem(tasks: TaskItem[]): string | undefined {
	for (let i = 0; i < tasks.length; i++) {
		const item = tasks[i];
		if (!item || typeof item.task !== "string" || item.task.trim() === "") {
			return `Task ${i + 1}${item?.name ? ` (\`${item.name}\`)` : ""} is missing \`task\`. Every task needs complete, self-contained instructions.`;
		}
	}
	const seen = new Map<string, string>();
	for (const item of tasks) {
		const name = item.name?.trim();
		if (!name) continue;
		const key = name.toLowerCase();
		const existing = seen.get(key);
		if (existing !== undefined) {
			return `Duplicate task name ${existing === name ? `\`${name}\`` : `\`${existing}\` / \`${name}\``}. Provided names must be unique within a call (case-insensitive).`;
		}
		seen.set(key, name);
	}
	return undefined;
}

/** Approval lines for the flat call shape and the batch's shared `context`. */
function appendCallApprovalLines(lines: string[], params: Partial<TaskParams>): void {
	if (typeof params.agent === "string") {
		lines.push(`Agent: ${truncateForPrompt(params.agent)}`);
	}
	if (typeof params.name === "string" && params.name.trim()) {
		lines.push(`Name: ${truncateForPrompt(params.name)}`);
	}
	if (typeof params.task === "string") {
		lines.push(`Task:\n${truncateForPrompt(params.task)}`);
	}
	if (typeof params.context === "string" && params.context.trim()) {
		lines.push(`Context:\n${truncateForPrompt(params.context)}`);
	}
}

/** Approval lines for a batch: the first item in full and a count of the rest. */
function appendBatchApprovalLines(lines: string[], tasks: readonly Partial<TaskItem>[]): void {
	const firstTask = tasks[0];
	if (!firstTask) return;
	if (typeof firstTask.name === "string" && firstTask.name.trim()) {
		lines.push(`Name: ${truncateForPrompt(firstTask.name)}`);
	}
	if (typeof firstTask.agent === "string" && firstTask.agent.trim()) {
		lines.push(`Agent: ${truncateForPrompt(firstTask.agent)}`);
	}
	if (typeof firstTask.task === "string") {
		lines.push(`Task:\n${truncateForPrompt(firstTask.task)}`);
	}
	if (tasks.length > 1) {
		lines.push(`+${tasks.length - 1} more task${tasks.length === 2 ? "" : "s"}`);
	}
}

/**
 * Normalize a validated call into its spawn list: the `tasks[]` batch when
 * provided, otherwise the single top-level spawn. The flat form's `isolated`
 * flag is only materialized when the caller sent one — the spawn
 * distinguishes an absent key from an explicit value.
 */
function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = { name: params.name, agent: params.agent, task: params.task };
	if ("isolated" in params) item.isolated = params.isolated;
	if (params.cwd !== undefined) item.cwd = params.cwd;
	return [item];
}

/**
 * The agent one item of the call runs, or why the call is refused: no default agent, a spawn policy
 * that excludes it, an agent no discovery found, or one the settings disable and no `/` command granted
 * this turn.
 */
function resolveCallSpawn(
	session: ToolSession,
	item: TaskItem,
	discoveredAgents: AgentDefinition[],
	catalog: EnabledAgentCatalog,
): CallSpawn | string {
	const agentName = item.agent?.trim() || catalog.defaultAgent;
	if (!agentName) {
		return "No enabled default agent exists. Specify an enabled agent type explicitly or enable the configured default.";
	}
	const { spawnPolicy } = catalog;
	if (!spawnPolicy.enabled || (spawnPolicy.allowedAgents !== null && !spawnPolicy.allowedAgents.includes(agentName))) {
		return `Cannot spawn '${agentName}'. Allowed: ${spawnPolicy.allowedErrorText}`;
	}
	const discoveredAgent = getAgent(discoveredAgents, agentName);
	const available = catalog.agents.map(agent => agent.name).join(", ") || "none";
	if (!discoveredAgent) {
		return `Unknown agent "${agentName}". Available: ${available}`;
	}
	if (!isAgentEnabled(session.settings, discoveredAgent) && !session.agentGrantedThisTurn?.(agentName)) {
		return `Agent "${agentName}" is disabled (agent.agents.${agentName}.enabled is false), so it cannot be chosen. Enable it in the Agents settings tab (/settings), or use a different agent type.${available !== "none" ? ` Enabled: ${available}` : ""}`;
	}
	const agent = getAgent(catalog.agents, agentName);
	if (!agent) {
		return `Cannot spawn '${agentName}'. Enabled and allowed: ${available}`;
	}
	return { item, agentName, agent };
}

/** Every item's agent, in call order, or the refusal for the first item that cannot run. */
function resolveCallSpawns(
	session: ToolSession,
	items: TaskItem[],
	discoveredAgents: AgentDefinition[],
	catalog: EnabledAgentCatalog,
): CallSpawn[] | string {
	const spawns: CallSpawn[] = [];
	for (const item of items) {
		const spawn = resolveCallSpawn(session, item, discoveredAgents, catalog);
		if (typeof spawn === "string") return spawn;
		spawns.push(spawn);
	}
	return spawns;
}

/**
 * Process-level memo for create-time agent discovery, keyed by resolved cwd.
 *
 * `TaskTool.create` runs for every (sub)agent session in this process and the
 * walk-up + plugin-registry scan in `discoverAgents` is identical for a given
 * cwd, so repeat creations reuse the first scan. Execution-time discovery
 * (`runSpawn`) intentionally stays fresh. The memo also tracks the live
 * `discoverAgents` binding: test spies swap that binding, which invalidates
 * the memo automatically.
 */
const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
let discoveryMemoFn: typeof discoverAgents | undefined;

function discoverAgentsForCreate(cwd: string): Promise<DiscoveryResult> {
	const fn = discoverAgents;
	if (discoveryMemoFn !== fn) {
		discoveryMemoFn = fn;
		discoveryMemo.clear();
	}
	const key = path.resolve(cwd);
	let pending = discoveryMemo.get(key);
	if (!pending) {
		pending = fn(cwd);
		discoveryMemo.set(key, pending);
		pending.catch(() => {
			if (discoveryMemo.get(key) === pending) discoveryMemo.delete(key);
		});
	}
	return pending;
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool Class
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Each call spawns one agent — or, with `task.batch`, one per `tasks[]`
 * item. When `async.enabled` is on, spawns run as AsyncJobManager jobs; when
 * disabled, the tool blocks until every spawn finishes.
 */
export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme>, EnabledAgentSource {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
		appendCallApprovalLines(lines, params);
		appendBatchApprovalLines(lines, Array.isArray(params.tasks) ? params.tasks : []);
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn agents to complete delegated tasks";
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly view = taskToolView;
	// Suppress the streaming call preview once a (partial or final) result exists
	// so the task renders as ONE block that transitions in place — not a pending
	// call frame stacked above the result frame. Mirrors the `task` row in
	// `tools/renderers.ts`.
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;
	readonly #scheduler: SpawnScheduler;

	get parameters(): TaskToolSchemaInstance {
		const isolationEnabled = this.session.settings.get("agent.isolation.mode") !== "none";
		const catalog = this.#enabledAgents();
		return getTaskSchema({
			isolationEnabled,
			batchEnabled: this.#isBatchEnabled(),
			defaultAgent: catalog.defaultAgent,
			enabledAgentNames: catalog.agents.map(agent => agent.name),
		});
	}

	/**
	 * The agent types this session may actually spawn, in discovery order.
	 *
	 * The system prompt reads this so its delegation prose can name only agents
	 * that exist here: on a stock install the specialists are off, and a prompt
	 * telling the model to send research to a `scout` it cannot spawn is an
	 * instruction it can only fail to follow.
	 */
	get enabledAgentNames(): string[] {
		return this.#enabledAgents().agents.map(agent => agent.name);
	}

	/** Dynamic description listing exactly the agents this session may spawn. */
	get description(): string {
		const isolationMode = this.session.settings.get("agent.isolation.mode");
		return renderDescription(
			this.#enabledAgents(),
			isolationMode !== "none",
			this.#isBatchEnabled(),
			this.session.settings.get("async.enabled"),
			isIrcEnabled(this.session.settings, this.session.taskDepth ?? 0, this.session.maxNestedSpawnDepth),
		);
	}
	private constructor(
		private readonly session: ToolSession,
		discoveredAgents: AgentDefinition[],
	) {
		this.#blockedAgent = $env.VEYYON_BLOCKED_AGENT;
		this.#discoveredAgents = discoveredAgents;
		this.#scheduler = new SpawnScheduler(session);
	}

	#enabledAgents(
		agents: readonly AgentDefinition[] = this.#discoveredAgents,
		includeTurnGrants = false,
	): EnabledAgentCatalog {
		return resolveEnabledAgents({
			settings: this.session.settings,
			agents,
			parentSpawns: this.session.getSessionSpawns() ?? "*",
			isGranted: includeTurnGrants ? name => this.session.agentGrantedThisTurn?.(name) === true : undefined,
		});
	}

	#isBatchEnabled(): boolean {
		return this.session.settings.get("agent.batch");
	}

	/**
	 * Create a TaskTool instance with async agent discovery.
	 */
	static async create(session: ToolSession): Promise<TaskTool> {
		const { agents } = await discoverAgentsForCreate(session.cwd);
		return new TaskTool(session, agents);
	}

	async execute(
		toolCallId: string,
		rawParams: unknown,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		const params = repairTaskParams(rawParams as TaskParams);
		const batchEnabled = this.#isBatchEnabled();
		const validationError = validateShapeParams(batchEnabled, params) ?? validateSpawnParams(params, batchEnabled);
		if (validationError) {
			return createTaskModeError(validationError);
		}

		const { agents: discoveredAgents } = await discoverAgents(this.session.cwd);
		const catalog = this.#enabledAgents(discoveredAgents, true);
		if (!agentsEnabled(this.session.settings)) {
			return createTaskModeError("Agents are disabled in settings.");
		}
		const spawnItems = resolveSpawnItems(params);
		const spawns = resolveCallSpawns(this.session, spawnItems, discoveredAgents, catalog);
		if (typeof spawns === "string") {
			return createTaskModeError(spawns);
		}
		const blockedAgent = this.#blockedAgent;
		if (blockedAgent && spawns.some(spawn => spawn.agentName === blockedAgent)) {
			return createTaskModeError(
				`Cannot spawn ${blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
			);
		}
		if (isHomogeneousTriageFanout(spawnItems)) {
			const text = homogeneousTriageRefusal(spawnItems.length);
			return createTaskModeError(text, { kind: "homogeneous-triage", message: text });
		}
		// Execution mode is per item: an item whose agent type declares
		// `blocking: true` runs inline on this turn (the parent waits on its
		// result); every other item becomes a background job when async
		// execution is available.
		const asyncEnabled = this.session.settings.get("async.enabled");
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		const detachable = spawns.filter(spawn => spawn.agent.blocking !== true);
		if (asyncEnabled && !manager && detachable.length > 0) {
			return createTaskModeError(
				"Async task execution is enabled, but no AsyncJobManager is available. Disable async execution to run synchronously, or provide an AsyncJobManager.",
			);
		}
		const asyncItems = manager ? detachable.map(spawn => spawn.item) : [];
		const ircEnabled = isIrcEnabled(
			this.session.settings,
			this.session.taskDepth ?? 0,
			this.session.maxNestedSpawnDepth,
		);
		const advisory = this.#spawnAdvisory(spawns, catalog, asyncItems, ircEnabled);
		const call: SpawnCall = { toolCallId, params, defaultAgent: catalog.defaultAgent ?? "", signal, onUpdate };
		if (!manager || asyncItems.length === 0) {
			// Synchronous execution was explicitly selected, or every item's
			// agent type declares `blocking: true`. The spawn semaphore still
			// bounds fan-out across parallel task calls.
			return appendAdvisory(await this.#scheduler.runInline(call, spawnItems), advisory);
		}
		return this.#scheduler.runInBackground(call, spawns, { manager, ircEnabled, advisory });
	}

	/** The advisory appended to the call's result, or undefined when none applies or the session suppresses it. */
	#spawnAdvisory(
		spawns: CallSpawn[],
		catalog: EnabledAgentCatalog,
		asyncItems: TaskItem[],
		ircEnabled: boolean,
	): string | undefined {
		if (this.session.suppressSpawnAdvisory) return undefined;
		const maxDepth = resolveSessionMaxNestedSpawnDepth(this.session.settings, this.session.maxNestedSpawnDepth);
		return composeSpawnAdvisory({
			agents: spawns.map(spawn => spawn.agentName),
			enabledAgentNames: catalog.agents.map(agent => agent.name),
			items: asyncItems,
			depthCapacity: canSpawnAtDepth(maxDepth, this.session.taskDepth ?? 0),
			ircEnabled,
			// Coordination makes sense only for spawns that keep running after
			// this call returns. Blocking items have completed by then, so a
			// "coordinate while they run" hint would misfire.
			willRunAsync: asyncItems.length > 0,
		});
	}
}
