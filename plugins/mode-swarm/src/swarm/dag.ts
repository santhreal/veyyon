/**
 * Directed Acyclic Graph operations for swarm agent dependencies.
 *
 * Builds a dependency graph from waits_for / reports_to relationships,
 * detects cycles, and produces execution waves via topological sort.
 */
import type { SwarmDefinition } from "./schema";

/**
 * Build a dependency map: agent name → set of agents it depends on.
 *
 * Dependencies come from:
 * 1. Explicit `waits_for` declarations
 * 2. Implicit from `reports_to` (if A reports_to B, then B depends on A)
 * 3. For pipeline/sequential mode with no explicit deps: chain by YAML declaration order
 */
export function buildDependencyGraph(def: SwarmDefinition): Map<string, Set<string>> {
	const deps = new Map<string, Set<string>>();

	for (const name of def.agents.keys()) {
		deps.set(name, new Set());
	}

	for (const [name, agent] of def.agents) {
		// Explicit waits_for
		const own = deps.get(name)!;
		for (const dep of agent.waitsFor) {
			if (deps.has(dep)) own.add(dep);
		}
		// reports_to implies the target waits for the reporter
		for (const target of agent.reportsTo) deps.get(target)?.add(name);
	}

	// For pipeline/sequential with no explicit deps, chain by declaration order
	if ((def.mode === "pipeline" || def.mode === "sequential") && !hasExplicitDeps(deps)) {
		for (let i = 1; i < def.agentOrder.length; i++) {
			deps.get(def.agentOrder[i])!.add(def.agentOrder[i - 1]);
		}
	}

	return deps;
}

function hasExplicitDeps(deps: Map<string, Set<string>>): boolean {
	for (const s of deps.values()) {
		if (s.size > 0) return true;
	}
	return false;
}

/**
 * Detect cycles in the dependency graph.
 * Returns the names of agents involved in cycles, or null if acyclic.
 */
export function detectCycles(deps: Map<string, Set<string>>): string[] | null {
	// Kahn's algorithm: if topological sort doesn't include all nodes, cycles exist
	const inDegree = new Map<string, number>();
	const forward = new Map<string, string[]>(); // dependency → its dependents

	for (const [node, nodeDeps] of deps) {
		inDegree.set(node, nodeDeps.size);
		for (const dep of nodeDeps) {
			const list = forward.get(dep) ?? [];
			list.push(node);
			forward.set(dep, list);
		}
	}

	const queue: string[] = [];
	for (const [node, degree] of inDegree) {
		if (degree === 0) queue.push(node);
	}

	// The queue only grows, so it ends holding every node the walk placed.
	for (let head = 0; head < queue.length; head++) {
		for (const dependent of forward.get(queue[head]) ?? []) {
			const newDegree = inDegree.get(dependent)! - 1;
			inDegree.set(dependent, newDegree);
			if (newDegree === 0) queue.push(dependent);
		}
	}

	// A node the walk never placed still has an unmet dependency.
	if (queue.length < deps.size) {
		return Array.from(deps.keys()).filter(k => inDegree.get(k)! > 0);
	}

	return null;
}

/**
 * Build execution waves from dependency graph via topological sort.
 *
 * Each wave contains agents whose dependencies are all in earlier waves.
 * Agents within a wave can execute in parallel.
 */
export function buildExecutionWaves(deps: Map<string, Set<string>>): string[][] {
	const waves: string[][] = [];
	const completed = new Set<string>();
	const remaining = new Set(deps.keys());

	while (remaining.size > 0) {
		const wave = readyWave(remaining, deps, completed);
		if (wave.length === 0) {
			throw new Error(
				`Deadlock: agents [${Array.from(remaining).join(", ")}] cannot make progress. This indicates a bug in cycle detection.`,
			);
		}

		for (const node of wave) {
			remaining.delete(node);
			completed.add(node);
		}

		waves.push(wave);
	}

	return waves;
}

/** The nodes of `remaining` whose every dependency is in `completed`, sorted for a deterministic execution order. */
function readyWave(
	remaining: ReadonlySet<string>,
	deps: ReadonlyMap<string, ReadonlySet<string>>,
	completed: ReadonlySet<string>,
): string[] {
	const wave: string[] = [];
	for (const node of remaining) {
		let ready = true;
		for (const dep of deps.get(node)!) {
			if (!completed.has(dep)) {
				ready = false;
				break;
			}
		}
		if (ready) wave.push(node);
	}
	return wave.sort();
}
