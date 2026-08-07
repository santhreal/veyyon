/**
 * The ONE reader for the `subagent.*` settings area.
 *
 * Every question about a spawned agent — may I delegate at all, does this agent
 * exist, what model and effort does it run, and which setting decided that — is
 * answered here. Before this module the answers were spread across the task tool,
 * the vibe runtime, the eval bridge and the agent dashboard, each re-deriving
 * precedence from its own arguments, which is how a per-agent override could
 * silently outrank the operator's subagent model on one path and not another.
 *
 * Import this instead of reading `subagent.*` keys directly.
 */

import { logger } from "@veyyon/utils";
import { resolveConfiguredModelPatterns } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { SubagentAgentSettings } from "../config/settings-domains/subagents";
import {
	DEFAULT_ENABLED_BUNDLED_AGENT,
	DEFAULT_SUBAGENT_IDLE_TTL_MS,
	DEFAULT_SUBAGENT_MAX_NESTED_SPAWN_DEPTH,
	DEFAULT_SUBAGENT_PARKED_CLOSE_MS,
	DEFAULT_SUBAGENT_WAITING_CLOSE_MS,
} from "../config/settings-domains/subagents";
import { CLI_THINKING_LEVELS, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import { currentAgentName, type ResolvedSpawnPolicy, resolveSpawnPolicy } from "./spawn-policy";
import type { AgentDefinition } from "./types";

/**
 * How hard this session pushes work out to subagents.
 *
 * Every value here still ALLOWS delegation. `allowed` is the floor: the model keeps
 * the task tool and spawns a subagent when that is the sensible move, it is simply
 * not asked to. Taking the ability away is a different question and a different
 * setting, {@link subagentsEnabled}. There used to be an `off` value here, which made
 * one setting answer both questions and left no way to say "you may, but I am not
 * asking you to" — the state most sessions actually want.
 */
export type DelegationStrength = "allowed" | "preferred" | "required";

/** Resolved delegation strength (`subagent.delegation`). */
export function delegationStrength(settings: Settings): DelegationStrength {
	return (settings.get("subagent.delegation") ?? "preferred") as DelegationStrength;
}

/**
 * Whether subagents exist at all in this session (`subagent.enabled`).
 *
 * The one kill switch. False removes the task tool and every delegation section from
 * the prompt; the delegation strength and the agents table are kept and take effect
 * again when it is turned back on.
 */
export function subagentsEnabled(settings: Settings): boolean {
	return settings.get("subagent.enabled") ?? true;
}

/**
 * Resolve how long a finished subagent remains live before parking.
 *
 * This lifecycle budget is intentionally model-independent. Provider cache
 * policies may change request economics, but they do not justify retaining a
 * completed agent process past the operator's configured limit.
 */
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

/**
 * Resolve when a PARKED subagent stops being listed at all.
 *
 * Parking already released the session; this is the second stage, and without it a
 * long session accumulates every finished agent in `irc list` and the Control
 * Center forever. Disabled (`subagent.autoClose.enabled` off) resolves to zero
 * budgets, which the lifecycle manager reads as "never close", so the operator's
 * off switch is a real off switch rather than a very long timer.
 *
 * A waiting agent gets its own budget because it stopped on purpose to let a peer
 * finish: closing it on the ordinary timer would drop the one agent most likely to
 * be messaged next. The waiting budget is floored at the ordinary one, so a
 * misconfiguration can only ever lengthen a waiting agent's grace, never shorten
 * it below a quiet agent's.
 */
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

/**
 * True when the task tool is offered at all: deliberately the MASTER SWITCH
 * ({@link subagentsEnabled}) and nothing more.
 *
 * The name reads like "delegation can happen", which is a DIFFERENT question:
 * that one also needs an enabled agent type, and its answer is
 * {@link resolveDelegation}`(...).possible`. This one exists for tool PRESENCE,
 * where the wider question would be wrong: the task tool stays built with every
 * agent row disabled so a `/` command can grant one for a turn. Ask
 * {@link resolveDelegation} for anything model-facing, and this only when the
 * subject is whether the tool is offered.
 */
export function delegationEnabled(settings: Settings): boolean {
	return subagentsEnabled(settings);
}

/**
 * Why delegation cannot happen, when it cannot.
 *
 * Two settings can each stop it on their own, and an operator staring at one of
 * them has no way to know the other is the reason nothing delegates — so every
 * surface that reports "no delegation" reports which.
 */
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

/**
 * Resolve delegation from BOTH settings that decide it, in one place.
 *
 * `subagent.delegation` and the `subagent.agents` table are one question with two
 * inputs, and computing them apart produced a pair of states that each looked
 * right alone and were incoherent together: `required` with every agent disabled
 * still injected a first-turn "delegate substantial work" reminder, telling the
 * model to hand work to nothing it was allowed to spawn. Strength decides HOW
 * HARD to push; the agent table decides whether there is anywhere to push it. If
 * there is nowhere, the strength cannot matter, and `preferred`/`required` come
 * back false however hard the setting is turned up.
 *
 * The enabled set is passed in rather than re-derived here: the live `task` tool
 * already filtered its discovered agents through `subagent.agents`, and a second
 * derivation could name an agent the tool then refuses.
 */
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

/**
 * One sentence saying why nothing will be delegated, for a settings surface.
 *
 * Returns `undefined` when delegation is possible, so a caller renders it or
 * does not without asking a second question. Every surface that shows either
 * setting shows this, which is what makes each setting visibly the other's
 * effect rather than an isolated control with an arbitrary-looking value.
 */
export function delegationBlockedNotice(state: DelegationState): string | undefined {
	if (state.blockedBy === "subagents-off") {
		return "Subagents are off, so nothing here runs until you turn them back on.";
	}
	if (state.blockedBy === "no-enabled-agents") {
		return `No agent is enabled, so there is nothing to delegate to and "${state.strength}" has no effect.`;
	}
	return undefined;
}

/**
 * The `subagent.agents` row for `name`, or an empty row when unconfigured.
 *
 * Defends against a missing table as well as a missing row: the schema default is
 * `{}`, but a caller can hold settings that answer `undefined` for everything (the
 * test stub does, and so does a read of a path the running build has not
 * registered), and indexing `undefined` here took down the whole Agents table
 * with "undefined is not an object" where an empty row is the right answer.
 */
export function subagentSettingsFor(settings: Settings, name: string): SubagentAgentSettings {
	const table = settings.get("subagent.agents") as Record<string, SubagentAgentSettings> | undefined;
	// A row written under a retired name still governs the agent that replaced it.
	// Without this an operator who had pinned a model on `subagent.agents.task`
	// would keep the row in their config and silently stop getting the model.
	const row = table?.[name] ?? table?.[currentAgentName(name)];
	return row && typeof row === "object" ? row : {};
}

function parseMaxNestedSpawnDepth(setting: string, value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= -1) return value;
	throw new Error(`${setting} must be -1 (unlimited) or a non-negative integer; received ${String(value)}`);
}

