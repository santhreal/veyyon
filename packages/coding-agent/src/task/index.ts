import * as fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import type { Usage } from "@veyyon/ai";
import { emptyCost, emptyUsage } from "@veyyon/catalog/models";
import {
	$env,
	directoryExists,
	errorMessage,
	formatCount,
	getSessionsDir,
	pluralize,
	prompt,
	Snowflake,
} from "@veyyon/utils";
import { sessionFileName } from "@veyyon/utils/session-file";
import type { ToolSession } from "..";
import { mcpManagerInstance } from "../mcp/manager-instance";
import type { Theme } from "../modes/theme/theme";
import { DEFAULT_PLAN_FILE_URL } from "../plan-mode/plan-file-url";
import { planModePrompts } from "../prompts/plan-mode/rows";
import { subagentPrompts } from "../prompts/subagent/rows";
import { toolsPrompts } from "../prompts/tools/rows";
import { truncateForPrompt } from "../tools/approval";
import { isIrcEnabled } from "../tools/irc";
import { formatBytes, formatDuration } from "../tools/render-utils";
import { inheritContextFiles } from "./context-inheritance";
import { homogeneousTriageRefusal, isHomogeneousTriageFanout } from "./delegation-policy";
import { inheritResolvedCollection, resolveAutoloadSkills } from "./inherited-collections";
import { classifySubagentOutcome, describeSubagentBatch, summarizeSubagentBatch } from "./outcome";
import {
	type EnabledSubagentCatalog,
	type EnabledSubagentSource,
	filterEnabledAgents,
	isSubagentEnabled,
	resolveEnabledSubagents,
	resolveSessionMaxNestedSpawnDepth,
	resolveSubagentModel,
	resolveSubagentThinkingLevel,
	subagentModelSourceLabel,
	subagentsEnabled,
} from "./subagent-settings";
import {
	type AgentDefinition,
	type AgentProgress,
	canSpawnAtDepth,
	getTaskSchema,
	type SingleResult,
	type TaskItem,
	type TaskParams,
	type TaskToolDetails,
	type TaskToolSchemaInstance,
} from "./types";
import "../tools/review";
import type { AsyncJobManager } from "../async";
import type { LocalProtocolOptions } from "../internal-urls";
import { loadOverallPlanReference } from "../plan-mode/plan-handoff";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { TOOL } from "../tools/builtin-names";
import { type DiscoveryResult, discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import {
	applyEligibleNestedPatches,
	type IsolationContext,
	makeIsolationCommitMessage,
	mergeIsolatedChanges,
	prepareIsolationContext,
	runIsolatedSubprocess,
} from "./isolation-runner";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { mapWithConcurrencyLimit, Semaphore } from "./parallel";
import { renderResult, renderCall as renderTaskCall } from "./render";
import { repairTaskParams } from "./repair-args";
import { treeSpawnSemaphore } from "./spawn-semaphore";
import { parseIsolationMode } from "./worktree";

function renderSubagentUserPrompt(assignment: string): string {
	return prompt.render(subagentPrompts["subagent/user-prompt"].text, {
		assignment: assignment.trim(),
	});
}

function createUsageTotals(): Usage {
	return emptyUsage();
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost = usage.cost ?? emptyCost();

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
}

export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export { AgentOutputManager } from "./output-manager";
export type {
	AgentDefinition,
	AgentProgress,
	SingleResult,
	SubagentEventPayload,
	SubagentLifecyclePayload,
	SubagentProgressPayload,
	TaskParams,
	TaskToolDetails,
} from "./types";
export {
	TASK_SUBAGENT_EVENT_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	taskSchema,
} from "./types";

export const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([
	TOOL.read,
	TOOL.grep,
	TOOL.glob,
	TOOL.web_search,
	TOOL.ast_grep,
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

const PLAN_MODE_AGENT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([TOOL.ast_grep, TOOL.report_finding]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

function renderDescription(
	catalog: EnabledSubagentCatalog,
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
		isError: true,
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0, warning },
	};
}

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

function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
	const hasTask = typeof params.task === "string" && params.task.trim() !== "";
	const tasks = params.tasks;
	if (batchEnabled && tasks !== undefined) {
		if (!Array.isArray(tasks) || tasks.length === 0) {
			return "Missing `tasks`. Provide at least one task item ({ name?, agent?, task }).";
		}
		if (hasTask) {
			return "Top-level `task` is not part of the batch shape. Put the work in `tasks[]` items.";
		}
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
		if (typeof params.context !== "string" || params.context.trim() === "") {
			return "Missing `context`. Provide the shared background for this batch — goal, constraints, and any contract the tasks share.";
		}
		return undefined;
	}
	if (!hasTask) {
		return batchEnabled
			? "Missing `tasks`. Provide a `tasks` array (one subagent per item) with a shared `context`."
			: "Missing `task`. Provide complete, self-contained instructions for the agent.";
	}
	return undefined;
}

export async function resolveSpawnCwd(raw: string | undefined, parentCwd: string): Promise<string> {
	const trimmed = typeof raw === "string" ? raw.trim() : "";
	if (!trimmed || trimmed === "inherit") {
		return parentCwd;
	}
	const resolved = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(parentCwd, trimmed);
	try {
		const st = await fs.stat(resolved);
		if (!st.isDirectory()) {
			throw new Error(`task cwd is not a directory: ${resolved}`);
		}
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("task cwd")) throw err;
		const context = path.isAbsolute(trimmed) ? "" : ` (resolved from relative "${trimmed}" against ${parentCwd})`;
		throw new Error(`task cwd does not exist: ${resolved}${context}`);
	}
	if (!(await directoryExists(resolved))) {
		throw new Error(`task cwd does not exist: ${resolved}`);
	}
	return resolved;
}

function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = { name: params.name, agent: params.agent, task: params.task };
	if ("isolated" in params) item.isolated = params.isolated;
	if (params.cwd !== undefined) item.cwd = params.cwd;
	return [item];
}

