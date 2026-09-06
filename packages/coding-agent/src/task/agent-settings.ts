/**
 * The ONE reader for the `agent.*` settings area.
 *
 * Every question about a spawned agent — may I delegate at all, does this agent
 * exist, what model and effort does it run, and which setting decided that — is
 * answered here. Before this module the answers were spread across the task tool,
 * the vibe runtime, the eval bridge and the agent dashboard, each re-deriving
 * precedence from its own arguments, which is how a per-agent override could
 * silently outrank the operator's agent model on one path and not another.
 *
 * Import this instead of reading `agent.*` keys directly.
 */

import { ThinkingLevel } from "@veyyon/agent-core/thinking";
import { isRecord, logger } from "@veyyon/utils";
import { parseConfiguredEffortSetting } from "../config/effort-resolver";
import { resolveConfiguredModelPatterns } from "../config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "../config/model-roles";
import type { SettingPath, Settings } from "../config/settings";
import type { AgentLaneSettings, AgentSettings } from "../config/settings-domains/agents";
import {
	DEFAULT_AGENT_IDLE_TTL_MS,
	DEFAULT_AGENT_MAX_NESTED_SPAWN_DEPTH,
	DEFAULT_AGENT_PRUNE_MS,
	DEFAULT_AGENT_WAITING_PRUNE_MS,
	DEFAULT_ENABLED_BUNDLED_AGENT,
} from "../config/settings-domains/agents";
import type { ConfiguredThinkingLevel } from "../thinking";
import { currentAgentName, type ResolvedSpawnPolicy, resolveSpawnPolicy } from "./spawn-policy";
import type { AgentDefinition } from "./types";

/**
 * How hard this session pushes work out to agents.
 *
 * Every value here still ALLOWS delegation. `allowed` is the floor: the model keeps
 * the task tool and spawns an agent when that is the sensible move, it is simply
 * not asked to. Taking the ability away is a different question and a different
 * setting, {@link agentsEnabled}. There used to be an `off` value here, which made
 * one setting answer both questions and left no way to say "you may, but I am not
 * asking you to" — the state most sessions actually want.
 */
export type DelegationStrength = "allowed" | "preferred" | "required";

/** Resolved delegation strength (`agent.delegation`). */
export function delegationStrength(settings: Settings): DelegationStrength {
	return (settings.get("agent.delegation") ?? "preferred") as DelegationStrength;
}

/**
 * Whether agents exist at all in this session (`agent.enabled`).
 *
 * The one kill switch. False removes the task tool and every delegation section from
 * the prompt; the delegation strength and the agents table are kept and take effect
 * again when it is turned back on.
 */
export function agentsEnabled(settings: Settings): boolean {
	return settings.get("agent.enabled") ?? true;
}

/**
 * Resolve how long a finished agent remains live before parking.
 *
 * This lifecycle budget is intentionally model-independent. Provider cache
 * policies may change request economics, but they do not justify retaining a
 * completed agent process past the operator's configured limit.
 */
export function resolveAgentIdleTtlMs(settings: Settings): number {
	const configured = Number(settings.get("agent.idleTtlMs") ?? DEFAULT_AGENT_IDLE_TTL_MS);
	if (!Number.isFinite(configured)) return DEFAULT_AGENT_IDLE_TTL_MS;
	return Math.max(0, Math.trunc(configured));
}

/** How long a parked agent survives before it is closed, by whether it was waiting. */
export interface AgentPruneBudget {
	/** Ordinary parked agent. 0 disables closing entirely. */
	afterMs: number;
	/** Parked agent whose last message said it was waiting on another agent. */
	waitingAfterMs: number;
}

/**
 * Resolve when a PARKED agent stops being listed at all.
 *
 * Parking already released the session; this is the second stage, and without it a
 * long session accumulates every finished agent in `irc list` and the Control
 * Center forever. Disabled (`agent.prune.enabled` off) resolves to zero
 * budgets, which the lifecycle manager reads as "never close", so the operator's
 * off switch is a real off switch rather than a very long timer.
 *
 * A waiting agent gets its own budget because it stopped on purpose to let a peer
 * finish: closing it on the ordinary timer would drop the one agent most likely to
 * be messaged next. The waiting budget is floored at the ordinary one, so a
 * misconfiguration can only ever lengthen a waiting agent's grace, never shorten
 * it below a quiet agent's.
 */
