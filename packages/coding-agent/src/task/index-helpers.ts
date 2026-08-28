import * as fs from "node:fs/promises";
import path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import type { Usage } from "@veyyon/ai";
import { emptyCost, emptyUsage } from "@veyyon/catalog/models";
import { directoryExists, prompt } from "@veyyon/utils";
import { subagentPrompts } from "../prompts/subagent/rows";
import { toolsPrompts } from "../prompts/tools/rows";
import type { EnabledSubagentCatalog } from "./subagent-settings";
import type { AgentDefinition, SingleResult, TaskItem, TaskParams, TaskToolDetails } from "./types";
import "../tools/review";
import { TOOL } from "../tools/builtin-names";
import { type DiscoveryResult, discoverAgents } from "./discovery";

export function renderSubagentUserPrompt(assignment: string): string {
	return prompt.render(subagentPrompts["subagent/user-prompt"].text, {
		assignment: assignment.trim(),
	});
}

export function createUsageTotals(): Usage {
	return emptyUsage();
}

export function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
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

export const PLAN_MODE_AGENT_TOOL_ALLOWLIST: ReadonlySet<string> = new Set([TOOL.ast_grep, TOOL.report_finding]);

export function isReadOnlyAgent(agent: AgentDefinition): boolean {
	return !!agent.tools?.length && agent.tools.every(tool => READ_ONLY_TOOL_NAMES.has(tool));
}

export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

export function renderDescription(
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

export function createTaskModeError(
	text: string,
	warning?: TaskToolDetails["warning"],
): AgentToolResult<TaskToolDetails> {
	return {
		content: [{ type: "text", text }],
		isError: true,
		details: { projectAgentsDir: null, results: [], totalDurationMs: 0, warning },
	};
}

export function validateShapeParams(batchEnabled: boolean, params: TaskParams): string | undefined {
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

export function validateSpawnParams(params: TaskParams, batchEnabled: boolean): string | undefined {
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

export function resolveSpawnItems(params: TaskParams): TaskItem[] {
	if (Array.isArray(params.tasks) && params.tasks.length > 0) {
		return params.tasks;
	}
	const item: TaskItem = { name: params.name, agent: params.agent, task: params.task };
	if ("isolated" in params) item.isolated = params.isolated;
	if (params.cwd !== undefined) item.cwd = params.cwd;
	return [item];
}

export function spawnParamsFor(params: TaskParams, item: TaskItem, defaultAgent: string): TaskParams {
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

export interface SyncSpawnRef {
	item: TaskItem;
	index: number;
	preAllocatedId?: string;
}

export interface MergedSyncPayloads {
	contentParts: string[];
	results: SingleResult[];
	usage?: Usage;
	outputPaths?: string[];
	projectAgentsDir: string | null;
	cancelledBeforeStart: number;
}

export function mergeSyncPayloads(
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

export const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["deep", "sonic"]); // not-a-tool-name: agent ids

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

export class TaskJobError extends Error {}

export const discoveryMemo = new Map<string, Promise<DiscoveryResult>>();
export let discoveryMemoFn: typeof discoverAgents | undefined;

export function discoverAgentsForCreate(cwd: string): Promise<DiscoveryResult> {
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
