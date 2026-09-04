import { describe, expect, it } from "bun:test";
import { buildDependencyGraph, detectCycles } from "../dag";
import type { SwarmDefinition } from "../schema";

/**
 * Swarm DAG: cycle detection and topological waves. A cycle must name involved
 * agents; acyclic pipeline chains must order by declaration.
 */

function def(
	agents: Array<{ name: string; waitsFor?: string[]; reportsTo?: string[] }>,
	mode: SwarmDefinition["mode"] = "parallel",
): SwarmDefinition {
	const map = new Map();
	const order: string[] = [];
	for (const a of agents) {
		order.push(a.name);
		map.set(a.name, {
			name: a.name,
			role: "r",
			task: "t",
			waitsFor: a.waitsFor ?? [],
			reportsTo: a.reportsTo ?? [],
		});
	}
	return {
		name: "test-swarm",
		workspace: "/tmp/swarm-ws",
		mode,
		targetCount: agents.length,
		agents: map,
		agentOrder: order,
	};
}

describe("swarm dependency graph", () => {
	it("builds empty deps for independent parallel agents", () => {
		const g = buildDependencyGraph(def([{ name: "a" }, { name: "b" }]));
		expect(g.get("a")?.size).toBe(0);
		expect(g.get("b")?.size).toBe(0);
		expect(detectCycles(g)).toBeNull();
	});

	it("honors explicit waits_for edges", () => {
		const g = buildDependencyGraph(def([{ name: "a" }, { name: "b", waitsFor: ["a"] }]));
		expect([...g.get("b")!]).toEqual(["a"]);
		expect(g.get("a")?.size).toBe(0);
		expect(detectCycles(g)).toBeNull();
	});

	it("reports_to implies the target depends on the reporter", () => {
		const g = buildDependencyGraph(def([{ name: "worker", reportsTo: ["lead"] }, { name: "lead" }]));
		expect(g.get("lead")?.has("worker")).toBe(true);
		expect(detectCycles(g)).toBeNull();
	});

	it("pipeline mode chains by declaration order when no explicit deps", () => {
		const g = buildDependencyGraph(def([{ name: "one" }, { name: "two" }, { name: "three" }], "pipeline"));
		expect([...g.get("two")!]).toEqual(["one"]);
		expect([...g.get("three")!]).toEqual(["two"]);
		expect(detectCycles(g)).toBeNull();
	});

	it("detects a two-node cycle and returns involved names", () => {
		const g = buildDependencyGraph(
			def([
				{ name: "a", waitsFor: ["b"] },
				{ name: "b", waitsFor: ["a"] },
			]),
		);
		const cycle = detectCycles(g);
		expect(cycle).not.toBeNull();
		expect(cycle!.sort()).toEqual(["a", "b"]);
	});

	it("detects a three-node cycle", () => {
		const g = buildDependencyGraph(
			def([
				{ name: "a", waitsFor: ["c"] },
				{ name: "b", waitsFor: ["a"] },
				{ name: "c", waitsFor: ["b"] },
			]),
		);
		const cycle = detectCycles(g);
		expect(cycle).not.toBeNull();
		expect(new Set(cycle)).toEqual(new Set(["a", "b", "c"]));
	});

	it("ignores waits_for edges to unknown agent names", () => {
		const g = buildDependencyGraph(def([{ name: "a", waitsFor: ["ghost"] }]));
		expect(g.get("a")?.size).toBe(0);
		expect(detectCycles(g)).toBeNull();
	});
});