export function resolveAgentPruneBudget(settings: Settings): AgentPruneBudget {
	if ((settings.get("agent.prune.enabled") ?? true) !== true) {
		return { afterMs: 0, waitingAfterMs: 0 };
	}
	const readMs = (path: "agent.prune.afterMs" | "agent.prune.waitingAfterMs", fallback: number): number => {
		const configured = Number(settings.get(path) ?? fallback);
		if (!Number.isFinite(configured)) return fallback;
		return Math.max(0, Math.trunc(configured));
	};
	const afterMs = readMs("agent.prune.afterMs", DEFAULT_AGENT_PRUNE_MS);
	const waitingAfterMs = readMs("agent.prune.waitingAfterMs", DEFAULT_AGENT_WAITING_PRUNE_MS);
	// A zero parked budget means "never close", so a waiting budget cannot revive
	// closing for the waiting case alone.
	if (afterMs === 0) return { afterMs: 0, waitingAfterMs: 0 };
	return { afterMs, waitingAfterMs: Math.max(afterMs, waitingAfterMs) };
}

/**
 * True when the task tool is offered at all: deliberately the MASTER SWITCH
 * ({@link agentsEnabled}) and nothing more.
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
	return agentsEnabled(settings);
}

/**
 * Why delegation cannot happen, when it cannot.
 *
 * Two settings can each stop it on their own, and an operator staring at one of
 * them has no way to know the other is the reason nothing delegates — so every
 * surface that reports "no delegation" reports which.
 */
export type DelegationBlocker = "agents-off" | "no-enabled-agents";

/** Delegation as one resolved answer, from both settings that decide it. */
export interface DelegationState {
	strength: DelegationStrength;
	/** Agent types the model may choose, in discovery order. */
	enabledAgents: readonly string[];
	/** Delegation can actually happen: the tool is offered AND something can take the work. */
	possible: boolean;
	/** The prompt should push substantial work out to an agent. */
	preferred: boolean;
	/** A first-turn reminder to delegate is injected as well. */
	required: boolean;
	/** Set exactly when `possible` is false. */
	blockedBy?: DelegationBlocker;
}

/**
 * Resolve delegation from BOTH settings that decide it, in one place.
 *
 * `agent.delegation` and the `agent.agents` table are one question with two
 * inputs, and computing them apart produced a pair of states that each looked
 * right alone and were incoherent together: `required` with every agent disabled
 * still injected a first-turn "delegate substantial work" reminder, telling the
 * model to hand work to nothing it was allowed to spawn. Strength decides HOW
 * HARD to push; the agent table decides whether there is anywhere to push it. If
 * there is nowhere, the strength cannot matter, and `preferred`/`required` come
 * back false however hard the setting is turned up.
 *
 * The enabled set is passed in rather than re-derived here: the live `task` tool
 * already filtered its discovered agents through `agent.agents`, and a second
 * derivation could name an agent the tool then refuses.
 */
export function resolveDelegation(settings: Settings, enabledAgents: readonly string[]): DelegationState {
	const strength = delegationStrength(settings);
	const blockedBy: DelegationBlocker | undefined = !agentsEnabled(settings)
		? "agents-off"
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
	if (state.blockedBy === "agents-off") {
		return "Agents are off, so nothing here runs until you turn them back on.";
	}
	if (state.blockedBy === "no-enabled-agents") {
		return `No agent is enabled, so there is nothing to delegate to and "${state.strength}" has no effect.`;
	}
	return undefined;
}

/**
 * The `agent.agents` row for `name`, or an empty row when unconfigured.
 *
 * Defends against a missing table as well as a missing row: the schema default is
 * `{}`, but a caller can hold settings that answer `undefined` for everything (the
 * test stub does, and so does a read of a path the running build has not
 * registered), and indexing `undefined` here took down the whole Agents table
 * with "undefined is not an object" where an empty row is the right answer.
 */
export function agentSettingsFor(settings: Settings, name: string): AgentSettings {
	const table = settings.get("agent.agents") as Record<string, AgentSettings> | undefined;
	// A row written under a retired name still governs the agent that replaced it.
	// Without this an operator who had pinned a model on `agent.agents.task`
	// would keep the row in their config and silently stop getting the model.
	const row = table?.[name] ?? table?.[currentAgentName(name)];
	return isRecord(row) ? (row as AgentSettings) : {};
}

function parseMaxNestedSpawnDepth(setting: string, value: unknown): number {
	if (typeof value === "number" && Number.isInteger(value) && value >= -1) return value;
	throw new Error(`${setting} must be -1 (unlimited) or a non-negative integer; received ${String(value)}`);
}

/**
 * The lane chain for an agent: its own lane first, then what it may spawn, then
 * what THAT may spawn, for as long as the operator kept turning the next level
 * on.
 *
 * The chain stops at the first level that is absent, and absent is not a
 * decision: a fresh roster row has no `agents` child at all, so the blanket
 * ceiling still answers for every level below it.
 */