/**
 * Resolve the absolute task depth at which `agentName` may still spawn.
 * A per-agent row wins over the blanket limit. Zero means the root may spawn
 * direct children, while a child at task depth 1 cannot spawn again.
 */
export function resolveSubagentMaxNestedSpawnDepth(settings: Settings, agentName?: string): number {
	const rowValue = agentName === undefined ? undefined : subagentSettingsFor(settings, agentName).maxNestedSpawnDepth;
	if (rowValue !== undefined) {
		return parseMaxNestedSpawnDepth(`subagent.agents.${agentName}.maxNestedSpawnDepth`, rowValue);
	}
	const blanket = settings.get("subagent.maxNestedSpawnDepth");
	return blanket === undefined
		? DEFAULT_SUBAGENT_MAX_NESTED_SPAWN_DEPTH
		: parseMaxNestedSpawnDepth("subagent.maxNestedSpawnDepth", blanket);
}

/**
 * Resolve this live session's cap. Child sessions receive the already-resolved
 * per-agent value without overwriting the blanket setting descendants inherit.
 */
export function resolveSessionMaxNestedSpawnDepth(settings: Settings, override?: number): number {
	return override === undefined
		? resolveSubagentMaxNestedSpawnDepth(settings)
		: parseMaxNestedSpawnDepth("session maxNestedSpawnDepth", override);
}

