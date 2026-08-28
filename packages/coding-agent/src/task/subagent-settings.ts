import { isRecord, logger } from "@veyyon/utils";
import { parseConfiguredEffortSetting } from "../config/effort-resolver";
import { resolveConfiguredModelPatterns } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { SubagentAgentSettings, SubagentLaneSettings } from "../config/settings-domains/subagents";
import {
	DEFAULT_ENABLED_BUNDLED_AGENT,
	DEFAULT_SUBAGENT_IDLE_TTL_MS,
	DEFAULT_SUBAGENT_MAX_NESTED_SPAWN_DEPTH,
	DEFAULT_SUBAGENT_PARKED_CLOSE_MS,
	DEFAULT_SUBAGENT_WAITING_CLOSE_MS,
	isModelByDepthKey,
} from "../config/settings-domains/subagents";
import type { SettingPath } from "../config/settings-schema";
import type { ConfiguredThinkingLevel } from "../thinking";
import { currentAgentName, type ResolvedSpawnPolicy, resolveSpawnPolicy } from "./spawn-policy";
import type { AgentDefinition } from "./types";

export type DelegationStrength = "allowed" | "preferred" | "required";

export function delegationStrength(settings: Settings): DelegationStrength {
	return (settings.get("subagent.delegation") ?? "preferred") as DelegationStrength;
}

export function subagentsEnabled(settings: Settings): boolean {
	return settings.get("subagent.enabled") ?? true;
}

export function resolveSubagentIdleTtlMs(settings: Settings): number {
	const configured = Number(settings.get("subagent.idleTtlMs") ?? DEFAULT_SUBAGENT_IDLE_TTL_MS);
	if (!Number.isFinite(configured)) return DEFAULT_SUBAGENT_IDLE_TTL_MS;
	return Math.max(0, Math.trunc(configured));
}

export interface SubagentAutoCloseBudget {
	parkedMs: number;
	waitingMs: number;
}

export function resolveSubagentAutoCloseBudget(settings: Settings): SubagentAutoCloseBudget {
	if ((settings.get("subagent.autoClose.enabled") ?? true) !== true) {
		return { parkedMs: 0, waitingMs: 0 };
	}
	const readMs = (path: "subagent.autoClose.parkedMs" | "subagent.autoClose.waitingMs", fallback: number): number => {
		const configured = Number(settings.get(path) ?? fallback);
		if (!Number.isFinite(configured)) return fallback;
		return Math.max(0, Math.trunc(configured));
	};
	const parkedMs = readMs("subagent.autoClose.parkedMs", DEFAULT_SUBAGENT_PARKED_CLOSE_MS);
	const waitingMs = readMs("subagent.autoClose.waitingMs", DEFAULT_SUBAGENT_WAITING_CLOSE_MS);
	if (parkedMs === 0) return { parkedMs: 0, waitingMs: 0 };
	return { parkedMs, waitingMs: Math.max(parkedMs, waitingMs) };
}

export function delegationEnabled(settings: Settings): boolean {
	return subagentsEnabled(settings);
}

export type DelegationBlocker = "subagents-off" | "no-enabled-agents";

export interface DelegationState {
	strength: DelegationStrength;
	enabledAgents: readonly string[];
	possible: boolean;
	preferred: boolean;
	required: boolean;
	blockedBy?: DelegationBlocker;
}

export function resolveDelegation(settings: Settings, enabledAgents: readonly string[]): DelegationState {
	const strength = delegationStrength(settings);
	const blockedBy: DelegationBlocker | undefined = !subagentsEnabled(settings)
		? "subagents-off"
		: enabledAgents.length === 0
			? "no-enabled-agents"
			: undefined;
	const possible = blockedBy === undefined;
	return {
		strength,
		enabledAgents,
		possible,
		preferred: possible && (strength === "preferred" || strength === "required"),
		required: possible && strength === "required",
		blockedBy,
	};
}

export function delegationBlockedNotice(state: DelegationState): string | undefined {
	if (state.blockedBy === "subagents-off") {
		return "Subagents are off, so nothing here runs until you turn them back on.";
	}
	if (state.blockedBy === "no-enabled-agents") {
		return `No agent is enabled, so there is nothing to delegate to and "${state.strength}" has no effect.`;
	}
	return undefined;
}

export function subagentSettingsFor(settings: Settings, name: string): SubagentAgentSettings {
	const table = settings.get("subagent.agents") as Record<string, SubagentAgentSettings> | undefined;
	const row = table?.[name] ?? table?.[currentAgentName(name)];
	return isRecord(row) ? (row as SubagentAgentSettings) : {};
}

