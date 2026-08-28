/** The ONE reader for the `subagent.*` settings area. Every question about a spawned agent — may I delegate at all, does this agent */

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

/** How hard this session pushes work out to subagents. Every value here still ALLOWS delegation. `allowed` is the floor: the model keeps */
export type DelegationStrength = "allowed" | "preferred" | "required";

/** Resolved delegation strength (`subagent.delegation`). */
export function delegationStrength(settings: Settings): DelegationStrength {
	return (settings.get("subagent.delegation") ?? "preferred") as DelegationStrength;
}

/** Whether subagents exist at all in this session (`subagent.enabled`). The one kill switch. False removes the task tool and every delegation section from */
export function subagentsEnabled(settings: Settings): boolean {
	return settings.get("subagent.enabled") ?? true;
}

/** Resolve how long a finished subagent remains live before parking. This lifecycle budget is intentionally model-independent. Provider cache */
export function resolveSubagentIdleTtlMs(settings: Settings): number {
	const configured = Number(settings.get("subagent.idleTtlMs") ?? DEFAULT_SUBAGENT_IDLE_TTL_MS);
	if (!Number.isFinite(configured)) return DEFAULT_SUBAGENT_IDLE_TTL_MS;
	return Math.max(0, Math.trunc(configured));
}

/** How long a parked subagent survives before it is closed, by whether it was waiting. */
export interface SubagentAutoCloseBudget {
	/** Ordinary parked agent. 0 disables closing entirely. */
	parkedMs: number;
	/** Parked agent whose last message said it was waiting on another agent. */
	waitingMs: number;
}

/** Resolve when a PARKED subagent stops being listed at all. Parking already released the session; this is the second stage, and without it a */
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
	// A zero parked budget means "never close", so a waiting budget cannot revive
	// closing for the waiting case alone.
	if (parkedMs === 0) return { parkedMs: 0, waitingMs: 0 };
	return { parkedMs, waitingMs: Math.max(parkedMs, waitingMs) };
}

/** True when the task tool is offered at all: deliberately the MASTER SWITCH ({@link subagentsEnabled}) and nothing more. */
export function delegationEnabled(settings: Settings): boolean {
	return subagentsEnabled(settings);
}

/** Why delegation cannot happen, when it cannot. Two settings can each stop it on their own, and an operator staring at one of */
export type DelegationBlocker = "subagents-off" | "no-enabled-agents";

/** Delegation as one resolved answer, from both settings that decide it. */
export interface DelegationState {
	strength: DelegationStrength;
	/** Agent types the model may choose, in discovery order. */
	enabledAgents: readonly string[];
	/** Delegation can actually happen: the tool is offered AND something can take the work. */
	possible: boolean;
	/** The prompt should push substantial work out to a subagent. */
	preferred: boolean;
	/** A first-turn reminder to delegate is injected as well. */
	required: boolean;
	/** Set exactly when `possible` is false. */
	blockedBy?: DelegationBlocker;
}

/** Resolve delegation from BOTH settings that decide it, in one place. `subagent.delegation` and the `subagent.agents` table are one question with two */
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

/** One sentence saying why nothing will be delegated, for a settings surface. Returns `undefined` when delegation is possible, so a caller renders it or */
export function delegationBlockedNotice(state: DelegationState): string | undefined {
	if (state.blockedBy === "subagents-off") {
		return "Subagents are off, so nothing here runs until you turn them back on.";
	}
	if (state.blockedBy === "no-enabled-agents") {
		return `No agent is enabled, so there is nothing to delegate to and "${state.strength}" has no effect.`;
	}
	return undefined;
}

/** The `subagent.agents` row for `name`, or an empty row when unconfigured. Defends against a missing table as well as a missing row: the schema default is */
export function subagentSettingsFor(settings: Settings, name: string): SubagentAgentSettings {
	const table = settings.get("subagent.agents") as Record<string, SubagentAgentSettings> | undefined;
	// A row written under a retired name still governs the agent that replaced it.
	// Without this an operator who had pinned a model on `subagent.agents.task`
	// would keep the row in their config and silently stop getting the model.
	const row = table?.[name] ?? table?.[currentAgentName(name)];
	return isRecord(row) ? (row as SubagentAgentSettings) : {};
}

function parseMaxNestedSpawnDepth(setting: string, value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= -1) return value;
	throw new Error(`${setting} must be -1 (unlimited) or a non-negative integer; received ${String(value)}`);
}

/** The lane chain for an agent: its own lane first, then what it may spawn, then what THAT may spawn, for as long as the operator kept turning the next level */
export function subagentLaneChain(row: SubagentLaneSettings): SubagentLaneSettings[] {
	const chain: SubagentLaneSettings[] = [];
	// Bounded rather than `while (lane)`, because this walks a structure read
	// from a settings FILE. A hand-written or merged config can carry a node
	// that points at itself, and a settings read is not a place to hang.
	let lane: SubagentLaneSettings | undefined = row;
	for (let depth = 0; lane !== undefined && depth <= MAX_LANE_DEPTH; depth++) {
		chain.push(lane);
		lane = lane.subagents;
	}
	return chain;
}