/**
 * Whether an agent is spawnable with no row of its own.
 *
 * Only the end-to-end delegate ships enabled. The other bundled agents and
 * user-authored agents are opt-in through onboarding or Settings → Subagents →
 * Agents. Creating an agent definition makes it available to enable; it does
 * not grant the model permission to start it on its own.
 *
 * Compared after following a retirement, so an agent still carrying the old
 * name is enabled exactly when the one that replaced it is. Resolving the name
 * in `getAgent` but not here would give the worst outcome available: the spawn
 * finds the agent and is then refused as not enabled.
 */
export function subagentEnabledByDefault(agent: AgentDefinition): boolean {
	return currentAgentName(agent.name) === DEFAULT_ENABLED_BUNDLED_AGENT;
}

/**
 * Whether `agent` is ENABLED: the model may choose it on its own initiative.
 *
 * ONE predicate, and the singular is the point. This used to be two --
 * `isSubagentAdvertised` (listed in the task tool description) and
 * `isSubagentSpawnable` (honored when named outright) -- and the gap between them
 * was a user-visible state reading "Not offered (default) -- still runs when
 * named". A switch labelled off that still runs is not a switch, it is a
 * footnote, and it forced the settings copy to apologise for itself.
 *
 * The rule is now the one a reader already assumes: enabled means the model may
 * pick this agent, disabled means it may not, and being disabled is the whole
 * story. What a disabled agent does NOT block is the user: an ephemeral `/`
 * command that names an agent is the operator asking directly, and that is
 * granted per turn by the command itself (see `agentGrantedThisTurn` on the tool
 * session). A setting that governs the model does not govern the person typing.
 *
 * This is also the token-cost switch, unchanged: a disabled agent costs nothing
 * because it never reaches the tool description.
 */
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

/**
 * Resolve the one effective agent catalog shared by task, eval, and Vibe.
 *
 * Global enablement and each agent row are profile policy; the parent spawn
 * declaration is a recursion capability. Keeping their intersection here makes
 * model-visible lists, defaults, and execution checks use the same answer.
 */
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
	// Matched through a retirement as well, so a roster still carrying the old
	// name yields it as the default rather than reporting that no default agent
	// exists. The name returned is the one the roster actually holds, because
	// every later lookup and error message quotes it back.
	const defaultAgent =
		agents.find(agent => agent.name === spawnPolicy.defaultAgent) ??
		agents.find(agent => currentAgentName(agent.name) === spawnPolicy.defaultAgent);
	return { agents, defaultAgent: defaultAgent?.name, spawnPolicy };
}

/**
 * How an agent's row reads on the agent surfaces. TWO states, because there are
 * two.
 *
 * There were four: `on`, `off`, `default-on`, `default-off`. The two `default-*`
 * entries encoded "no row of its own", which is a fact about the SETTINGS FILE,
 * not about what the agent will do, and pairing it with a distinct behaviour is
 * what produced the state a user read as "off but not off". Whether a value came
 * from a row or from the shipped default is now a separate boolean the surfaces
 * may show as a "(default)" hint; it never changes the answer.
 */
export type SubagentEnableState =
	/** The model may choose this agent. */
	| "on"
	/** The model may not. A `/` command that names it directly still runs (see the grant). */
	| "off";

/**
 * The state above, for display in the Subagents settings tab.
 *
 * Takes the row value directly rather than reading settings, so an editor holding
 * an unsaved value gets the same answer as the saved one — a second copy of this
 * mapping inside the editor is how the UI and the spawn path drifted apart
 * before. Pass `subagentSettingsFor(settings, name).enabled` when you have
 * settings in hand.
 */
export function subagentEnableState(agent: AgentDefinition, configured: boolean | undefined): SubagentEnableState {
	return (configured ?? subagentEnabledByDefault(agent)) ? "on" : "off";
}

/**
 * Whether this row is still on the shipped default rather than a choice someone
 * made. Surfaces may render it as a "(default)" hint; it must never change what
 * the agent does, which is the mistake the old `default-off` state made.
 */
export function isSubagentEnableDefaulted(configured: boolean | undefined): boolean {
	return configured === undefined;
}

/**
 * The words each state is shown as, owned here rather than by the Agents table
 * that renders them, so the spawn path and the screen describing it cannot
 * describe the same row differently.
 */