function parseMaxNestedSpawnDepth(setting: string, value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= -1) return value;
	throw new Error(`${setting} must be -1 (unlimited) or a non-negative integer; received ${String(value)}`);
}

export function subagentLaneChain(row: SubagentLaneSettings): SubagentLaneSettings[] {
	const chain: SubagentLaneSettings[] = [];
	let lane: SubagentLaneSettings | undefined = row;
	for (let depth = 0; lane !== undefined && depth <= MAX_LANE_DEPTH; depth++) {
		chain.push(lane);
		lane = lane.subagents;
	}
	return chain;
}

const MAX_LANE_DEPTH = 64;

export function laneDepthOf(row: SubagentLaneSettings, blanketMax: number, agentName: string): number {
	if (row.subagents === undefined && row.maxNestedSpawnDepth !== undefined) {
		return parseMaxNestedSpawnDepth(`subagent.agents.${agentName}.maxNestedSpawnDepth`, row.maxNestedSpawnDepth);
	}
	const chain = subagentLaneChain(row);
	for (let index = 1; index < chain.length; index++) {
		if (chain[index]?.enabled === false) return index - 1;
	}
	if (blanketMax < 0) return blanketMax;
	return Math.max(chain.length - 1, blanketMax);
}

export function resolveSubagentMaxNestedSpawnDepth(settings: Settings, agentName?: string): number {
	const blanket = settings.get("subagent.maxNestedSpawnDepth");
	const blanketMax =
		blanket === undefined
			? DEFAULT_SUBAGENT_MAX_NESTED_SPAWN_DEPTH
			: parseMaxNestedSpawnDepth("subagent.maxNestedSpawnDepth", blanket);
	if (agentName === undefined) return blanketMax;
	const row = subagentSettingsFor(settings, agentName);
	if (row.subagents === undefined && row.maxNestedSpawnDepth === undefined) return blanketMax;
	return laneDepthOf(row, blanketMax, agentName);
}

export function resolveSessionMaxNestedSpawnDepth(settings: Settings, override?: number): number {
	return override === undefined
		? resolveSubagentMaxNestedSpawnDepth(settings)
		: parseMaxNestedSpawnDepth("session maxNestedSpawnDepth", override);
}

export function subagentEnabledByDefault(agent: AgentDefinition): boolean {
	return currentAgentName(agent.name) === DEFAULT_ENABLED_BUNDLED_AGENT;
}

export function isSubagentEnabled(settings: Settings, agent: AgentDefinition): boolean {
	return subagentSettingsFor(settings, agent.name).enabled ?? subagentEnabledByDefault(agent);
}

export function filterEnabledAgents(settings: Settings, agents: readonly AgentDefinition[]): AgentDefinition[] {
	return agents.filter(agent => isSubagentEnabled(settings, agent));
}

export interface EnabledSubagentCatalog {
	readonly agents: readonly AgentDefinition[];
	readonly defaultAgent: string | undefined;
	readonly spawnPolicy: ResolvedSpawnPolicy;
}

export interface ResolveEnabledSubagentsOptions {
	settings: Settings;
	agents: readonly AgentDefinition[];
	parentSpawns?: string | boolean | null;
	isGranted?: (agentName: string) => boolean;
}

export function resolveEnabledSubagents(options: ResolveEnabledSubagentsOptions): EnabledSubagentCatalog {
	const spawnPolicy = resolveSpawnPolicy(options.parentSpawns ?? "*");
	if (!subagentsEnabled(options.settings) || !spawnPolicy.enabled) {
		return { agents: [], defaultAgent: undefined, spawnPolicy };
	}

	const enabled = options.agents.filter(
		agent => isSubagentEnabled(options.settings, agent) || options.isGranted?.(agent.name) === true,
	);
	let agents: AgentDefinition[];
	if (spawnPolicy.allowedAgents === null) {
		agents = enabled;
	} else {
		const enabledByName = new Map(enabled.map(agent => [agent.name, agent]));
		const seen = new Set<string>();
		agents = [];
		for (const name of spawnPolicy.allowedAgents) {
			if (seen.has(name)) continue;
			seen.add(name);
			const agent = enabledByName.get(name);
			if (agent) agents.push(agent);
		}
	}
	const defaultAgent =
		agents.find(agent => agent.name === spawnPolicy.defaultAgent) ??
		agents.find(agent => currentAgentName(agent.name) === spawnPolicy.defaultAgent);
	return { agents, defaultAgent: defaultAgent?.name, spawnPolicy };
}

export type SubagentEnableState = "on" | "off";

export function subagentEnableState(agent: AgentDefinition, configured: boolean | undefined): SubagentEnableState {
	return (configured ?? subagentEnabledByDefault(agent)) ? "on" : "off";
}