/** The deepest lane an operator can build. Not a policy — a spawn ceiling is `enabled`, not this — but a settings file is untrusted input and a cycle in it */
const MAX_LANE_DEPTH = 64;

/** How deep `row` lets its agent's tree run, as the inclusive parent-depth cap {@link canSpawnAtDepth} takes. */
export function laneDepthOf(row: SubagentLaneSettings, blanketMax: number, agentName: string): number {
	if (row.subagents === undefined && row.maxNestedSpawnDepth !== undefined) {
		// The message has to name the row an operator can edit, so the agent is threaded in rather
		// than printed as a placeholder: a refusal pointing at `<agent>` sends them looking for a
		// key that is not in their file.
		return parseMaxNestedSpawnDepth(`subagent.agents.${agentName}.maxNestedSpawnDepth`, row.maxNestedSpawnDepth);
	}
	const chain = subagentLaneChain(row);
	for (let index = 1; index < chain.length; index++) {
		// Explicitly off: the cap is the depth above, and the blanket does not get
		// to widen a limit the operator set by hand.
		if (chain[index]?.enabled === false) return index - 1;
	}
	// Unlimited stays unlimited: it is not a number to take the larger of.
	if (blanketMax < 0) return blanketMax;
	return Math.max(chain.length - 1, blanketMax);
}

/** The absolute task depth at which `agentName` may still spawn. The agent's own lane chain answers first, because that is the screen the */
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

/** Resolve this live session's cap. Child sessions receive the already-resolved per-agent value without overwriting the blanket setting descendants inherit. */
export function resolveSessionMaxNestedSpawnDepth(settings: Settings, override?: number): number {
	return override === undefined
		? resolveSubagentMaxNestedSpawnDepth(settings)
		: parseMaxNestedSpawnDepth("session maxNestedSpawnDepth", override);
}

/** Whether an agent is spawnable with no row of its own. Only the end-to-end delegate ships enabled. The other bundled agents and */
export function subagentEnabledByDefault(agent: AgentDefinition): boolean {
	return currentAgentName(agent.name) === DEFAULT_ENABLED_BUNDLED_AGENT;
}

/** Whether `agent` is ENABLED: the model may choose it on its own initiative. ONE predicate, and the singular is the point. This used to be two -- */
export function isSubagentEnabled(settings: Settings, agent: AgentDefinition): boolean {
	return subagentSettingsFor(settings, agent.name).enabled ?? subagentEnabledByDefault(agent);
}

/** Filter a discovered agent list down to the ones the model may choose. */
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
	/** Turn-scoped user grants may expose an otherwise disabled agent to this one invocation. */
	isGranted?: (agentName: string) => boolean;
}

/** Resolve the one effective agent catalog shared by task, eval, and Vibe. Global enablement and each agent row are profile policy; the parent spawn */
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
	// Matched through a retirement as well, so a roster still carrying the old name yields it as the default rather than reporting that no default agent
	const defaultAgent =
		agents.find(agent => agent.name === spawnPolicy.defaultAgent) ??
		agents.find(agent => currentAgentName(agent.name) === spawnPolicy.defaultAgent);
	return { agents, defaultAgent: defaultAgent?.name, spawnPolicy };
}

/** How an agent's row reads on the agent surfaces. TWO states, because there are two. */
export type SubagentEnableState =
	/** The model may choose this agent. */
	| "on"
	/** The model may not. A `/` command that names it directly still runs (see the grant). */
	| "off";

/** The state above, for display in the Subagents settings tab. Takes the row value directly rather than reading settings, so an editor holding */
export function subagentEnableState(agent: AgentDefinition, configured: boolean | undefined): SubagentEnableState {
	return (configured ?? subagentEnabledByDefault(agent)) ? "on" : "off";
}

/** Whether this row is still on the shipped default rather than a choice someone made. Surfaces may render it as a "(default)" hint; it must never change what */
export function isSubagentEnableDefaulted(configured: boolean | undefined): boolean {
	return configured === undefined;
}

/** The words each state is shown as, owned here rather than by the Agents table that renders them, so the spawn path and the screen describing it cannot */
export const SUBAGENT_ENABLE_STATE_LABEL: Record<SubagentEnableState, string> = {
	on: "Enabled",
	off: "Disabled",
};

/** The value written when the operator toggles a row. A toggle, not a cycle. The old three-stop cycle (unset → on → off → unset) */
export function nextSubagentEnableValue(agent: AgentDefinition, configured: boolean | undefined): boolean {
	return !(configured ?? subagentEnabledByDefault(agent));
}