export function agentLaneChain(row: AgentLaneSettings): AgentLaneSettings[] {
	const chain: AgentLaneSettings[] = [];
	// Bounded rather than `while (lane)`, because this walks a structure read
	// from a settings FILE. A hand-written or merged config can carry a node
	// that points at itself, and a settings read is not a place to hang.
	let lane: AgentLaneSettings | undefined = row;
	for (let depth = 0; lane !== undefined && depth <= MAX_LANE_DEPTH; depth++) {
		chain.push(lane);
		lane = lane.agents;
	}
	return chain;
}

/**
 * The deepest lane an operator can build. Not a policy — a spawn ceiling is
 * `enabled`, not this — but a settings file is untrusted input and a cycle in it
 * must cost a bounded walk rather than the process.
 */
const MAX_LANE_DEPTH = 64;

/**
 * How deep `row` lets its agent's tree run, as the inclusive parent-depth cap
 * {@link canSpawnAtDepth} takes.
 *
 * Lane index `i` is the process at task depth `i + 1`: index 0 is the agent
 * itself, index 1 what it spawns. So a process at depth `d` may spawn exactly
 * when lane index `d` is enabled, and the cap is the last index reached before
 * a lane says `false`.
 *
 * Where the chain STOPS, nothing is written, and the blanket ceiling answers
 * from there down — which is what keeps a stock install unchanged: a roster row
 * with no `agents` child is not a decision to forbid nesting, it is the
 * absence of one.
 *
 * A row carrying only the pre-tree number is that number: it meant the same
 * cap, so a config written by the previous release still means what it meant.
 */
export function laneDepthOf(row: AgentLaneSettings, blanketMax: number, agentName: string): number {
	if (row.agents === undefined && row.maxNestedSpawnDepth !== undefined) {
		// The message has to name the row an operator can edit, so the agent is threaded in rather
		// than printed as a placeholder: a refusal pointing at `<agent>` sends them looking for a
		// key that is not in their file.
		return parseMaxNestedSpawnDepth(`agent.agents.${agentName}.maxNestedSpawnDepth`, row.maxNestedSpawnDepth);
	}
	const chain = agentLaneChain(row);
	for (let index = 1; index < chain.length; index++) {
		// Explicitly off: the cap is the depth above, and the blanket does not get
		// to widen a limit the operator set by hand.
		if (chain[index]?.enabled === false) return index - 1;
	}
	// Unlimited stays unlimited: it is not a number to take the larger of.
	if (blanketMax < 0) return blanketMax;
	return Math.max(chain.length - 1, blanketMax);
}

/**
 * The absolute task depth at which `agentName` may still spawn.
 *
 * The agent's own lane chain answers first, because that is the screen the
 * operator edits: `deep → Agents → Enabled` is the control, and the number
 * here is read off it. Only an agent with NO chain and no migrated number is
 * the blanket ceiling's answer alone.
 */
export function resolveAgentMaxNestedSpawnDepth(settings: Settings, agentName?: string): number {
	const blanket = settings.get("agent.maxNestedSpawnDepth");
	const blanketMax =
		blanket === undefined
			? DEFAULT_AGENT_MAX_NESTED_SPAWN_DEPTH
			: parseMaxNestedSpawnDepth("agent.maxNestedSpawnDepth", blanket);
	if (agentName === undefined) return blanketMax;
	const row = agentSettingsFor(settings, agentName);
	if (row.agents === undefined && row.maxNestedSpawnDepth === undefined) return blanketMax;
	return laneDepthOf(row, blanketMax, agentName);
}

/**
 * Resolve this live session's cap. Child sessions receive the already-resolved
 * per-agent value without overwriting the blanket setting descendants inherit.
 */
export function resolveSessionMaxNestedSpawnDepth(settings: Settings, override?: number): number {
	return override === undefined
		? resolveAgentMaxNestedSpawnDepth(settings)
		: parseMaxNestedSpawnDepth("session maxNestedSpawnDepth", override);
}

/**
 * Whether an agent is spawnable with no row of its own.
 *
 * Only the end-to-end delegate ships enabled. The other bundled agents and
 * user-authored agents are opt-in through onboarding or Settings → Agents →
 * Agents. Creating an agent definition makes it available to enable; it does
 * not grant the model permission to start it on its own.
 *
 * Compared after following a retirement, so an agent still carrying the old
 * name is enabled exactly when the one that replaced it is. Resolving the name
 * in `getAgent` but not here would give the worst outcome available: the spawn
 * finds the agent and is then refused as not enabled.
 */