function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
	const spawn: TaskParams = { agent: item.agent?.trim() || defaultAgent };
	if (item.name !== undefined) spawn.name = item.name;
	if (item.task !== undefined) spawn.task = item.task;
	if (params.context !== undefined) spawn.context = params.context;
	if (item.isolated !== undefined) {
		spawn.isolated = item.isolated;
	} else if ("isolated" in params) {
		spawn.isolated = params.isolated;
	}
	if (item.cwd !== undefined) {
		spawn.cwd = item.cwd;
	} else if (params.cwd !== undefined) {
		spawn.cwd = params.cwd;
	}
	return spawn;
}

interface SyncSpawnRef {
	item: TaskItem;
	index: number;
	preAllocatedId?: string;
}

interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
	cancelledBeforeStart: number;
}

function mergeSyncPayloads(
	spawns: SyncSpawnRef[],
	payloads: (AgentToolResult<TaskToolDetails> | undefined)[],
): MergedSyncPayloads {
	const results: SingleResult[] = [];
	const contentParts: string[] = [];
	const outputPaths: string[] = [];
	const usageTotals = createUsageTotals();
	let hasUsage = false;
	let cancelledBeforeStart = 0;
	let projectAgentsDir: string | null = null;
	for (let position = 0; position < spawns.length; position++) {
		const payload = payloads[position];
		const { item, index } = spawns[position];
		if (!payload) {
			cancelledBeforeStart++;
			contentParts.push(`Task ${item.name?.trim() || `#${index + 1}`}: cancelled before start.`);
			continue;
		}
		projectAgentsDir ??= payload.details?.projectAgentsDir ?? null;
		const text = payload.content.find(part => part.type === "text")?.text;
		if (text) contentParts.push(text);
		for (const result of payload.details?.results ?? []) {
			results.push({ ...result, index });
			if (result.usage) {
				addUsageTotals(usageTotals, result.usage);
				hasUsage = true;
			}
			if (result.outputPath) outputPaths.push(result.outputPath);
		}
	}
	return {
		contentParts,
		results,
		usage: hasUsage ? usageTotals : undefined,
		outputPaths: outputPaths.length > 0 ? outputPaths : undefined,
		projectAgentsDir,
		cancelledBeforeStart,
	};
}

const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["deep", "sonic"]); // not-a-tool-name: agent ids

export function buildSpecializationAdvisory(
	agentNames: string[],
	depthCapacity: boolean,
	enabledAgentNames: readonly string[],
): string | undefined {
	if (!depthCapacity) return undefined;
	const generics = agentNames.filter(name => GENERIC_SPAWN_AGENTS.has(name));
	if (generics.length < 2) return undefined;
	const specialists = enabledAgentNames.filter(name => !GENERIC_SPAWN_AGENTS.has(name));
	if (specialists.length === 0) return undefined;
	return (
		`Tip: this call spawned ${generics.length} generic \`${generics[0]}\` workers. ` +
		`Enabled specialist types may fit better: ${specialists.map(name => `\`${name}\``).join(", ")}.`
	);
}

export function buildCoordinationAdvisory(
	items: TaskItem[],
	depthCapacity: boolean,
	ircEnabled: boolean,
): string | undefined {
	if (!depthCapacity || !ircEnabled || items.length < 2) return undefined;
	return (
		`Coordinate: ${items.length} siblings are running together. If their work overlaps, have them ` +
		`message each other via \`irc\` (by id, or "all" to broadcast) before editing shared files — ` +
		`live coordination beats a serial handoff. Check \`irc\` op:"list" to see who is doing what.`
	);
}

export function composeSpawnAdvisory(args: {
	agents: string[];
	enabledAgentNames: readonly string[];
	items: TaskItem[];
	depthCapacity: boolean;
	ircEnabled: boolean;
	willRunAsync: boolean;
}): string | undefined {
	return (
		[
			buildSpecializationAdvisory(args.agents, args.depthCapacity, args.enabledAgentNames),
			args.willRunAsync ? buildCoordinationAdvisory(args.items, args.depthCapacity, args.ircEnabled) : undefined,
		]
			.filter(Boolean)
			.join("\n\n") || undefined
	);
}

class TaskJobError extends Error {}

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

export class TaskTool implements AgentTool<TaskToolSchemaInstance, TaskToolDetails, Theme>, EnabledSubagentSource {
	readonly name = "task";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<TaskParams>;
		const lines: string[] = [];
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
		const tasks = Array.isArray(params.tasks) ? params.tasks : [];
		const firstTask = tasks[0];
		if (firstTask) {
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
		return lines;
	};
	readonly label = "Task";
	readonly summary = "Spawn subagents to complete delegated tasks";
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly renderResult = renderResult;
	readonly mergeCallAndResult = true;
	readonly #discoveredAgents: AgentDefinition[];
	readonly #blockedAgent: string | undefined;
	#spawnSemaphore: Semaphore | undefined;

	get parameters(): TaskToolSchemaInstance {
		const isolationEnabled = this.session.settings.get("subagent.isolation.mode") !== "none";
		const catalog = this.#enabledSubagents();
		return getTaskSchema({
			isolationEnabled,
			batchEnabled: this.#isBatchEnabled(),
			defaultAgent: catalog.defaultAgent,
			enabledAgentNames: catalog.agents.map(agent => agent.name),
		});
	}

	renderCall(args: unknown, options: Parameters<typeof renderTaskCall>[1], theme: Theme) {
		return renderTaskCall(repairTaskParams(args as TaskParams), options, theme);
	}

	get enabledAgentNames(): string[] {
		return this.#enabledSubagents().agents.map(agent => agent.name);
	}

	get description(): string {
		const isolationMode = this.session.settings.get("subagent.isolation.mode");
		return renderDescription(
			this.#enabledSubagents(),
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
	}

	#enabledSubagents(
		agents: readonly AgentDefinition[] = this.#discoveredAgents,
		includeTurnGrants = false,
	): EnabledSubagentCatalog {
		return resolveEnabledSubagents({
			settings: this.session.settings,
			agents,
			parentSpawns: this.session.getSessionSpawns() ?? "*",
			isGranted: includeTurnGrants ? name => this.session.agentGrantedThisTurn?.(name) === true : undefined,
		});
	}

