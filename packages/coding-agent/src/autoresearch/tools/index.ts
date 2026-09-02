/**
 * Tool names owned by the autoresearch extension. Single source shared by
 * `autoresearch/index.ts` (tool-set gating) and `autoresearch/tools/log-experiment.ts`
 * (active-tools filtering) — see BACKLOG SPEC-ONE-PLACE-AUDIT F7.
 */
export const EXPERIMENT_TOOL_NAMES = [
	"init_experiment",
	"start_arm",
	"run_experiment",
	"log_experiment",
	"update_notes",
	"certify_arms",
];

/**
 * Tools that only mean something with arms to compare.
 *
 * `certify_arms` triages the candidate arms of ONE breadth iteration and assigns
 * a cross-review ring. A serial session has one candidate and no ring, so the
 * tool has nothing to triage: offered anyway, it invites a model to invent an
 * arm identity, "certify" its single run against itself, and log the result as
 * though a reviewer had passed it.
 *
 * `start_arm` opens an arm and puts the session on that arm's model. A serial
 * session has no arm to open and no second model to open it on, so the same
 * argument applies: offered anyway, it invites an arm identity that the storage
 * row, the screen and the certification all agree does not exist.
 */
export const SWARM_TOOL_NAMES = ["certify_arms", "start_arm"];

/**
 * The active-tool set for a session of the given breadth.
 *
 * One owner for both directions, because the extension flips these tools at five
 * points — rehydrate, resume, enable, branch change, clear — and a union written
 * out at each of them attaches whatever the newest one forgot to condition.
 * Detaching always removes every owned name, whatever the breadth is now: a
 * session that drops from swarm to serial must not keep the swarm tool it was
 * attached with.
 */
export function activeToolsFor(active: readonly string[], enabled: boolean, breadth: number): string[] {
	const owned = new Set(EXPERIMENT_TOOL_NAMES);
	const rest = active.filter(name => !owned.has(name));
	if (!enabled) return rest;
	const swarmOnly = new Set(SWARM_TOOL_NAMES);
	return [...rest, ...EXPERIMENT_TOOL_NAMES.filter(name => breadth > 1 || !swarmOnly.has(name))];
}

/** Whether `next` differs from `active` as a sequence, so a no-op never re-arms the tool set. */
export function activeToolsChanged(active: readonly string[], next: readonly string[]): boolean {
	return next.length !== active.length || next.some((name, index) => name !== active[index]);
}