export const SUBAGENT_ENABLE_STATE_LABEL: Record<SubagentEnableState, string> = {
	on: "Enabled",
	off: "Disabled",
};

/**
 * The value written when the operator toggles a row.
 *
 * A toggle, not a cycle. The old three-stop cycle (unset → on → off → unset)
 * existed because "unset" was a third BEHAVIOUR; now it is only a provenance
 * hint, so cycling back to it would be a keypress that changes nothing visible
 * and is indistinguishable from the toggle failing. Toggling always writes an
 * explicit value, which is also what makes the choice survive a change to the
 * shipped default.
 */
export function nextSubagentEnableValue(agent: AgentDefinition, configured: boolean | undefined): boolean {
	return !(configured ?? subagentEnabledByDefault(agent));
}

/**
 * A live spawner that can report the agent types it accepts — the task tool.
 *
 * Declared here rather than imported from `task/index` so the system-prompt build
 * can ask the question without pulling the whole tool (and its executor) into the
 * startup path.
 */
export interface EnabledSubagentSource {
	readonly enabledAgentNames: string[];
}

/**
 * The agent types a live task tool will accept, or `[]` when there is no task
 * tool at all (delegation off, or recursion depth exhausted).
 *
 * The tool is the authority because it holds the discovered set: a project agent
 * directory changes what exists, and `subagent.agents` changes what is spawnable.
 * Re-deriving either at prompt-build time would let the prompt name an agent the
 * tool then refuses.
 */
export function enabledSubagentNames(spawner: unknown): string[] {
	return readNameList(spawner, "enabledAgentNames");
}

/**
 * The agent type prose should name when it would rather have `preferred`.
 *
 * Prose that names an agent has to name one this session can actually spawn,
 * and a literal cannot do that: the enabled set is operator-configurable, so a
 * hardcoded name is correct only for an operator who happens to have that agent
 * on. Plan mode's research step named `task` unconditionally, which survived the
 * rename to `deep` as a reference to a name no roster carries, and which pointed
 * the model at a disabled agent whenever the operator had enabled anything else:
 * the spawn was then refused by the same enablement check the sentence had just
 * talked the model past.
 *
 * `undefined` when nothing is enabled, so a caller suppresses the sentence
 * instead of interpolating a name that does not exist. Callers gate the prose on
 * this result rather than on a separate emptiness test, which is what keeps the
 * two from disagreeing.
 */
export function preferredSubagentName(enabled: readonly string[], preferred: string): string | undefined {
	return enabled.includes(preferred) ? preferred : enabled[0];
}

/**
 * Read one of the spawner's name lists defensively.
 *
 * The spawner is `unknown` because the prompt build receives whatever the tool registry holds, which
 * may be a test stub, a tool from a build that predates the property, or nothing at all. Every element
 * is type-checked rather than trusted, so a malformed list degrades to the names that ARE strings
 * instead of putting `undefined` into prompt prose.
 */
function readNameList(spawner: unknown, key: keyof EnabledSubagentSource): string[] {
	const names = (spawner as Partial<EnabledSubagentSource> | undefined)?.[key];
	return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
}

/** Which setting decided a subagent's model. Shown next to the model on every agent surface. */
export type SubagentModelSource =
	/** `subagent.model` — the one subagent model setting. */
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
	/**
	 * Set when a CONFIGURED pattern expanded to nothing (a role alias pointing at
	 * an unset role, or an empty value). The caller must surface this rather than
	 * fall through to the next layer.
	 */
	unresolved?: { source: SubagentModelSource; value: string };
}

/** Human-readable name of the setting behind a {@link SubagentModelSource}. */
export function subagentModelSourceLabel(source: SubagentModelSource, agentName: string): string {
	switch (source) {
		case "blanket":
			return "subagent.model";
		case "frontmatter":
			return `${agentName} agent frontmatter`;
		case "inherit":
			return "inherited from the session model";
	}
}

/**
 * Retired per-agent fields, reported once each rather than once per spawn.
 * Keyed by agent and field so a second agent's leftover row is still named.
 */
const reportedRetiredAgentFields = new Set<string>();