/** A live spawner that can report the agent types it accepts — the task tool. Declared here rather than imported from `task/index` so the system-prompt build */
export interface EnabledSubagentSource {
	readonly enabledAgentNames: string[];
}

/** The agent types a live task tool will accept, or `[]` when there is no task tool at all (delegation off, or recursion depth exhausted). */
export function enabledSubagentNames(spawner: unknown): string[] {
	return readNameList(spawner, "enabledAgentNames");
}

/** The agent type prose should name when it would rather have `preferred`. Prose that names an agent has to name one this session can actually spawn, */
export function preferredSubagentName(enabled: readonly string[], preferred: string): string | undefined {
	return enabled.includes(preferred) ? preferred : enabled[0];
}

/** Read one of the spawner's name lists defensively. The spawner is `unknown` because the prompt build receives whatever the tool registry holds, which */
function readNameList(spawner: unknown, key: keyof EnabledSubagentSource): string[] {
	const names = (spawner as Partial<EnabledSubagentSource> | undefined)?.[key];
	return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
}

/** Which setting decided a subagent's model. Shown next to the model on every agent surface. */
export type SubagentModelSource =
	/** A `subagent.agents.<name>` lane — the agent's own row, or a `subagents` level under it. The most specific layer there is: it names both the agent */
	| "lane"
	/** `subagent.modelByDepth.<n>` — the row for the depth this spawn runs at. */
	| "depth"
	/** `subagent.model` — the blanket subagent model setting. */
	| "blanket"
	/** The agent definition's `model:` frontmatter. */
	| "frontmatter"
	/** No setting named a model: the session's live model is inherited. */
	| "inherit";

/** A resolved subagent model: the patterns to try, and the layer that chose them. */
export interface ResolvedSubagentModel {
	/** Model patterns in preference order. Empty only when nothing at all resolved. */
	patterns: string[];
	source: SubagentModelSource;
	/** The spawn depth whose row decided, when `source` is "depth". */
	depth?: number;
	/** Set when a CONFIGURED pattern expanded to nothing (a role alias pointing at an unset role, or an empty value). The caller must surface this rather than */
	unresolved?: { source: SubagentModelSource; value: string; depth?: number };
}

