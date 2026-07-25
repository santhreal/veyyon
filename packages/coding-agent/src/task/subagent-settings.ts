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
import { DEFAULT_ENABLED_BUNDLED_AGENT } from "../config/settings-domains/subagents";
import { CLI_THINKING_LEVELS, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "../thinking";
import type { AgentDefinition } from "./types";

/** How hard this session pushes work out to subagents. */
export type DelegationStrength = "off" | "allowed" | "preferred" | "required";

/** Resolved delegation strength (`subagent.delegation`). */
export function delegationStrength(settings: Settings): DelegationStrength {
	return (settings.get("subagent.delegation") ?? "allowed") as DelegationStrength;
}

/** True when the task tool is offered at all. `off` removes the tool and its prompt sections. */
export function delegationEnabled(settings: Settings): boolean {
	return delegationStrength(settings) !== "off";
}

/** True when the prompt should ask for substantial work to be delegated. */
export function delegationPreferred(settings: Settings): boolean {
	const strength = delegationStrength(settings);
	return strength === "preferred" || strength === "required";
}

/** True when a first-turn delegation reminder is injected as well. */
export function delegationRequired(settings: Settings): boolean {
	return delegationStrength(settings) === "required";
}

/**
 * The `subagent.agents` row for `name`, or an empty row when unconfigured.
 *
 * Defends against a missing table as well as a missing row: the schema default is
 * `{}`, but a caller can hold settings that answer `undefined` for everything (the
 * test stub does, and so does a read of a path the running build has not
 * registered), and indexing `undefined` here took down the whole `/agents` view
 * with "undefined is not an object" where an empty row is the right answer.
 */
export function subagentSettingsFor(settings: Settings, name: string): SubagentAgentSettings {
	const table = settings.get("subagent.agents") as Record<string, SubagentAgentSettings> | undefined;
	const row = table?.[name];
	return row && typeof row === "object" ? row : {};
}

/**
 * Whether an agent is spawnable with no row of its own.
 *
 * Only the general-purpose delegate ships enabled: most sessions want to hand
 * work to a worker and nothing else, and every extra agent type costs tokens in
 * the tool description and invites spawns nobody asked for. A user-authored
 * agent (project or user `agents/` directory, an extension, a plugin) is on by
 * default — writing the file IS the opt-in.
 */
export function subagentEnabledByDefault(agent: AgentDefinition): boolean {
	if (agent.source !== "bundled") return true;
	return agent.name === DEFAULT_ENABLED_BUNDLED_AGENT;
}

/**
 * Whether `agent` is offered to the model: listed in the `task` tool description
 * and in the delegation prompt, and therefore choosable on the model's own
 * initiative. Its row wins, else the default above.
 *
 * This is the token-cost switch. It is deliberately NOT the same question as
 * {@link isSubagentSpawnable}: see that function for why.
 */
export function isSubagentAdvertised(settings: Settings, agent: AgentDefinition): boolean {
	const row = subagentSettingsFor(settings, agent.name);
	return row.enabled ?? subagentEnabledByDefault(agent);
}

/**
 * Whether a spawn that names `agent` outright is honored.
 *
 * Only an explicit `enabled: false` refuses. An agent that is merely
 * unadvertised still runs when something names it directly, because the built-in
 * flows do exactly that: `/review` hands the model a prompt saying `agent:
 * "reviewer"`, `/orchestrate` names `sonic`, and a user can type "use the scout
 * agent". Those are explicit requests, not the model helping itself, so the
 * default-off state must not break them — it only keeps them out of the tool
 * description, which is where the token cost is.
 *
 * `enabled: false` is the operator saying no, and that is absolute: the spawn is
 * refused with the setting named.
 */
export function isSubagentSpawnable(settings: Settings, agent: AgentDefinition): boolean {
	return subagentSettingsFor(settings, agent.name).enabled !== false;
}

/** Filter a discovered agent list down to the ones offered to the model. */
export function filterEnabledAgents(settings: Settings, agents: readonly AgentDefinition[]): AgentDefinition[] {
	return agents.filter(agent => isSubagentAdvertised(settings, agent));
}

/** How an agent's row reads on the agent surfaces: what the operator chose, tri-state. */
export type SubagentEnableState =
	/** `enabled: true` — advertised to the model. */
	| "on"
	/** `enabled: false` — refused even when named outright. */
	| "off"
	/** No row: not advertised, but spawnable when named. Bundled specialists start here. */
	| "default-off"
	/** No row, and this agent is advertised by default (the worker, and every user-authored agent). */
	| "default-on";

/**
 * The tri-state above, for display on `/agents` and in the Subagents tab.
 *
 * Takes the row value directly rather than reading settings, so an editor holding
 * an unsaved value gets the same answer as the saved one — a second copy of this
 * mapping inside the editor is how the UI and the spawn path drifted apart
 * before. Pass `subagentSettingsFor(settings, name).enabled` when you have
 * settings in hand.
 */
export function subagentEnableState(agent: AgentDefinition, configured: boolean | undefined): SubagentEnableState {
	if (configured === true) return "on";
	if (configured === false) return "off";
	return subagentEnabledByDefault(agent) ? "default-on" : "default-off";
}

/**
 * The words each state is shown as, owned here because two surfaces render it:
 * `/agents` and the Agents table in the Subagents settings tab. Each applies its
 * own colour; only the wording is shared, so the two cannot describe the same row
 * differently.
 */
export const SUBAGENT_ENABLE_STATE_LABEL: Record<SubagentEnableState, string> = {
	on: "Offered",
	"default-on": "Offered (default)",
	"default-off": "Not offered (default) — still runs when named",
	off: "Blocked",
};

/**
 * The next state when the operator cycles a row: unset → offered → blocked →
 * unset. Both agent surfaces cycle with the same key, so the order lives here.
 */
export function nextSubagentEnableValue(configured: boolean | undefined): boolean | undefined {
	if (configured === undefined) return true;
	if (configured === true) return false;
	return undefined;
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
	const names = (spawner as Partial<EnabledSubagentSource> | undefined)?.enabledAgentNames;
	return Array.isArray(names) ? names.filter((name): name is string => typeof name === "string") : [];
}

/** Which setting decided a subagent's model. Shown next to the model on every agent surface. */
export type SubagentModelSource =
	/** `subagent.agents.<name>.model` — this agent's own row. */
	| "agent"
	/** `subagent.model` — the blanket subagent model. */
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
		case "agent":
			return `subagent.agents.${agentName}.model`;
		case "blanket":
			return "subagent.model";
		case "frontmatter":
			return `${agentName} agent frontmatter`;
		case "inherit":
			return "inherited from the session model";
	}
}

