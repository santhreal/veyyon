/** Default agent used when a session has unrestricted spawning. */
export const DEFAULT_SPAWN_AGENT = "deep";

/**
 * Retired agent names, mapped to the name that replaced them.
 *
 * `task` was renamed to `deep` because the token already meant three other
 * things that cannot move: the tool, the tool's prose parameter, and the async
 * job kind. The rendered prompt said "Enabled agent types: `task`. The `task`
 * tool says what each one costs", which is one word carrying two meanings nine
 * words apart.
 *
 * The old name keeps resolving rather than going quietly inert, because it is
 * written down in places this repository does not own: a `subagent.agents.task`
 * row in someone's settings, a hand-written `.veyyon/agents/task.md`, a saved
 * transcript being resumed, an SDK caller passing `agent: "task"`. Dropping it
 * would turn every one of those into either an "Unknown agent" error or, worse,
 * a silently ignored configuration row.
 *
 * An alias never shadows a real agent: resolution tries the literal name first,
 * so a user who writes their own `task.md` still gets their own agent.
 */
export const RETIRED_AGENT_NAMES: Readonly<Record<string, string>> = { task: "deep" };

/** The current name for `name`, following a retirement if there is one. */
export function currentAgentName(name: string): string {
	return RETIRED_AGENT_NAMES[name] ?? name;
}

/** Spawn policy derived from a parent agent's `spawns` frontmatter. */
export interface ResolvedSpawnPolicy {
	/** True when at least one subagent may be spawned. */
	enabled: boolean;
	/** Agent used when the caller omits the agent field. */
	defaultAgent: string;
	/** Explicitly allowed agents, or `null` when the policy is unrestricted. */
	allowedAgents: readonly string[] | null;
	/** Text used in spawn rejection messages. */
	allowedErrorText: string;
	/** Backtick-quoted explicit agents for prompt descriptions. */
	allowedPromptText?: string;
}

/** Resolves spawn frontmatter into the default and prompt/error surfaces. */
export function resolveSpawnPolicy(parentSpawns: string | boolean | null | undefined): ResolvedSpawnPolicy {
	let normalized: string;
	if (parentSpawns === false) {
		normalized = "";
	} else if (parentSpawns === true || parentSpawns === null || parentSpawns === undefined) {
		normalized = "*";
	} else {
		normalized = parentSpawns.trim();
	}

	if (normalized === "*") {
		return {
			enabled: true,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents: null,
			allowedErrorText: "*",
		};
	}

	const allowedAgents = normalized
		.split(",")
		.map(spawn => spawn.trim())
		.filter(Boolean);
	if (allowedAgents.length === 0) {
		return {
			enabled: false,
			defaultAgent: DEFAULT_SPAWN_AGENT,
			allowedAgents,
			allowedErrorText: "none (spawns disabled for this agent)",
		};
	}

	return {
		enabled: true,
		defaultAgent: allowedAgents[0] ?? DEFAULT_SPAWN_AGENT,
		allowedAgents,
		allowedErrorText: allowedAgents.join(","),
		allowedPromptText: allowedAgents.map(agent => `\`${agent}\``).join(", "),
	};
}