export function agentEnabledByDefault(agent: AgentDefinition): boolean {
	return currentAgentName(agent.name) === DEFAULT_ENABLED_BUNDLED_AGENT;
}

/**
 * Whether `agent` is ENABLED: the model may choose it on its own initiative.
 *
 * ONE predicate, and the singular is the point. This used to be two --
 * `isAgentAdvertised` (listed in the task tool description) and
 * `isAgentSpawnable` (honored when named outright) -- and the gap between them
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
export function isAgentEnabled(settings: Settings, agent: AgentDefinition): boolean {
	return agentSettingsFor(settings, agent.name).enabled ?? agentEnabledByDefault(agent);
}

/** Filter a discovered agent list down to the ones the model may choose. */
export function filterEnabledAgents(settings: Settings, agents: readonly AgentDefinition[]): AgentDefinition[] {
	return agents.filter(agent => isAgentEnabled(settings, agent));
}

export interface EnabledAgentCatalog {
	readonly agents: readonly AgentDefinition[];
	readonly defaultAgent: string | undefined;
	readonly spawnPolicy: ResolvedSpawnPolicy;
}

export interface ResolveEnabledAgentsOptions {
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
export function resolveEnabledAgents(options: ResolveEnabledAgentsOptions): EnabledAgentCatalog {
	const spawnPolicy = resolveSpawnPolicy(options.parentSpawns ?? "*");
	if (!agentsEnabled(options.settings) || !spawnPolicy.enabled) {
		return { agents: [], defaultAgent: undefined, spawnPolicy };
	}

	const enabled = options.agents.filter(
		agent => isAgentEnabled(options.settings, agent) || options.isGranted?.(agent.name) === true,
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
export type AgentEnableState =
	/** The model may choose this agent. */
	| "on"
	/** The model may not. A `/` command that names it directly still runs (see the grant). */
	| "off";

/**
 * The state above, for display in the Agents settings tab.
 *
 * Takes the row value directly rather than reading settings, so an editor holding
 * an unsaved value gets the same answer as the saved one — a second copy of this
 * mapping inside the editor is how the UI and the spawn path drifted apart
 * before. Pass `agentSettingsFor(settings, name).enabled` when you have
 * settings in hand.
 */
export function agentEnableState(agent: AgentDefinition, configured: boolean | undefined): AgentEnableState {
	return (configured ?? agentEnabledByDefault(agent)) ? "on" : "off";
}

/**
 * Whether this row is still on the shipped default rather than a choice someone
 * made. Surfaces may render it as a "(default)" hint; it must never change what
 * the agent does, which is the mistake the old `default-off` state made.
 */
export function isAgentEnableDefaulted(configured: boolean | undefined): boolean {
	return configured === undefined;
}

/**
 * The words each state is shown as, owned here rather than by the Agents table
 * that renders them, so the spawn path and the screen describing it cannot
 * describe the same row differently.
 */
export const AGENT_ENABLE_STATE_LABEL: Record<AgentEnableState, string> = {
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
export function nextAgentEnableValue(agent: AgentDefinition, configured: boolean | undefined): boolean {
	return !(configured ?? agentEnabledByDefault(agent));
}

/**
 * A live spawner that can report the agent types it accepts — the task tool.
 *
 * Declared here rather than imported from `task/index` so the system-prompt build
 * can ask the question without pulling the whole tool (and its executor) into the
 * startup path.
 */
export interface EnabledAgentSource {
	readonly enabledAgentNames: string[];
}

/**
 * The agent types a live task tool will accept, or `[]` when there is no task
 * tool at all (delegation off, or recursion depth exhausted).
 *
 * The tool is the authority because it holds the discovered set: a project agent
 * directory changes what exists, and `agent.agents` changes what is spawnable.
 * Re-deriving either at prompt-build time would let the prompt name an agent the
 * tool then refuses.
 */
export function enabledAgentNames(spawner: unknown): string[] {
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
export function preferredAgentName(enabled: readonly string[], preferred: string): string | undefined {
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
function readNameList(spawner: unknown, key: keyof EnabledAgentSource): string[] {
	const names = (spawner as Partial<EnabledAgentSource> | undefined)?.[key];
	return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
}

/** Which setting decided an agent's model. Shown next to the model on every agent surface. */
export type AgentModelSource =
	/**
	 * `agent.model`, while `agent.sharedModel` is on. The roster is on one
	 * scope, so this answers for every agent and outranks the layers below.
	 */
	| "shared"
	/**
	 * A `agent.agents.<name>` lane — the agent's own row, or a `agents`
	 * level under it. The most specific per-agent layer there is: it names both
	 * the agent and how far down this spawn sits.
	 */
	| "lane"
	/** The agent definition's `model:` frontmatter. */
	| "frontmatter"
	/** Nothing named a model for this agent, so the documented default answered. */
	| "default";

/** A resolved agent model: the patterns to try, and the layer that chose them. */
export interface ResolvedAgentModel {
	/** Model patterns in preference order. Empty only when nothing at all resolved. */
	patterns: string[];
	source: AgentModelSource;
	/** The lane level that decided, when `source` is "lane". */
	depth?: number;
	/**
	 * Set when a CONFIGURED pattern expanded to nothing (a role alias pointing at
	 * an unset role, or an empty value). The caller must surface this rather than
	 * fall through to the next layer.
	 */
	unresolved?: { source: AgentModelSource; value: string; depth?: number };
}

/**
 * The model an agent runs when neither its lane nor its definition names one:
 * the profile's default model role, which is also the model the main assistant
 * starts on.
 *
 * The PERSISTED slot, not the model on screen. The live session model moves on
 * a temporary pick, on role cycling, on prewalk and on a plan-mode switch, and
 * an agent that followed it changed model with nobody having chosen that for
 * the agent — one keystroke aimed at the main assistant moved the whole roster.
 * The slot moves only when someone picks a model to keep, and an agent that
 * should not move with it names its own model on its roster page.
 */
export const AGENT_DEFAULT_MODEL_ROLE = DEFAULT_MODEL_SLOT;

/**
 * The effort an agent runs at when neither its lane nor its definition names
 * one. Clamped against the model at dispatch, so a model with a shorter ladder
 * still runs at a level it declares.
 */
export const AGENT_DEFAULT_EFFORT: ConfiguredThinkingLevel = ThinkingLevel.Medium;

/**
 * Human-readable name of the setting behind a {@link AgentModelSource}. For
 * a lane, `depth` names the level that decided, which is the row a spawn
 * refusal has to point at.
 */
export function agentModelSourceLabel(source: AgentModelSource, agentName: string, depth?: number): string {
	switch (source) {
		case "shared":
			// Names the switch as well as the key: a reader who did not set the
			// switch needs to know why one key answers for an agent they never
			// configured.
			return "agent.model (Same Model for All Agents)";
		case "lane":
			// The path an operator can act on. Depth 0 is the agent's own row; below
			// that, one `.agents` per level, which is exactly the sequence of
			// pages walked to set it.
			return depth === undefined || depth <= 0
				? `agent.agents.${agentName}`
				: `agent.agents.${agentName}${".agents".repeat(depth)}`;
		case "frontmatter":
			return `${agentName} agent frontmatter`;
		case "default":
			return `the ${AGENT_DEFAULT_MODEL_ROLE} model role`;
	}
}

/**
 * Superseded per-agent fields, reported once each rather than once per spawn.
 * Keyed by agent and field so a second agent's leftover row is still named.
 */
const reportedSupersededAgentFields = new Set<string>();

/**
 * The per-agent row fields a newer shape replaced.
 *
 * `model` and `thinkingLevel` are NOT here. They were, while a lane had no page of its own and the
 * table silently outranked the setting an operator had just changed; they are live again now that
 * every page which shows a lane's model edits that same lane. What is left is the numeric ceiling:
 * `agents.enabled` is the depth control, a number beside it is a second answer to one question,
 * and a config carrying the number is still HONORED through `laneDepthOf` — it is reported
 * because nothing writes it any more, not because it is ignored.
 *
 * Exported so the regression suite enumerates the fields instead of restating them: another
 * superseded field added here gets its cases without anybody remembering to write them.
 */
export const SUPERSEDED_AGENT_ROW_FIELDS = ["maxNestedSpawnDepth"] as const;

export type SupersededAgentRowField = (typeof SUPERSEDED_AGENT_ROW_FIELDS)[number];

/**
 * Where the value went, per superseded field. A record rather than a conditional so a new entry
 * does not compile until its replacement is named: a report that points nowhere is worse than none.
 */
const SUPERSEDED_FIELD_REPLACEMENT: Record<SupersededAgentRowField, string> = {
	maxNestedSpawnDepth:
		"Open Agents → Roster → that agent → Agents and turn each level on or off; the chain is the ceiling.",
};

/**
 * Report a `agent.agents.<name>` row that still carries a superseded field.
 *
 * The value is still honored — a config written by an older release keeps meaning what it meant —
 * but nothing writes the field any more, and a value no screen can edit is one an operator will
 * eventually change in the wrong place. So it is said out loud, once, with the control that replaced
 * it, instead of sitting in the file looking authoritative.
 */
function reportSupersededAgentRowField(agentName: string, field: SupersededAgentRowField, value: unknown): void {
	const key = `${agentName}.${field}`;
	if (reportedSupersededAgentFields.has(key)) return;
	reportedSupersededAgentFields.add(key);
	logger.warn(
		`Settings: agent.agents.${agentName}.${field} is "${String(value)}", which no screen writes any more — ` +
			`the nested Agents chain replaced it. ${SUPERSEDED_FIELD_REPLACEMENT[field]}`,
		{ setting: `agent.agents.${agentName}.${field}`, value },
	);
}

/**
 * Name every superseded field left anywhere in the `agent.agents` table.
 * Called from both resolvers so the report happens on the path that reads the
 * value.
 *
 * The WHOLE table rather than the resolving agent's row. Scoped to one row, a
 * leftover on an agent that is disabled was never mentioned at all: that agent
 * never resolves, so the value sat in the operator's config looking configured
 * and doing nothing, which is the exact state retiring the field was meant to
 * end. Nobody should have to enable an agent to discover its setting is dead.
 * The per-field dedupe below is what keeps the sweep from costing anything after
 * the first resolution.
 *
 * An unset field is what a cleared row leaves behind, so it is not a value
 * anyone is losing and gets no report. `0` IS a value — it means this agent
 * spawns nothing — and is reported like any other.
 */
function reportSupersededAgentRows(settings: Settings): void {
	const table = settings.get("agent.agents");
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

/**
 * Keys that stay declared and decide nothing, each with the control that
 * answers instead.
 *
 * They stay in the schema, marked `retiredBy`, so an existing `config.yml`
 * still loads. They are REJECTED rather than served: no resolver reads them,
 * and each one left in a file is reported once with the page that replaced it.
 */
export const RETIRED_AGENT_MODEL_SETTINGS: Readonly<Record<string, string>> = {
	"agent.modelByDepth": "Agents → Roster → that agent → Agents → Model",
};

/** Retired paths reported once each, rather than once per spawn. */
const reportedRetiredModelSettings = new Set<string>();

/**
 * The keys a config still carries and this build ignores.
 *
 * A key holding its unset value is not a stale entry and is not listed: `false`
 * for the switch, an empty chain, an empty map. Anything else is a choice
 * somebody made through a control that no longer exists, and the caller's job is
 * to say so rather than let it look live.
 */
export function rejectedAgentModelSettings(settings: Settings): string[] {
	const rejected: string[] = [];
	for (const path of Object.keys(RETIRED_AGENT_MODEL_SETTINGS)) {
		const value: unknown = settings.get(path as SettingPath);
		if (value === undefined || value === null || value === false) continue;
		if (typeof value === "string" && value.trim().length === 0) continue;
		if (Array.isArray(value) && value.length === 0) continue;
		if (isRecord(value) && Object.keys(value).length === 0) continue;
		rejected.push(path);
	}
	return rejected;
}

/**
 * Say once, per key, that a retired model setting decides nothing now.
 *
 * Called from both resolvers, so the report lands on the path that would have
 * read the value. Silence here is what a rejected setting looks like from the
 * operator's chair: a file that still names a model, and a roster that runs
 * something else.
 */
function reportRejectedAgentModelSettings(settings: Settings): void {
	for (const path of rejectedAgentModelSettings(settings)) {
		if (reportedRetiredModelSettings.has(path)) continue;
		reportedRetiredModelSettings.add(path);
		logger.warn(
			`Settings: ${path} is set and is no longer read — a model and an effort are chosen for one agent, ` +
				`or for every agent through Same Model for All Agents. Open ${RETIRED_AGENT_MODEL_SETTINGS[path]} and choose it there.`,
			{ setting: path },
		);
	}
}

/** Test seam: forget which retired settings have been reported. */
export function resetRejectedAgentModelSettingReports(): void {
	reportedRetiredModelSettings.clear();
}

/**
 * The lane governing a spawn: the agent's own row at depth 0 or 1, and one
 * `agents` level deeper for each level below that.
 *
 * A spawn at task depth 1 is a direct child, which the agent's OWN row describes
 * — that row is the page titled with the agent's name. Depth 2 is what its
 * `Agents` page describes, and so on, so the index into the chain is
 * `taskDepth - 1`.
 */
function laneForSpawn(
	settings: Settings,
	agentName: string,
	taskDepth: number | undefined,
): { chain: AgentLaneSettings[]; index: number } {
	const chain = agentLaneChain(agentSettingsFor(settings, agentName));
	return { chain, index: Math.max(0, (taskDepth ?? 1) - 1) };
}

/**
 * The lane layer for a spawn's model, or undefined when no lane on the way down
 * names one.
 *
 * Reads the governing lane first and walks UP its ancestors, so an unset level
 * inherits the level above rather than falling past the whole tree to the
 * blanket setting. The reported `depth` is the level that actually decided,
 * which is what the badge and a refusal message have to name.
 */
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

/**
 * Whether one blanket answer decides for the whole roster, rather than each
 * agent deciding for itself.
 */
export function agentScopeIsShared(settings: Settings): boolean {
	return settings.get("agent.sharedModel") === true;
}

/** One layer of the model search, with the level that decided when a lane did. */
type AgentModelLayer = { source: AgentModelSource; value: string | string[] | undefined; depth?: number };

/**
 * The layers the shared scope offers: the blanket chain, or none.
 *
 * An unset chain is not an error and is not a layer: it means every agent runs the default model
 * role, which is the same thing the switch being off with no lane anywhere would produce. It is
 * NOT a fall-through to the per-agent layers, which the scope has turned off.
 */
function sharedModelLayers(settings: Settings): AgentModelLayer[] {
	const value: unknown = settings.get("agent.model");
	if (typeof value === "string" && value.trim().length > 0) return [{ source: "shared", value }];
	if (Array.isArray(value) && value.length > 0) {
		return [{ source: "shared", value: value.filter((entry): entry is string => typeof entry === "string") }];
	}
	return [];
}

/** The layers the per-agent scope offers: the lane governing this spawn, then the definition. */
function perAgentModelLayers(
	settings: Settings,
	agentName: string,
	agentModel: string | string[] | undefined,
	taskDepth: number | undefined,
): AgentModelLayer[] {
	const lane = laneModelLayer(settings, agentName, taskDepth);
	return [...(lane === undefined ? [] : [lane]), { source: "frontmatter", value: agentModel }];
}

/**
 * Resolve the model patterns one agent runs, with the deciding layer.
 *
 * TWO SCOPES, and `agent.sharedModel` selects which one is in force rather than layering them.
 * Highest first:
 *  1. `agent.model`, while the switch is on. It answers for every agent, and it is the only
 *     layer that does. The per-agent rows below are not drawn in that state, so nothing on screen
 *     claims a value this outranks.
 *  2. The lane — `agent.agents.<name>`, or the `agents` level under it that governs this
 *     spawn. Deepest lane first, then up the chain: a level naming no model inherits the level
 *     above, which is what makes "inherit" on a nested page mean the page you came from.
 *  3. The agent definition's `model:` frontmatter.
 *  4. {@link AGENT_DEFAULT_MODEL_ROLE}, the documented default.
 *
 * Layers 2 to 4 are skipped entirely while the switch is on, so an agent with a lane does not
 * silently keep its own model against a switch that says every agent shares one. What that lane
 * holds stays in the file and answers again the moment the switch goes off.
 *
 * A spawn does not follow the model the operator is viewing, which moved every agent without a
 * choice of its own on a keystroke aimed at one.
 *
 * A configured layer that expands to nothing returns `unresolved` rather than falling through, so
 * the caller can refuse to spawn and name the setting that is wrong. Bundled specialists carry no
 * `model:` frontmatter, so on a stock install every agent with no lane lands on the default role.
 */
export function resolveAgentModel(options: {
	settings: Settings;
	agentName: string;
	/** The agent definition's `model:` frontmatter, if any. */
	agentModel?: string | string[];
	/**
	 * Bootstrap for a profile that has never recorded a default model role. Not
	 * a layer: it is read only when {@link AGENT_DEFAULT_MODEL_ROLE} is unset.
	 */
	fallbackModelPattern?: string;
	/**
	 * The depth the SPAWNED agent will run at: the calling session's task depth
	 * plus one. It selects which level of the agent's own lane chain answers.
	 * Omitting it — depth 0, or a surface describing an agent rather than a
	 * spawn — reads the agent's own row.
	 */
	taskDepth?: number;
}): ResolvedAgentModel {
	const { settings, agentName, agentModel, fallbackModelPattern, taskDepth } = options;

	reportSupersededAgentRows(settings);
	reportRejectedAgentModelSettings(settings);
	// The scope decides which layers exist at all, and is read once here so no
	// layer can be built from a second reading of the switch.
	const layers = agentScopeIsShared(settings)
		? sharedModelLayers(settings)
		: perAgentModelLayers(settings, agentName, agentModel, taskDepth);

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

	const recorded = settings.getModelRole(AGENT_DEFAULT_MODEL_ROLE)?.trim();
	const fallback = recorded || fallbackModelPattern?.trim() || "";
	return { patterns: resolveConfiguredModelPatterns(fallback, settings), source: "default" };
}

/**
 * Resolve an agent's thinking level, on the same two scopes {@link resolveAgentModel} uses.
 * Highest first:
 *  1. `agent.thinkingLevel`, while `agent.sharedModel` is on. It answers for every agent,
 *     and the layers below are skipped rather than consulted.
 *  2. The lane — the `agent.agents.<name>` level governing this spawn, then up its chain, so a
 *     nested page's "inherit" means the page above it.
 *  3. The agent definition's `thinkingLevel` frontmatter, or `thinking`. The bundled definitions
 *     spell it `thinking-level`, which `normalizeKeys` folds onto the same field.
 *  4. {@link AGENT_DEFAULT_EFFORT}, the documented default.
 *
 * Effort follows the model's scope, never its own: a switch that moved every agent's model and
 * left each agent's effort behind would run the shared model at whatever level the old per-agent
 * row happened to name. The parent session's live effort does not reach a child in either scope.
 *
 * An explicit `:level` suffix on the resolved model pattern outranks all of these. The executor
 * applies that, since only it knows whether the suffix was present (see
 * `resolveEffectiveAgentThinkingLevel`).
 *
 * A configured value naming no level is reported with the setting and the accepted values, then
 * skipped so the next layer decides, rather than becoming the default or a neighbouring level.
 */
export function resolveAgentThinkingLevel(options: {
	settings: Settings;
	agentName: string;
	agentThinkingLevel?: ConfiguredThinkingLevel;
	/** The depth the SPAWNED agent runs at, as {@link resolveAgentModel} takes it. */
	taskDepth?: number;
}): ConfiguredThinkingLevel {
	reportSupersededAgentRows(options.settings);
	reportRejectedAgentModelSettings(options.settings);
	if (agentScopeIsShared(options.settings)) {
		const raw: unknown = options.settings.get("agent.thinkingLevel");
		const parsed = typeof raw === "string" ? parseConfiguredEffortSetting("agent.thinkingLevel", raw) : undefined;
		// Unset, or a value naming no level, leaves the documented default rather
		// than reaching for a per-agent row the operator cannot currently see.
		return parsed ?? AGENT_DEFAULT_EFFORT;
	}
	const { chain, index } = laneForSpawn(options.settings, options.agentName, options.taskDepth);
	for (let level = Math.min(index, chain.length - 1); level >= 0; level--) {
		const raw = chain[level]?.thinkingLevel;
		if (raw === undefined) continue;
		const path = `agent.agents.${options.agentName}${".agents".repeat(level)}.thinkingLevel`;
		const parsed = parseConfiguredEffortSetting(path, raw);
		// An empty value is an explicit inherit rather than a level, and a value
		// naming no level was already reported by the parse. Both mean "this level
		// decides nothing", so the walk continues up rather than stopping here.
		if (parsed !== undefined) return parsed;
	}
	return options.agentThinkingLevel ?? AGENT_DEFAULT_EFFORT;
}

/**
 * Every model chain a spawn in this profile can land on without anyone editing
 * a setting: the default model role, the blanket chain while the roster is on
 * shared scope, and each lane's own chain at every nesting level.
 *
 * A surface that annotates providers by role reads this union rather than one
 * key, because which key decides depends on the scope and on the agent. Lanes
 * stay in the union while the switch is on: a spawn cannot land on them in that
 * state, but the switch is one keystroke and re-annotating every provider on it
 * would make the badges flicker for no gain. Unresolvable patterns stay in the
 * list; the caller resolves and drops what its registry cannot match.
 */
export function configuredAgentModelChains(settings: Settings): Array<string | string[]> {
	const chains: Array<string | string[]> = [];
	const role = settings.getModelRole(AGENT_DEFAULT_MODEL_ROLE)?.trim();
	if (role) chains.push(role);
	const shared: unknown = settings.get("agent.model");
	if (typeof shared === "string" && shared.trim().length > 0) chains.push(shared);
	else if (Array.isArray(shared) && shared.length > 0) {
		chains.push(shared.filter((entry): entry is string => typeof entry === "string"));
	}
	const table: unknown = settings.get("agent.agents");
	if (!isRecord(table)) return chains;
	for (const row of Object.values(table)) {
		if (!isRecord(row)) continue;
		for (const lane of agentLaneChain(row as AgentLaneSettings)) {
			const value = lane.model;
			if (value === undefined) continue;
			if (typeof value === "string" && value.trim().length === 0) continue;
			if (Array.isArray(value) && value.length === 0) continue;
			chains.push(value);
		}
	}
	return chains;
}