/**
 * Report a `subagent.agents.<name>` row that still carries `model` or
 * `thinkingLevel`.
 *
 * Those two fields were removed: model and effort for every subagent are now
 * decided by the one subagent setting (`subagent.model`, whose entries carry
 * their own `:effort`) plus the agent file's own frontmatter. A leftover row is
 * a value the operator can still see in their config and that no longer
 * governs anything, which is the exact shape of a setting that looks configured
 * and does nothing — so it is said out loud instead of dropped in silence.
 */
function reportRetiredAgentRowField(agentName: string, field: "model" | "thinkingLevel", value: unknown): void {
	const key = `${agentName}.${field}`;
	if (reportedRetiredAgentFields.has(key)) return;
	reportedRetiredAgentFields.add(key);
	const replacement =
		field === "model"
			? "Set Subagents → Subagent Model, or the agent file's own `model:` frontmatter."
			: "Set the effort on the Subagent Model entry (`model:effort`), Subagents → Subagent Effort, or the agent file's own `thinking-level:` frontmatter.";
	logger.warn(
		`Settings: subagent.agents.${agentName}.${field} is "${String(value)}", which is no longer read — ` +
			`per-agent model and effort were unified into the subagent model setting. ${replacement}`,
		{ setting: `subagent.agents.${agentName}.${field}`, value },
	);
}

/**
 * Name any retired field left on an agent's row. Called from both resolvers so
 * the report happens on the path that would previously have honored the value.
 *
 * A blank field is what a cleared row leaves behind and what the old pickers'
 * Inherit rows stored, so it is not a value anyone is losing and gets no report.
 */
function reportRetiredAgentRow(settings: Settings, agentName: string): void {
	const row = subagentSettingsFor(settings, agentName) as SubagentAgentSettings & {
		model?: unknown;
		thinkingLevel?: unknown;
	};
	for (const field of ["model", "thinkingLevel"] as const) {
		const value = row[field];
		if (value === undefined || (typeof value === "string" && value.trim().length === 0)) continue;
		reportRetiredAgentRowField(agentName, field, value);
	}
}

/** Test seam: forget which retired rows have been reported. */
export function resetRetiredAgentRowReports(): void {
	reportedRetiredAgentFields.clear();
}

/**
 * Resolve the model patterns one subagent runs, with the deciding layer.
 *
 * Precedence, highest first:
 *  1. `subagent.model` — the one subagent model setting, which every enabled
 *     subagent follows and whose entries carry their own `:effort`.
 *  2. The agent definition's `model:` frontmatter, which for a user-authored
 *     agent is that author's deliberate choice.
 *  3. Inherit the session's live model.
 *
 * There is deliberately no per-agent settings layer. `subagent.agents.<name>.model`
 * used to sit above all of these and was editable from one screen while the
 * blanket model was editable from another, so the Agents table quietly outranked
 * the setting the operator had just changed. Model and effort are now decided in
 * ONE place; the Agents table decides only whether a lane is offered, and an
 * agent that wants its own model says so in its own file.
 *
 * A configured layer that expands to NOTHING does not fall through: it comes back
 * as `unresolved` so the caller can refuse to spawn and say which setting is
 * wrong. Silently dropping to the next layer is what made "I changed the subagent
 * model" look like it did nothing, while bundled frontmatter roles decided
 * instead.
 *
 * Bundled specialists intentionally carry no `model:` frontmatter, so on a stock
 * install every subagent lands on case 3 and runs the model the operator is
 * looking at.
 */