	#isBatchEnabled(): boolean {
		return this.session.settings.get("subagent.batch");
	}

	#getSpawnSemaphore(): Semaphore {
		const max = this.session.settings.get("subagent.maxConcurrency");
		const shared = treeSpawnSemaphore(this.session.getSessionId?.() ?? null, max);
		if (shared) return shared;
		if (this.#spawnSemaphore) {
			this.#spawnSemaphore.resize(max);
		} else {
			this.#spawnSemaphore = new Semaphore(max);
		}
		return this.#spawnSemaphore;
	}

	#releaseSpawnSemaphore(): void {
		this.#getSpawnSemaphore().release();
	}

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
		const catalog = this.#enabledSubagents(discoveredAgents, true);
		if (!subagentsEnabled(this.session.settings)) {
			return createTaskModeError("Subagents are disabled in settings.");
		}
		const spawnItems = resolveSpawnItems(params);
		const resolvedAgents: string[] = [];
		const effectiveAgents: AgentDefinition[] = [];
		for (const item of spawnItems) {
			const agentName = item.agent?.trim() || catalog.defaultAgent;
			if (!agentName) {
				return createTaskModeError(
					"No enabled default agent exists. Specify an enabled agent type explicitly or enable the configured default.",
				);
			}
			if (
				!catalog.spawnPolicy.enabled ||
				(catalog.spawnPolicy.allowedAgents !== null && !catalog.spawnPolicy.allowedAgents.includes(agentName))
			) {
				return createTaskModeError(`Cannot spawn '${agentName}'. Allowed: ${catalog.spawnPolicy.allowedErrorText}`);
			}
			const discoveredAgent = getAgent(discoveredAgents, agentName);
			const available = catalog.agents.map(agent => agent.name).join(", ") || "none";
			if (!discoveredAgent) {
				return createTaskModeError(`Unknown agent "${agentName}". Available: ${available}`);
			}
			if (
				!isSubagentEnabled(this.session.settings, discoveredAgent) &&
				!this.session.agentGrantedThisTurn?.(agentName)
			) {
				return createTaskModeError(
					`Agent "${agentName}" is disabled (subagent.agents.${agentName}.enabled is false), so it cannot be chosen. Enable it in the Subagents settings tab (/settings), or use a different agent type.${available !== "none" ? ` Enabled: ${available}` : ""}`,
				);
			}
			const effectiveAgent = getAgent(catalog.agents, agentName);
			if (!effectiveAgent) {
				return createTaskModeError(`Cannot spawn '${agentName}'. Enabled and allowed: ${available}`);
			}
			resolvedAgents.push(agentName);
			effectiveAgents.push(effectiveAgent);
		}
		const defaultAgent = catalog.defaultAgent ?? "";
		const blockedAgent = resolvedAgents.find(name => this.#blockedAgent && name === this.#blockedAgent);
		if (blockedAgent) {
			return createTaskModeError(
				`Cannot spawn ${blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
			);
		}
		if (isHomogeneousTriageFanout(spawnItems)) {
			const text = homogeneousTriageRefusal(spawnItems.length);
			return createTaskModeError(text, { kind: "homogeneous-triage", message: text });
		}
		const itemBlocking = effectiveAgents.map(agent => agent.blocking === true);
		const asyncEnabled = this.session.settings.get("async.enabled");
		const manager = asyncEnabled ? this.session.asyncJobManager : undefined;
		if (asyncEnabled && !manager && itemBlocking.some(blocking => !blocking)) {
			return createTaskModeError(
				"Async task execution is enabled, but no AsyncJobManager is available. Disable async execution to run synchronously, or provide an AsyncJobManager.",
			);
		}
		const asyncItems = manager ? spawnItems.filter((_, index) => !itemBlocking[index]) : [];
		const depthCapacity = canSpawnAtDepth(
			resolveSessionMaxNestedSpawnDepth(this.session.settings, this.session.maxNestedSpawnDepth),
			this.session.taskDepth ?? 0,
		);
		const ircEnabled = isIrcEnabled(
			this.session.settings,
			this.session.taskDepth ?? 0,
			this.session.maxNestedSpawnDepth,
		);
		const willRunAsync = asyncItems.length > 0;
		const advisory = this.session.suppressSpawnAdvisory
			? undefined
			: composeSpawnAdvisory({
					agents: resolvedAgents,
					enabledAgentNames: catalog.agents.map(agent => agent.name),
					items: asyncItems,
					depthCapacity,
					ircEnabled,
					willRunAsync,
				});
		const withAdvisory = (result: AgentToolResult<TaskToolDetails>): AgentToolResult<TaskToolDetails> => {
			if (!advisory) return result;
			let appended = false;
			const content = result.content.map(part => {
				if (!appended && part.type === "text" && typeof part.text === "string") {
					appended = true;
					return { ...part, text: `${part.text}\n\n${advisory}` };
				}
				return part;
			});
			if (!appended) content.push({ type: "text", text: advisory });
			return { ...result, content };
		};
		if (!manager || asyncItems.length === 0) {
			return withAdvisory(
				await this.#executeSyncFanout(toolCallId, params, spawnItems, defaultAgent, signal, onUpdate),
			);
		}

		const outputManager =
			this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
		const callStartedAt = Date.now();
		const spawns: Array<{
			agentId: string;
			item: TaskItem;
			index: number;
			blocking: boolean;
			progress: AgentProgress;
		}> = [];
		for (let index = 0; index < spawnItems.length; index++) {
			const item = spawnItems[index];
			const agentType = resolvedAgents[index];
			const agentSource = effectiveAgents[index]?.source ?? "bundled";
			const agentId = await outputManager.allocate(item.name?.trim() || generateTaskName());
			const assignment = (item.task ?? "").trim();
			spawns.push({
				agentId,
				item,
				index,
				blocking: itemBlocking[index],
				progress: {
					index,
					id: agentId,
					agent: agentType,
					agentSource,
					status: "pending",
					task: renderSubagentUserPrompt(assignment),
					assignment,
					recentTools: [],
					recentOutput: [],
					toolCount: 0,
					requests: 0,
					tokens: 0,
					cost: 0,
					durationMs: 0,
				},
			});
		}
		const asyncSpawns = spawns.filter(spawn => !spawn.blocking);
		const syncSpawns = spawns.filter(spawn => spawn.blocking);
		const agentLabel = Array.from(new Set(asyncSpawns.map(spawn => spawn.progress.agent))).join(", ");

		let settledCount = 0;
		let failedCount = 0;
		let primaryJobId = asyncSpawns[0].agentId;
		const syncResults: SingleResult[] = [];
		let syncUsage: Usage | undefined;
		let syncOutputPaths: string[] | undefined;
		let syncProjectAgentsDir: string | null = null;
		const buildAsyncDetails = (): TaskToolDetails => ({
			projectAgentsDir: syncProjectAgentsDir,
			results: syncResults.slice(),
			totalDurationMs: Date.now() - callStartedAt,
			usage: syncUsage,
			outputPaths: syncOutputPaths,
			progress: spawns.map(spawn => ({ ...spawn.progress })),
			async: {
				state: settledCount < asyncSpawns.length ? "running" : failedCount > 0 ? "failed" : "completed",
				jobId: primaryJobId,
				type: "task", // not-a-tool-name: async job kind
			},
		});

		const started: Array<{ agentId: string; jobId: string }> = [];
		const failedSchedules: string[] = [];
		for (const spawn of asyncSpawns) {
			try {
				const jobId = this.#registerSpawnJob({
					manager,
					toolCallId,
					spawnParams: spawnParamsFor(params, spawn.item, defaultAgent),
					agentId: spawn.agentId,
					progress: spawn.progress,
					ircEnabled,
					buildDetails: buildAsyncDetails,
					onUpdate,
					onSettled: failed => {
						settledCount += 1;
						if (failed) failedCount += 1;
					},
				});
				if (started.length === 0) primaryJobId = jobId;
				started.push({ agentId: spawn.agentId, jobId });
			} catch (error) {
				const message = errorMessage(error);
				failedSchedules.push(`${spawn.agentId}: ${message}`);
				spawn.progress.status = "failed";
				settledCount += 1;
				failedCount += 1;
			}
		}

		if (started.length === 0 && syncSpawns.length === 0) {
			return {
				content: [
					{
						type: "text",
						text: `Failed to start background task ${pluralize("job", failedSchedules.length)}: ${failedSchedules.join("; ")}`, // not-a-tool-name: the English word
					},
				],
				isError: true,
				details: { projectAgentsDir: null, results: [], totalDurationMs: 0 },
			};
		}

		const scheduleFailureSummary =
			failedSchedules.length > 0
				? ` Failed to schedule ${formatCount("spawn", failedSchedules.length)}: ${failedSchedules.join("; ")}.`
				: "";
		const coordinationHint =
			started.length === 1
				? ircEnabled
					? `DM \`${started[0].agentId}\` via \`irc\` to coordinate while it runs; use \`job\` only to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`
					: `Use \`job\` to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`
				: ircEnabled
					? `DM these ids via \`irc\` to coordinate while they run; use \`job\` only to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task.`
					: `Use \`job\` to inspect (\`list\`), wait (\`poll\`), or cancel a stuck task by id.`;

		if (syncSpawns.length === 0) {
			if (spawns.length === 1) {
				const { agentId, jobId } = started[0];
				onUpdate?.({
					content: [{ type: "text", text: `Spawned agent \`${agentId}\`...` }],
					details: buildAsyncDetails(),
				});
				return withAdvisory({
					content: [
						{
							type: "text",
							text: `Spawned agent \`${agentId}\` (job \`${jobId}\`). The result will be delivered when it yields. ${coordinationHint}`,
						},
					],
					details: buildAsyncDetails(),
				});
			}
			const startedListing = started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n");
			onUpdate?.({
				content: [{ type: "text", text: `Spawned ${started.length} agents...` }],
				details: buildAsyncDetails(),
			});
			return withAdvisory({
				content: [
					{
						type: "text",
						text: `Spawned ${started.length} background agents using ${agentLabel}.${scheduleFailureSummary} Each result will be delivered when that agent yields.\n${startedListing}\n${coordinationHint}`,
					},
				],
				isError: failedSchedules.length > 0,
				details: buildAsyncDetails(),
			});
		}

		const syncLabel = syncSpawns.map(spawn => `\`${spawn.agentId}\``).join(", ");
		onUpdate?.({
			content: [
				{
					type: "text",
					text: `Running ${syncLabel} inline; ${formatCount("background agent", started.length)} spawned...`,
				},
			],
			details: buildAsyncDetails(),
		});
		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns: syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index, preAllocatedId: spawn.agentId })),
			onItemProgress: onUpdate
				? (index, progress) => {
						const spawn = spawns[index];
						if (spawn) spawn.progress = { ...progress, index };
						onUpdate({
							content: [{ type: "text", text: `Running ${syncLabel} inline...` }],
							details: buildAsyncDetails(),
						});
					}
				: undefined,
		});
		const merged = mergeSyncPayloads(
			syncSpawns.map(spawn => ({ item: spawn.item, index: spawn.index })),
			payloads,
		);
		for (let ri = 0; ri < merged.results.length; ri++) syncResults.push(merged.results[ri]!);
		syncUsage = merged.usage;
		syncOutputPaths = merged.outputPaths;
		syncProjectAgentsDir = merged.projectAgentsDir;
		for (let position = 0; position < syncSpawns.length; position++) {
			const spawn = syncSpawns[position];
			const result = merged.results.find(r => r.id === spawn.agentId);
			if (result) {
				const outcome = classifySubagentOutcome(result);
				spawn.progress.status = outcome.kind === "aborted" ? "aborted" : outcome.isError ? "failed" : "completed";
				spawn.progress.durationMs = result.durationMs;
			} else {
				spawn.progress.status = payloads[position] ? "failed" : "aborted";
			}
		}

		const spawnedSummary =
			started.length > 0
				? `Spawned ${formatCount("background agent", started.length)}.${scheduleFailureSummary} Each result will be delivered when that agent yields.\n${started.map(({ agentId, jobId }) => `- \`${agentId}\` (job \`${jobId}\`)`).join("\n")}\n${coordinationHint}`
				: scheduleFailureSummary.trim();
		const syncSummary = summarizeSubagentBatch(syncResults);
		syncSummary.cancelled += merged.cancelledBeforeStart;
		const syncHeadline = describeSubagentBatch(syncSummary);
		const text = [syncHeadline ?? "", merged.contentParts.join("\n\n"), spawnedSummary]
			.filter(section => section.trim().length > 0)
			.join("\n\n");
		return withAdvisory({
			content: [{ type: "text", text: text.length > 0 ? text : "No results." }],
			isError: failedSchedules.length > 0 || syncSummary.isError,
			details: buildAsyncDetails(),
		});
	}

	#registerSpawnJob(options: {
		manager: AsyncJobManager;
		toolCallId: string;
		spawnParams: TaskParams;
		agentId: string;
		progress: AgentProgress;
		ircEnabled: boolean;
		buildDetails: () => TaskToolDetails;
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>;
		onSettled?: (failed: boolean) => void;
	}): string {
		const { manager, toolCallId, spawnParams, agentId, progress, ircEnabled, buildDetails, onUpdate, onSettled } =
			options;
		const buildFollowUpHint = (aborted: boolean): string => {
			if (aborted) {
				const status = AgentRegistry.global().get(agentId)?.status;
				if (status === "idle" || status === "parked") {
					const followUp = ircEnabled ? "message it via `irc` to resume; " : "";
					return `\n\n${agentId} was stopped but is still resumable — ${followUp}transcript at history://${agentId}`;
				}
				return `\n\n${agentId} was aborted — transcript at history://${agentId}`;
			}
			const followUp = ircEnabled ? "message it via `irc` to follow up; " : "";
			return `\n\n${agentId} is now idle — ${followUp}transcript at history://${agentId}`;
		};
		return manager.register(
			"task", // not-a-tool-name: async job kind
			agentId,
			async ({ signal: runSignal, reportProgress, markRunning }) => {
				const startedAt = Date.now();
				const semaphore = this.#getSpawnSemaphore();
				let semaphoreHeld = false;
				const releasePermit = () => {
					if (!semaphoreHeld) return;
					semaphoreHeld = false;
					this.#releaseSpawnSemaphore();
				};
				try {
					await semaphore.acquire(runSignal);
					semaphoreHeld = true;
				} catch {}
				const acquiredAt = Date.now();
				if (!semaphoreHeld || runSignal.aborted) {
					releasePermit();
					progress.status = "aborted";
					onSettled?.(true);
					throw new Error("Aborted before execution");
				}
				try {
					markRunning();
					progress.status = "running";
					await reportProgress(`Running background task ${agentId}...`);
					const result = await this.#executeSync(
						toolCallId,
						spawnParams,
						runSignal,
						undefined,
						agentId,
						progress.index,
						true,
						{ invokedAt: startedAt, acquiredAt },
					);
					const finalText = result.content.find(part => part.type === "text")?.text ?? "(no output)";
					const singleResult = result.details?.results[0];
					const outcome = singleResult ? classifySubagentOutcome(singleResult) : undefined;
					const resultFailed = outcome ? outcome.isError : true;
					progress.status = !outcome
						? "failed"
						: outcome.kind === "aborted"
							? "aborted"
							: resultFailed
								? "failed"
								: "completed";
					progress.durationMs = singleResult?.durationMs ?? Math.max(0, Date.now() - startedAt);
					progress.tokens = singleResult?.tokens ?? 0;
					progress.requests = singleResult?.requests ?? 0;
					progress.contextTokens = singleResult?.contextTokens;
					progress.contextWindow = singleResult?.contextWindow;
					progress.cost = singleResult?.usage?.cost.total ?? 0;
					progress.extractedToolData = singleResult?.extractedToolData;
					progress.retryFailure = singleResult?.retryFailure;
					progress.retryState = undefined;
					onSettled?.(resultFailed);
					const statusText = resultFailed
						? `Background task ${agentId} failed.`
						: `Background task ${agentId} complete.`;
					await reportProgress(statusText);
					const deliveryText = `${finalText}${buildFollowUpHint(singleResult?.aborted === true)}`;
					if (resultFailed) {
						throw new TaskJobError(deliveryText);
					}
					return deliveryText;
				} catch (error) {
					if (error instanceof TaskJobError) {
						throw error;
					}
					progress.status = "failed";
					progress.durationMs = Math.max(0, Date.now() - startedAt);
					onSettled?.(true);
					const statusText = `Background task ${agentId} failed.`;
					await reportProgress(statusText);
					const message = errorMessage(error);
					const hint = AgentRegistry.global().get(agentId) ? buildFollowUpHint(false) : "";
					throw new TaskJobError(`${message}${hint}`);
				} finally {
					releasePermit();
				}
			},
			{
				id: agentId,
				agentId,
				queued: true,
				ownerId: this.session.getAgentId?.() ?? undefined,
				toolCallId,
				onProgress: text => {
					onUpdate?.({ content: [{ type: "text", text }], details: buildDetails() });
				},
			},
		);
	}

	async #executeSyncFanout(
		toolCallId: string,
		params: TaskParams,
		spawnItems: TaskItem[],
		defaultAgent: string,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
	): Promise<AgentToolResult<TaskToolDetails>> {
		if (spawnItems.length === 1) {
			const semaphore = this.#getSpawnSemaphore();
			const invokedAt = Date.now();
			await semaphore.acquire(signal);
			const acquiredAt = Date.now();
			try {
				return await this.#executeSync(
					toolCallId,
					spawnParamsFor(params, spawnItems[0], defaultAgent),
					signal,
					onUpdate,
					undefined,
					0,
					false,
					{ invokedAt, acquiredAt },
				);
			} finally {
				this.#releaseSpawnSemaphore();
			}
		}

		const startTime = Date.now();
		const latestProgress = new Map<number, AgentProgress>();
		const emitCombined = () => {
			onUpdate?.({
				content: [{ type: "text", text: `Running ${spawnItems.length} agents...` }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: Date.now() - startTime,
					progress: Array.from(latestProgress.entries())
						.sort((a, b) => a[0] - b[0])
						.map(([, progress]) => progress),
				},
			});
		};

		const payloads = await this.#runSyncSpawns({
			toolCallId,
			params,
			defaultAgent,
			signal,
			spawns: spawnItems.map((item, index) => ({ item, index })),
			onItemProgress: onUpdate
				? (index, progress) => {
						latestProgress.set(index, { ...progress, index });
						emitCombined();
					}
				: undefined,
		});

		const merged = mergeSyncPayloads(
			spawnItems.map((item, index) => ({ item, index })),
			payloads,
		);
		const summary = summarizeSubagentBatch(merged.results);
		summary.cancelled += merged.cancelledBeforeStart;
		const headline = describeSubagentBatch(summary);
		const contentParts = headline ? [headline, ...merged.contentParts] : merged.contentParts;
		return {
			content: [{ type: "text", text: contentParts.join("\n\n") }],
			isError: summary.isError,
			details: {
				projectAgentsDir: merged.projectAgentsDir,
				results: merged.results,
				totalDurationMs: Date.now() - startTime,
				usage: merged.usage,
				outputPaths: merged.outputPaths,
			},
		};
	}

	async #runSyncSpawns(args: {
		toolCallId: string;
		params: TaskParams;
		defaultAgent: string;
		spawns: SyncSpawnRef[];
		signal?: AbortSignal;
		onItemProgress?: (index: number, progress: AgentProgress) => void;
	}): Promise<(AgentToolResult<TaskToolDetails> | undefined)[]> {
		const { toolCallId, params, defaultAgent, spawns, signal, onItemProgress } = args;
		const semaphore = this.#getSpawnSemaphore();
		const { results } = await mapWithConcurrencyLimit(
			spawns,
			spawns.length,
			async (spawn, _position, workerSignal) => {
				const invokedAt = Date.now();
				await semaphore.acquire(workerSignal);
				const acquiredAt = Date.now();
				try {
					const itemOnUpdate: AgentToolUpdateCallback<TaskToolDetails> | undefined = onItemProgress
						? update => {
								const progress = update.details?.progress?.[0];
								if (progress) onItemProgress(spawn.index, progress);
							}
						: undefined;
					return await this.#executeSync(
						toolCallId,
						spawnParamsFor(params, spawn.item, defaultAgent),
						workerSignal,
						itemOnUpdate,
						spawn.preAllocatedId,
						spawn.index,
						false,
						{ invokedAt, acquiredAt },
					);
				} finally {
					this.#releaseSpawnSemaphore();
				}
			},
			signal,
		);
		return results;
	}

	async #executeSync(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		return this.#runSpawn(toolCallId, params, signal, onUpdate, preAllocatedId, spawnIndex, detached, launchTiming);
	}

	async #runSpawn(
		toolCallId: string,
		params: TaskParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<TaskToolDetails>,
		preAllocatedId?: string,
		spawnIndex = 0,
		detached = false,
		launchTiming?: { invokedAt: number; acquiredAt: number },
	): Promise<AgentToolResult<TaskToolDetails>> {
		const startTime = Date.now();
		const { agents, projectAgentsDir } = await discoverAgents(this.session.cwd);
		const agentName = params.agent ?? "";
		const sharedContext = this.#isBatchEnabled() ? params.context?.trim() || undefined : undefined;
		const assignment = (params.task ?? "").trim();
		const isolationMode = this.session.settings.get("subagent.isolation.mode");
		const isolationRequested = "isolated" in params ? params.isolated === true : false;
		const isIsolated = isolationMode !== "none" && isolationRequested;
		const mergeMode = this.session.settings.get("subagent.isolation.merge");
		const taskDepth = this.session.taskDepth ?? 0;
		const subagentLspEnabled = (this.session.enableLsp ?? true) && this.session.settings.get("subagent.enableLsp");

		if (isolationMode === "none" && "isolated" in params) {
			return {
				content: [{ type: "text", text: "Task isolation is disabled." }],
				details: { projectAgentsDir, results: [], totalDurationMs: 0 },
			};
		}

		const agent = getAgent(agents, agentName);
		if (!agent) {
			const available = agents.map(a => a.name).join(", ") || "none";
			return {
				content: [{ type: "text", text: `Unknown agent "${agentName}". Available: ${available}` }],
				details: { projectAgentsDir, results: [], totalDurationMs: 0 },
			};
		}

		if (!isSubagentEnabled(this.session.settings, agent) && !this.session.agentGrantedThisTurn?.(agent.name)) {
			const enabled = filterEnabledAgents(this.session.settings, agents).map(a => a.name);
			return {
				content: [
					{
						type: "text",
						text: `Agent "${agentName}" is disabled (subagent.agents.${agentName}.enabled is false), so it cannot be chosen. Enable it in the Subagents settings tab (/settings), or use a different agent type.${enabled.length > 0 ? ` Enabled: ${enabled.join(", ")}` : ""}`,
					},
				],
				details: { projectAgentsDir, results: [], totalDurationMs: 0 },
			};
		}

		const planModeState = this.session.getPlanModeState?.();
		const planModeBaseTools: string[] = [TOOL.read, TOOL.grep, TOOL.glob, TOOL.lsp, TOOL.web_search];
		const planModeTools = [
			...planModeBaseTools,
			...(agent.tools ?? []).filter(
				tool => PLAN_MODE_AGENT_TOOL_ALLOWLIST.has(tool) && !planModeBaseTools.includes(tool),
			),
		];
		const effectiveAgent: typeof agent = planModeState?.enabled
			? {
					...agent,
					systemPrompt: `${planModePrompts["plan-mode/subagent"].text}\n\n${agent.systemPrompt}`,
					tools: planModeTools,
					spawns: undefined,
				}
			: agent;

		const parentActiveModelPattern = this.session.getActiveModelString?.();
		const parentThinkingLevel = this.session.getActiveThinkingLevel?.();
		const resolvedModel = resolveSubagentModel({
			settings: this.session.settings,
			agentName,
			agentModel: effectiveAgent.model,
			activeModelPattern: parentActiveModelPattern,
			fallbackModelPattern: this.session.getModelString?.(),
			taskDepth: taskDepth + 1,
		});
		if (resolvedModel.unresolved) {
			const { source, value, depth } = resolvedModel.unresolved;
			return {
				content: [
					{
						type: "text",
						text: `Cannot spawn "${agentName}": ${subagentModelSourceLabel(source, agentName, depth)} is set to "${value}", which matches no available model. Fix that setting (or clear it to inherit the session model) and try again.`,
					},
				],
				details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
			};
		}
		const modelOverride = resolvedModel.patterns;
		const thinkingLevelOverride = resolveSubagentThinkingLevel({
			settings: this.session.settings,
			agentName,
			agentThinkingLevel: effectiveAgent.thinkingLevel,
		});

		const effectiveOutputSchema = effectiveAgent.output ?? this.session.outputSchema;

		let isolationContext: IsolationContext | null = null;
		if (isIsolated) {
			try {
				isolationContext = await prepareIsolationContext(this.session.cwd);
			} catch (err) {
				const message = errorMessage(err);
				return {
					content: [{ type: "text", text: `Isolated task execution requires a git repository. ${message}` }],
					details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
				};
			}
		}
		const repoRoot = isolationContext?.repoRoot ?? null;

		const preferredIsolationBackend = parseIsolationMode(isolationMode);

		const sessionFile = this.session.getSessionFile();
		const artifactsDir = sessionFile ? sessionFile.slice(0, -6) : null;
		const orphanArtifactsDir = artifactsDir ? null : path.join(getSessionsDir(), `orphan-task-${Snowflake.next()}`);
		const effectiveArtifactsDir = artifactsDir || orphanArtifactsDir!;

		const localProtocolOptions: LocalProtocolOptions = this.session.localProtocolOptions ?? {
			getArtifactsDir: this.session.getArtifactsDir ?? (() => null),
			getSessionId: this.session.getSessionId ?? (() => null),
		};

		const parentArtifactManager = this.session.getArtifactManager?.() ?? undefined;

		const planReference = planModeState?.enabled
			? undefined
			: await loadOverallPlanReference(
					this.session.getPlanReferencePath?.() ?? DEFAULT_PLAN_FILE_URL,
					localProtocolOptions,
				);

		try {
			await fs.mkdir(effectiveArtifactsDir, { recursive: true });

			let agentId: string;
			if (preAllocatedId) {
				agentId = preAllocatedId;
			} else {
				const outputManager =
					this.session.agentOutputManager ?? new AgentOutputManager(this.session.getArtifactsDir ?? (() => null));
				agentId = await outputManager.allocate(params.name?.trim() || generateTaskName());
			}

			const parentEvalSessionId = this.session.getEvalSessionId?.() ?? undefined;
			const mcpManager = this.session.mcpManager ?? mcpManagerInstance();

			let latestProgress: AgentProgress = {
				index: spawnIndex,
				id: agentId,
				agent: agentName,
				agentSource: agent.source,
				status: "pending",
				task: renderSubagentUserPrompt(assignment),
				assignment,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				requests: 0,
				tokens: 0,
				cost: 0,
				durationMs: 0,
				modelOverride,
			};
			const emitProgress = () => {
				onUpdate?.({
					content: [{ type: "text", text: `Running agent ${agentId}...` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
						progress: [latestProgress],
					},
				});
			};
			emitProgress();

			const buildCommitMessageFn = makeIsolationCommitMessage(this.session);

			let spawnCwd: string;
			try {
				spawnCwd = await resolveSpawnCwd(params.cwd, this.session.cwd);
			} catch (err) {
				const message = errorMessage(err);
				return {
					content: [{ type: "text", text: message }],
					details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
				};
			}

			const contextFiles = inheritContextFiles({
				parentContextFiles: this.session.contextFiles,
				parentCwd: this.session.cwd,
				spawnCwd,
				agentName,
			});
			const inheritedSkills = inheritResolvedCollection({
				items: this.session.skills,
				kind: "skills",
				parentCwd: this.session.cwd,
				spawnCwd,
				agentName,
			});
			const resolvedAutoloadSkills = resolveAutoloadSkills(agent.autoloadSkills, inheritedSkills, agentName);
			const promptTemplates = inheritResolvedCollection({
				items: this.session.promptTemplates,
				kind: "promptTemplates",
				parentCwd: this.session.cwd,
				spawnCwd,
				agentName,
			});
			const inheritedRules = inheritResolvedCollection({
				items: this.session.rules,
				kind: "rules",
				parentCwd: this.session.cwd,
				spawnCwd,
				agentName,
			});

			const sharedRunOptions = {
				cwd: spawnCwd,
				agent: effectiveAgent,
				task: renderSubagentUserPrompt(assignment),
				assignment,
				context: sharedContext,
				planReference,
				index: spawnIndex,
				parentToolCallId: toolCallId,
				detached,
				id: agentId,
				taskDepth,
				invokedAt: launchTiming?.invokedAt,
				acquiredAt: launchTiming?.acquiredAt,
				modelOverride,
				parentActiveModelPattern,
				parentThinkingLevel,
				thinkingLevel: thinkingLevelOverride,
				outputSchema: effectiveOutputSchema,
				sessionFile,
				persistArtifacts: !!artifactsDir,
				artifactsDir: effectiveArtifactsDir,
				enableLsp: subagentLspEnabled,
				signal,
				eventBus: this.session.eventBus,
				onProgress: (progress: AgentProgress) => {
					latestProgress = { ...progress, recentTools: progress.recentTools.slice() };
					emitProgress();
				},
				authStorage: this.session.authStorage,
				modelRegistry: this.session.modelRegistry,
				settings: this.session.settings,
				bypassAllApprovals: this.session.isApprovalBypassed?.() ?? false,
				parentApprovalBypassed: () => this.session.isApprovalBypassed?.() ?? false,
				obfuscateProviderText: this.session.obfuscateProviderText,
				completeImpl: this.session.sideComplete,
				mcpManager,
				contextFiles,
				skills: inheritedSkills,
				autoloadSkills: resolvedAutoloadSkills,
				workspaceTree: this.session.workspaceTree,
				promptTemplates,
				rules: inheritedRules,
				preloadedExtensionPaths: this.session.extensionPaths,
				preloadedNamedExtensionPaths: this.session.namedExtensionPaths,
				preloadedCustomToolPaths: this.session.customToolPaths,
				localProtocolOptions,
				parentArtifactManager,
				parentHindsightSessionState: this.session.getHindsightSessionState?.(),
				parentMnemopiSessionState: this.session.getMnemopiSessionState?.(),
				parentArgot: this.session.getArgotSession?.(),
				parentTelemetry: this.session.getTelemetry?.(),
				parentEvalSessionId,
				parentAgentId: this.session.getAgentId?.() ?? MAIN_AGENT_ID,
				parentSessionId: this.session.getSessionId?.() ?? undefined,
				parentServiceTier: this.session.getServiceTierByFamily
					? (this.session.getServiceTierByFamily() ?? null)
					: undefined,
			};

			const runTask = async (): Promise<SingleResult> => {
				if (!isIsolated) {
					return runSubprocess(sharedRunOptions);
				}
				if (!isolationContext) {
					throw new Error("Isolated task execution not initialized.");
				}
				const taskStart = Date.now();
				return runIsolatedSubprocess({
					baseOptions: sharedRunOptions,
					context: isolationContext,
					preferredBackend: preferredIsolationBackend,
					agentId,
					mergeMode,
					artifactsDir: effectiveArtifactsDir,
					buildCommitMessage: buildCommitMessageFn,
					buildFailureResult: err => {
						const message = errorMessage(err);
						return {
							index: spawnIndex,
							id: agentId,
							agent: agent.name,
							agentSource: agent.source,
							task: renderSubagentUserPrompt(assignment),
							assignment,
							exitCode: 1,
							output: "",
							stderr: message,
							truncated: false,
							durationMs: Date.now() - taskStart,
							tokens: 0,
							requests: 0,
							modelOverride,
							error: message,
						};
					},
				});
			};

			const result = await runTask();

			let mergeSummary = "";
			let changesApplied: boolean | null = null;
			let mergedBranchForNestedPatches = false;
			if (isIsolated && repoRoot) {
				const outcome = await mergeIsolatedChanges({ result, repoRoot, mergeMode });
				mergeSummary = outcome.summary;
				changesApplied = outcome.changesApplied;
				mergedBranchForNestedPatches = outcome.mergedBranchForNestedPatches;
			}

			if (isIsolated && repoRoot) {
				mergeSummary += await applyEligibleNestedPatches({
					result,
					repoRoot,
					mergeMode,
					changesApplied,
					mergedBranchForNestedPatches,
					commitMessage: buildCommitMessageFn(),
				});
			}

			this.session.recordSubagentSpawn?.({
				agentId: result.id,
				agentName: result.agent,
				task: result.task,
				sessionFile: path.join(effectiveArtifactsDir, sessionFileName(result.id)),
				isolation: isIsolated ? isolationMode : "none",
				status: result.aborted ? "cancelled" : result.exitCode === 0 ? "completed" : "failed",
				exitCode: result.exitCode,
				durationMs: result.durationMs,
				usage: result.usage,
				error: result.error,
			});

			return this.#buildResultPayload(result, projectAgentsDir, Date.now() - startTime, mergeSummary);
		} catch (err) {
			return {
				content: [{ type: "text", text: `Task execution failed: ${err}` }],
				details: { projectAgentsDir, results: [], totalDurationMs: Date.now() - startTime },
			};
		}
	}

	#buildResultPayload(
		result: SingleResult,
		projectAgentsDir: string | null,
		totalDurationMs: number,
		mergeSummary: string,
	): AgentToolResult<TaskToolDetails> {
		const outcome = classifySubagentOutcome(result);
		const status = outcome.label;
		const output = formatResultOutputFallback(result);
		const outputCharCount = result.outputMeta?.charCount ?? output.length;
		const fullOutputThreshold = 5000;
		let preview = output;
		let truncated = false;
		if (outputCharCount > fullOutputThreshold) {
			const slice = output.slice(0, fullOutputThreshold);
			const lastNewline = slice.lastIndexOf("\n");
			preview = lastNewline >= 0 ? slice.slice(0, lastNewline) : slice;
			truncated = true;
		}
		const refStatus = AgentRegistry.global().get(result.id)?.status;
		const resumable = result.aborted && (refStatus === "idle" || refStatus === "parked");
		const summary = prompt.render(toolsPrompts["tools/task-summary"].text, {
			agentName: result.agent,
			id: result.id,
			status,
			duration: formatDuration(totalDurationMs),
			abortReason: result.aborted ? result.abortReason : undefined,
			resumable,
			preview,
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary,
		});

		return {
			content: [{ type: "text", text: summary }],
			isError: outcome.isError,
			details: {
				projectAgentsDir,
				results: [result],
				totalDurationMs,
				usage: result.usage,
				outputPaths: result.outputPath ? [result.outputPath] : undefined,
			},
		};
	}
}
