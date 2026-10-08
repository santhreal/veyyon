/**
 * The non-blocking advisory a `task` result ends with: a nudge toward a specialist agent type when one
 * call spawns several generic workers, and toward `irc` when it leaves several siblings running. An
 * advisory never refuses a call.
 */
import type { AgentToolResult } from "@veyyon/agent-core";
import type { TaskItem, TaskToolDetails } from "./types";

/** Generic worker agent types; several in one call usually means a more specific type exists. */
const GENERIC_SPAWN_AGENTS: ReadonlySet<string> = new Set(["deep", "sonic"]); // not-a-tool-name: agent ids

/**
 * Advisory — never a rejection — nudging the spawner toward tailored
 * specific agent types when one call resolves ≥2 items to a generic
 * `task`/`sonic` worker and the spawner still holds spawn capacity
 * (DepthCapacity: it currently has the `task` tool). `agentNames` are the
 * per-item resolved agent types. Returns undefined when no nudge applies.
 */
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

/**
 * Suggestion — never a rejection — nudging the spawner to coordinate via `irc`
 * when one call creates ≥2 live siblings and it still holds spawn capacity.
 * Returns undefined when there is nothing to coordinate or IRC is unavailable.
 */
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

/**
 * Compose the non-blocking advisory appended to a `task` result: the
 * specialization nudge (from the per-item resolved agent types), plus — only
 * when some spawns keep running after this call (`willRunAsync`) — the
 * coordination suggestion over those still-live spawns (`items`). Coordination
 * is gated on async because a sync spawn has already finished by the time the
 * call returns, so a "coordinate while they run" hint would misfire. Returns
 * undefined when neither applies.
 */
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

/**
 * The result with `advisory` appended to its first text part, or as a text part of its own when it has
 * none. Returns a fresh result, with a copied content array and text part, rather than editing the
 * caller's: an in-place edit on a shared or cached result would be a hidden trap.
 */
export function appendAdvisory(
	result: AgentToolResult<TaskToolDetails>,
	advisory: string | undefined,
): AgentToolResult<TaskToolDetails> {
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
}