export function resolveSubagentModel(options: {
	settings: Settings;
	agentName: string;
	/** The agent definition's `model:` frontmatter, if any. */
	agentModel?: string | string[];
	/** The session's active model pattern, used for inherit. */
	activeModelPattern?: string;
	/** Fallback when the session has no active model yet (headless start). */
	fallbackModelPattern?: string;
}): ResolvedSubagentModel {
	const { settings, agentName, agentModel, activeModelPattern, fallbackModelPattern } = options;

	reportRetiredAgentRow(settings, agentName);
	const layers: Array<{ source: SubagentModelSource; value: string | string[] | undefined }> = [
		{ source: "blanket", value: settings.get("subagent.model") },
		{ source: "frontmatter", value: agentModel },
	];

	for (const layer of layers) {
		const raw = Array.isArray(layer.value) ? layer.value : layer.value?.trim();
		if (raw === undefined || (typeof raw === "string" && raw.length === 0)) continue;
		if (Array.isArray(raw) && raw.length === 0) continue;
		const patterns = resolveConfiguredModelPatterns(raw, settings);
		if (patterns.length > 0) return { patterns, source: layer.source };
		return {
			patterns: [],
			source: layer.source,
			unresolved: { source: layer.source, value: Array.isArray(raw) ? raw.join(",") : raw },
		};
	}

	const inherited = activeModelPattern?.trim() || fallbackModelPattern?.trim() || "";
	return { patterns: resolveConfiguredModelPatterns(inherited, settings), source: "inherit" };
}

/**
 * Effort values already reported as unusable, so the warning is said once per
 * process instead of once per spawn. Keyed by setting and value, so a second
 * agent with a different typo is still reported.
 */
const reportedBadEfforts = new Set<string>();

/**
 * Report a configured effort that names no level. Unparseable resolves to
 * "inherit", which is indistinguishable from having set nothing — the setting
 * looks configured and does nothing, so it has to be said out loud (Law 10).
 * Never guesses a neighbouring level: running at an effort nobody chose would be
 * worse than inheriting.
 */
function reportUnusableEffort(setting: string, value: string): void {
	const key = `${setting}=${value}`;
	if (reportedBadEfforts.has(key)) return;
	reportedBadEfforts.add(key);
	logger.warn(
		`Settings: ${setting} is "${value}", which is not an effort level, so it is being ignored and the session's effort is inherited. ` +
			`Accepted values: ${CLI_THINKING_LEVELS.join(", ")}.`,
		{ setting, value, accepted: CLI_THINKING_LEVELS },
	);
}

/** Parse one configured effort, reporting a value that names no level. */
function parseEffortSetting(setting: string, value: unknown): ConfiguredThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	// Absent and blank both mean inherit, and neither is a mistake worth reporting:
	// blank is exactly what the picker's Inherit row stores.
	if (trimmed.length === 0) return undefined;
	const parsed = parseConfiguredThinkingLevel(trimmed);
	if (parsed === undefined) reportUnusableEffort(setting, trimmed);
	return parsed;
}

/**
 * Resolve a subagent's thinking level. Precedence, highest first, deliberately
 * the same shape as {@link resolveSubagentModel} so one sentence describes both:
 *
 *  1. `subagent.thinkingLevel` — the one subagent effort setting.
 *  2. the agent definition's `thinking-level` frontmatter.
 *  3. undefined — inherit the session's effort.
 *
 * An explicit `:level` suffix on the resolved model pattern still outranks all of
 * these; the executor applies that, since only it knows whether the suffix was
 * present (see `resolveEffectiveSubagentThinkingLevel`).
 *
 * There is no per-agent settings layer, for the reason spelled out on
 * {@link resolveSubagentModel}: effort is decided in one place, and an agent that
 * wants its own effort declares `thinking-level` in its own file.
 *
 * A configured value that names no level does not silently become "inherited":
 * it is reported with the setting and the accepted values, then skipped, so the
 * next layer decides. Guessing a neighbouring level instead would run the agent
 * at an effort nobody chose.
 */
export function resolveSubagentThinkingLevel(options: {
	settings: Settings;
	agentName: string;
	agentThinkingLevel?: ConfiguredThinkingLevel;
}): ConfiguredThinkingLevel | undefined {
	reportRetiredAgentRow(options.settings, options.agentName);
	// Blanket BEFORE frontmatter, the same order {@link resolveSubagentModel} uses.
	// This used to be the other way round, and bundled agents carry a
	// `thinking-level` even though they carry no `model:` (scout `medium`,
	// librarian `minimal`), so "Subagent Effort" did nothing for exactly those
	// agents — an operator setting outranked by bundled frontmatter, which is the
	// defect this whole area exists to remove, surviving in the effort axis.
	const fromBlanket = parseEffortSetting("subagent.thinkingLevel", options.settings.get("subagent.thinkingLevel"));
	if (fromBlanket !== undefined) return fromBlanket;
	return options.agentThinkingLevel;
}