/**
 * Resolve the model patterns one subagent runs, with the deciding layer.
 *
 * Precedence, highest first:
 *  1. `subagent.agents.<name>.model` — this agent's row in the Agents table.
 *  2. `subagent.model` — the blanket model for every enabled subagent.
 *  3. The agent definition's `model:` frontmatter, which for a user-authored
 *     agent is that author's deliberate choice.
 *  4. Inherit the session's live model.
 *
 * A configured layer that expands to NOTHING does not fall through: it comes back
 * as `unresolved` so the caller can refuse to spawn and say which setting is
 * wrong. Silently dropping to the next layer is what made "I changed the subagent
 * model" look like it did nothing, while bundled frontmatter roles decided
 * instead.
 *
 * Bundled specialists intentionally carry no `model:` frontmatter, so on a stock
 * install every subagent lands on case 4 and runs the model the operator is
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
	/**
	 * An unsaved edit standing in for this agent's row, so an editor can preview
	 * what a value would do before writing it.
	 */
	draftModel?: string;
	/**
	 * Skip the agent's own row, answering "what would this agent run WITHOUT an
	 * override" — the default an editor shows next to the override it is editing.
	 */
	ignoreAgentRow?: boolean;
}): ResolvedSubagentModel {
	const { settings, agentName, agentModel, activeModelPattern, fallbackModelPattern } = options;

	const rowModel =
		options.draftModel !== undefined ? options.draftModel : subagentSettingsFor(settings, agentName).model;
	const layers: Array<{ source: SubagentModelSource; value: string | string[] | undefined }> = [
		{ source: "agent", value: options.ignoreAgentRow ? undefined : rowModel },
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
 *  1. `subagent.agents.<name>.thinkingLevel` — this agent's row.
 *  2. `subagent.thinkingLevel` — the blanket subagent effort.
 *  3. the agent definition's `thinking-level` frontmatter.
 *  4. undefined — inherit the session's effort.
 *
 * An explicit `:level` suffix on the resolved model pattern still outranks all of
 * these; the executor applies that, since only it knows whether the suffix was
 * present (see `resolveEffectiveSubagentThinkingLevel`).
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
	const fromRow = parseEffortSetting(
		`subagent.agents.${options.agentName}.thinkingLevel`,
		subagentSettingsFor(options.settings, options.agentName).thinkingLevel,
	);
	if (fromRow !== undefined) return fromRow;
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
