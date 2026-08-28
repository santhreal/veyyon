import type { SwarmDefinition } from "./schema";

export function buildDependencyGraph(def: SwarmDefinition): Map<string, Set<string>> {
	const deps = new Map<string, Set<string>>();

	for (const name of def.agents.keys()) {
		deps.set(name, new Set());
	}

	for (const [name, agent] of def.agents) {
		for (const dep of agent.waitsFor) {
			if (deps.has(dep)) {
				deps.get(name)!.add(dep);
			}
		}
	}

	for (const [name, agent] of def.agents) {
		for (const target of agent.reportsTo) {
			if (deps.has(target)) {
				deps.get(target)!.add(name);
			}
		}
	}

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

export function detectCycles(deps: Map<string, Set<string>>): string[] | null {
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

	const sorted: string[] = [];
	while (queue.length > 0) {
		const node = queue.shift()!;
		sorted.push(node);
		for (const dependent of forward.get(node) ?? []) {
			const newDegree = inDegree.get(dependent)! - 1;
			inDegree.set(dependent, newDegree);
			if (newDegree === 0) queue.push(dependent);
		}
	}

	if (sorted.length < deps.size) {
		return Array.from(deps.keys()).filter(k => !sorted.includes(k));
	}

	return null;
}

export function buildExecutionWaves(deps: Map<string, Set<string>>): string[][] {
	const waves: string[][] = [];
	const completed = new Set<string>();
	const remaining = new Set(deps.keys());

	while (remaining.size > 0) {
		const wave: string[] = [];

		for (const node of remaining) {
			const nodeDeps = deps.get(node)!;
			let ready = true;
			for (const dep of nodeDeps) {
				if (!completed.has(dep)) {
					ready = false;
					break;
				}
			}
			if (ready) {
				wave.push(node);
			}
		}

		if (wave.length === 0) {
			throw new Error(
				`Deadlock: agents [${Array.from(remaining).join(", ")}] cannot make progress. This indicates a bug in cycle detection.`,
			);
		}

		wave.sort();

		for (const node of wave) {
			remaining.delete(node);
			completed.add(node);
		}

		waves.push(wave);
	}

	return waves;
}