export function isSubagentEnableDefaulted(configured: boolean | undefined): boolean {
	return configured === undefined;
}

export const SUBAGENT_ENABLE_STATE_LABEL: Record<SubagentEnableState, string> = {
	on: "Enabled",
	off: "Disabled",
};

export function nextSubagentEnableValue(agent: AgentDefinition, configured: boolean | undefined): boolean {
	return !(configured ?? subagentEnabledByDefault(agent));
}

export interface EnabledSubagentSource {
	readonly enabledAgentNames: string[];
}

export function enabledSubagentNames(spawner: unknown): string[] {
	return readNameList(spawner, "enabledAgentNames");
}

export function preferredSubagentName(enabled: readonly string[], preferred: string): string | undefined {
	return enabled.includes(preferred) ? preferred : enabled[0];
}

function readNameList(spawner: unknown, key: keyof EnabledSubagentSource): string[] {
	const names = (spawner as Partial<EnabledSubagentSource> | undefined)?.[key];
	return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
}

export type SubagentModelSource = "lane" | "depth" | "blanket" | "frontmatter" | "inherit";

export interface ResolvedSubagentModel {
	patterns: string[];
	source: SubagentModelSource;
	depth?: number;
	unresolved?: { source: SubagentModelSource; value: string; depth?: number };
}

export function subagentModelSourceLabel(source: SubagentModelSource, agentName: string, depth?: number): string {
	switch (source) {
		case "lane":
			return depth === undefined || depth <= 0
				? `subagent.agents.${agentName}`
				: `subagent.agents.${agentName}${".subagents".repeat(depth)}`;
		case "depth":
			return `subagent.modelByDepth.${depth ?? "?"}`;
		case "blanket":
			return "subagent.model";
		case "frontmatter":
			return `${agentName} agent frontmatter`;
		case "inherit":
			return "inherited from the session model";
	}
}

const reportedSupersededAgentFields = new Set<string>();

export const SUPERSEDED_AGENT_ROW_FIELDS = ["maxNestedSpawnDepth"] as const;

export type SupersededAgentRowField = (typeof SUPERSEDED_AGENT_ROW_FIELDS)[number];

const SUPERSEDED_FIELD_REPLACEMENT: Record<SupersededAgentRowField, string> = {
	maxNestedSpawnDepth:
		"Open Subagents → Subagent Roster → that agent → Subagents and turn each level on or off; the chain is the ceiling.",
};

function reportSupersededAgentRowField(agentName: string, field: SupersededAgentRowField, value: unknown): void {
	const key = `${agentName}.${field}`;
	if (reportedSupersededAgentFields.has(key)) return;
	reportedSupersededAgentFields.add(key);
	logger.warn(
		`Settings: subagent.agents.${agentName}.${field} is "${String(value)}", which no screen writes any more — ` +
			`the nested Subagents chain replaced it. ${SUPERSEDED_FIELD_REPLACEMENT[field]}`,
		{ setting: `subagent.agents.${agentName}.${field}`, value },
	);
}

function reportSupersededAgentRows(settings: Settings): void {
	const table = settings.get("subagent.agents");
	if (!table || typeof table !== "object") return;
	for (const [agentName, row] of Object.entries(table)) {
		if (!row || typeof row !== "object") continue;
		for (const field of SUPERSEDED_AGENT_ROW_FIELDS) {
			if (!(field in row)) continue;
			const value = Reflect.get(row, field);
			if (value === undefined) continue;
			reportSupersededAgentRowField(agentName, field, value);
		}
	}
}

export function resetSupersededAgentRowReports(): void {
	reportedSupersededAgentFields.clear();
}

export const SUBAGENT_MODEL_BY_DEPTH_PATH: SettingPath = "subagent.modelByDepth";

export function subagentModelByDepthRowPath(depth: number): SettingPath {
	return `${SUBAGENT_MODEL_BY_DEPTH_PATH}.${depth}` as SettingPath;
}

function readModelByDepthTable(settings: Settings): Record<string, unknown> {
	const table: unknown = settings.get(SUBAGENT_MODEL_BY_DEPTH_PATH);
	return isRecord(table) ? table : {};
}

export interface SubagentModelByDepthRow {
	depth: number;
	value: string | string[];
}

export function subagentModelByDepthRows(settings: Settings): SubagentModelByDepthRow[] {
	const rows: SubagentModelByDepthRow[] = [];
	for (const [key, value] of Object.entries(readModelByDepthTable(settings))) {
		if (!isModelByDepthKey(key)) continue;
		if (typeof value !== "string" && !Array.isArray(value)) continue;
		rows.push({ depth: Number(key), value });
	}
	return rows.sort((a, b) => a.depth - b.depth);
}