/** Human-readable name of the setting behind a {@link SubagentModelSource}. For the `depth` layer, `depth` names the exact row (`subagent.modelByDepth.2`), */
export function subagentModelSourceLabel(source: SubagentModelSource, agentName: string, depth?: number): string {
	switch (source) {
		case "lane":
			// The path an operator can act on. Depth 0 is the agent's own row; below
			// that, one `.subagents` per level, which is exactly the sequence of
			// pages walked to set it.
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

/** Superseded per-agent fields, reported once each rather than once per spawn. Keyed by agent and field so a second agent's leftover row is still named. */
const reportedSupersededAgentFields = new Set<string>();

/** The per-agent row fields a newer shape replaced. `model` and `thinkingLevel` are NOT here. They were, while a lane had no page of its own and the */
export const SUPERSEDED_AGENT_ROW_FIELDS = ["maxNestedSpawnDepth"] as const;

export type SupersededAgentRowField = (typeof SUPERSEDED_AGENT_ROW_FIELDS)[number];

/** Where the value went, per superseded field. A record rather than a conditional so a new entry does not compile until its replacement is named: a report that points nowhere is worse than none. */
const SUPERSEDED_FIELD_REPLACEMENT: Record<SupersededAgentRowField, string> = {
	maxNestedSpawnDepth:
		"Open Subagents → Subagent Roster → that agent → Subagents and turn each level on or off; the chain is the ceiling.",
};

/** Report a `subagent.agents.<name>` row that still carries a superseded field. The value is still honored — a config written by an older release keeps meaning what it meant — */
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

/** Name every superseded field left anywhere in the `subagent.agents` table. Called from both resolvers so the report happens on the path that reads the */
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

/** Test seam: forget which superseded rows have been reported. */
export function resetSupersededAgentRowReports(): void {
	reportedSupersededAgentFields.clear();
}

/** The schema path of the per-depth model map. Exported so the surfaces that edit or summarize it never restate the literal: this module is the one */
export const SUBAGENT_MODEL_BY_DEPTH_PATH: SettingPath = "subagent.modelByDepth";

/** The dotted path of one depth row, which the settings chain picker edits in place. */
export function subagentModelByDepthRowPath(depth: number): SettingPath {
	// `settings.get`/`set`/`unset` resolve unregistered dotted sub-paths of a
	// record setting by splitting; the cast records that this path is a row of
	// the map, not a schema key of its own.
	return `${SUBAGENT_MODEL_BY_DEPTH_PATH}.${depth}` as SettingPath;
}

/** The stored map as a plain table, tolerating a non-record value the validator already reported. */
function readModelByDepthTable(settings: Settings): Record<string, unknown> {
	const table: unknown = settings.get(SUBAGENT_MODEL_BY_DEPTH_PATH);
	return isRecord(table) ? table : {};
}

/** One configured depth row, for the surfaces that list them. */
export interface SubagentModelByDepthRow {
	depth: number;
	value: string | string[];
}

/** The configured depth rows, shallowest first. Keys that can never be a depth and values that are not a chain are skipped: reporting them is the load-time */
export function subagentModelByDepthRows(settings: Settings): SubagentModelByDepthRow[] {
	const rows: SubagentModelByDepthRow[] = [];
	for (const [key, value] of Object.entries(readModelByDepthTable(settings))) {
		if (!isModelByDepthKey(key)) continue;
		if (typeof value !== "string" && !Array.isArray(value)) continue;
		rows.push({ depth: Number(key), value });
	}
	return rows.sort((a, b) => a.depth - b.depth);
}

/** The smallest spawn depth with no row yet, which is what "Add depth…" appends. */
export function nextSubagentModelByDepth(settings: Settings): number {
	const used = new Set(subagentModelByDepthRows(settings).map(row => row.depth));
	let depth = 1;
	while (used.has(depth)) depth++;
	return depth;
}

/** Remove one depth row. When it was the last, remove the map itself so the stored shape is the unset one rather than an empty table. */
export function clearSubagentModelByDepthRow(settings: Settings, depth: number): void {
	settings.unset(subagentModelByDepthRowPath(depth));
	if (subagentModelByDepthRows(settings).length === 0) settings.unset(SUBAGENT_MODEL_BY_DEPTH_PATH);
}

/** The map's row for `depth`, or undefined when the spawn's own depth has none. */
function readDepthModelRow(settings: Settings, depth: number): string | string[] | undefined {
	const value = readModelByDepthTable(settings)[String(depth)];
	return typeof value === "string" || Array.isArray(value) ? value : undefined;
}
/** The lane governing a spawn: the agent's own row at depth 0 or 1, and one `subagents` level deeper for each level below that. */
function laneForSpawn(
	settings: Settings,
	agentName: string,
	taskDepth: number | undefined,
): { chain: SubagentLaneSettings[]; index: number } {
	const chain = subagentLaneChain(subagentSettingsFor(settings, agentName));
	return { chain, index: Math.max(0, (taskDepth ?? 1) - 1) };
}

/** The lane layer for a spawn's model, or undefined when no lane on the way down names one. */
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

/** Resolve the model patterns one subagent runs, with the deciding layer. Precedence, highest first: */
export function resolveSubagentModel(options: {
	settings: Settings;
	agentName: string;
	/** The agent definition's `model:` frontmatter, if any. */
	agentModel?: string | string[];
	/** The session's active model pattern, used for inherit. */
	activeModelPattern?: string;
	/** Fallback when the session has no active model yet (headless start). */
	fallbackModelPattern?: string;
	/** The depth the SPAWNED agent will run at: the calling session's task depth plus one. A `subagent.modelByDepth` row applies only at depth >= 1 and */
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

/** Resolve a subagent's thinking level. Precedence, highest first, deliberately the same shape as {@link resolveSubagentModel} so one sentence describes both: */
export function resolveSubagentThinkingLevel(options: {
	settings: Settings;
	agentName: string;
	agentThinkingLevel?: ConfiguredThinkingLevel;
	/** The depth the SPAWNED agent runs at, as {@link resolveSubagentModel} takes it. */
	taskDepth?: number;
}): ConfiguredThinkingLevel | undefined {
	reportSupersededAgentRows(options.settings);
	const { chain, index } = laneForSpawn(options.settings, options.agentName, options.taskDepth);
	for (let level = Math.min(index, chain.length - 1); level >= 0; level--) {
		const raw = chain[level]?.thinkingLevel;
		if (raw === undefined) continue;
		const path = `subagent.agents.${options.agentName}${".subagents".repeat(level)}.thinkingLevel`;
		const parsed = parseConfiguredEffortSetting(path, raw);
		// An empty value is an explicit inherit rather than a level, and a value
		// naming no level was already reported by the parse. Both mean "this level
		// decides nothing", so the walk continues up rather than stopping here.
		if (parsed !== undefined) return parsed;
	}
	// Blanket BEFORE frontmatter, the same order {@link resolveSubagentModel} uses. This used to be the other way round, and bundled agents carry a
	const fromBlanket = parseConfiguredEffortSetting(
		"subagent.thinkingLevel",
		options.settings.get("subagent.thinkingLevel"),
	);
	if (fromBlanket !== undefined) return fromBlanket;
	return options.agentThinkingLevel;
}