export function nextSubagentModelByDepth(settings: Settings): number {
	const used = new Set(subagentModelByDepthRows(settings).map(row => row.depth));
	let depth = 1;
	while (used.has(depth)) depth++;
	return depth;
}

export function clearSubagentModelByDepthRow(settings: Settings, depth: number): void {
	settings.unset(subagentModelByDepthRowPath(depth));
	if (subagentModelByDepthRows(settings).length === 0) settings.unset(SUBAGENT_MODEL_BY_DEPTH_PATH);
}

function readDepthModelRow(settings: Settings, depth: number): string | string[] | undefined {
	const value = readModelByDepthTable(settings)[String(depth)];
	return typeof value === "string" || Array.isArray(value) ? value : undefined;
}
function laneForSpawn(
	settings: Settings,
	agentName: string,
	taskDepth: number | undefined,
): { chain: SubagentLaneSettings[]; index: number } {
	const chain = subagentLaneChain(subagentSettingsFor(settings, agentName));
	return { chain, index: Math.max(0, (taskDepth ?? 1) - 1) };
}

function laneModelLayer(
	settings: Settings,
	agentName: string,
	taskDepth: number | undefined,
): { source: "lane"; value: string | string[]; depth: number } | undefined {
	const { chain, index } = laneForSpawn(settings, agentName, taskDepth);
	for (let level = Math.min(index, chain.length - 1); level >= 0; level--) {
		const value = chain[level]?.model;
		if (value === undefined) continue;
		if (typeof value === "string" && value.trim().length === 0) continue;
		if (Array.isArray(value) && value.length === 0) continue;
		return { source: "lane", value, depth: level };
	}
	return undefined;
}

export function resolveSubagentModel(options: {
	settings: Settings;
	agentName: string;
	agentModel?: string | string[];
	activeModelPattern?: string;
	fallbackModelPattern?: string;
	taskDepth?: number;
}): ResolvedSubagentModel {
	const { settings, agentName, agentModel, activeModelPattern, fallbackModelPattern, taskDepth } = options;

	reportSupersededAgentRows(settings);
	const depthRow = taskDepth !== undefined && taskDepth >= 1 ? readDepthModelRow(settings, taskDepth) : undefined;
	const lane = laneModelLayer(settings, agentName, taskDepth);
	const layers: Array<{ source: SubagentModelSource; value: string | string[] | undefined; depth?: number }> = [
		...(lane === undefined ? [] : [lane]),
		...(depthRow !== undefined && taskDepth !== undefined
			? [{ source: "depth" as const, value: depthRow, depth: taskDepth }]
			: []),
		{ source: "blanket", value: settings.get("subagent.model") },
		{ source: "frontmatter", value: agentModel },
	];

	for (const layer of layers) {
		const raw = Array.isArray(layer.value) ? layer.value : layer.value?.trim();
		if (raw === undefined || (typeof raw === "string" && raw.length === 0)) continue;
		if (Array.isArray(raw) && raw.length === 0) continue;
		const depthFields = layer.depth !== undefined ? { depth: layer.depth } : {};
		const patterns = resolveConfiguredModelPatterns(raw, settings);
		if (patterns.length > 0) return { patterns, source: layer.source, ...depthFields };
		return {
			patterns: [],
			source: layer.source,
			...depthFields,
			unresolved: { source: layer.source, value: Array.isArray(raw) ? raw.join(",") : raw, ...depthFields },
		};
	}

	const inherited = activeModelPattern?.trim() || fallbackModelPattern?.trim() || "";
	return { patterns: resolveConfiguredModelPatterns(inherited, settings), source: "inherit" };
}

export function resolveSubagentThinkingLevel(options: {
	settings: Settings;
	agentName: string;
	agentThinkingLevel?: ConfiguredThinkingLevel;
	taskDepth?: number;
}): ConfiguredThinkingLevel | undefined {
	reportSupersededAgentRows(options.settings);
	const { chain, index } = laneForSpawn(options.settings, options.agentName, options.taskDepth);
	for (let level = Math.min(index, chain.length - 1); level >= 0; level--) {
		const raw = chain[level]?.thinkingLevel;
		if (raw === undefined) continue;
		const path = `subagent.agents.${options.agentName}${".subagents".repeat(level)}.thinkingLevel`;
		const parsed = parseConfiguredEffortSetting(path, raw);
		if (parsed !== undefined) return parsed;
	}
	const fromBlanket = parseConfiguredEffortSetting(
		"subagent.thinkingLevel",
		options.settings.get("subagent.thinkingLevel"),
	);
	if (fromBlanket !== undefined) return fromBlanket;
	return options.agentThinkingLevel;
}
