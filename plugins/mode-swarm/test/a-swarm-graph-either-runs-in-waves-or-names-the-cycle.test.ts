/**
 * WHY. These three functions decide what a swarm actually runs, in what order, and whether it runs
 * at all, and no test named any of them. Two of their properties cannot be observed from a swarm
 * that happens to work.
 *
 * The first is that a dependency has a direction. `waits_for` and `reports_to` point opposite ways —
 * A reports_to B means B waits for A — and a graph built with either edge reversed still produces
 * waves, still terminates, and runs the swarm backwards. Nothing downstream can tell.
 *
 * The second is termination. `buildExecutionWaves` loops until every agent is placed, so a cyclic
 * graph that reached it would spin forever rather than fail. It refuses instead, naming the agents
 * that cannot progress, and that refusal is the bound: a test that only checked wave contents could
 * not distinguish a wrong answer from a hang.
 *
 * The class this closes: edge direction for both relation kinds, an implicit chain applied in the
 * wrong mode or applied on top of explicit dependencies, a cycle reported as the whole graph rather
 * than as its members, non-deterministic ordering inside a wave, and a deadlock that hangs instead
 * of raising.
 *
 * What it does not catch: whether the YAML that produced the definition was parsed correctly, which
 * is the schema module's contract, and anything about running the agents.
 */
import { describe, expect, it } from "bun:test";
import { buildDependencyGraph, buildExecutionWaves, detectCycles } from "../src/swarm/dag";
import type { SwarmAgent, SwarmDefinition, SwarmMode } from "../src/swarm/schema";

interface AgentSpec {
	readonly name: string;
	readonly reportsTo?: readonly string[];
	readonly waitsFor?: readonly string[];
}

function definition(mode: SwarmMode, specs: readonly AgentSpec[]): SwarmDefinition {
	const agents = new Map<string, SwarmAgent>();
	for (const spec of specs) {
		agents.set(spec.name, {
			name: spec.name,
			role: "worker",
			task: `do ${spec.name}`,
			reportsTo: [...(spec.reportsTo ?? [])],
			waitsFor: [...(spec.waitsFor ?? [])],
		});
	}
	return {
		name: "swarm",
		workspace: "/workspace",
		mode,
		targetCount: specs.length,
		agents,
		agentOrder: specs.map(spec => spec.name),
	};
}

/** The graph as plain sorted data, so a direction error is visible rather than inferred. */
function edges(graph: Map<string, Set<string>>): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const [node, deps] of graph) out[node] = [...deps].sort();
	return out;
}

function graphOf(mode: SwarmMode, specs: readonly AgentSpec[]): Map<string, Set<string>> {
	return buildDependencyGraph(definition(mode, specs));
}

function cyclic(): Map<string, Set<string>> {
	return new Map([
		["a", new Set(["b"])],
		["b", new Set(["a"])],
	]);
}

describe("buildDependencyGraph", () => {
	it("gives every declared agent an entry, including one nothing depends on", () => {
		expect(edges(graphOf("parallel", [{ name: "a" }, { name: "b" }]))).toEqual({ a: [], b: [] });
	});

	it("reads waits_for as the waiting agent depending on the named one", () => {
		expect(edges(graphOf("parallel", [{ name: "a" }, { name: "b", waitsFor: ["a"] }]))).toEqual({
			a: [],
			b: ["a"],
		});
	});

	it("reads reports_to the opposite way, as the target depending on the reporter", () => {
		// A reports to B, so B cannot finish before A: the edge points at A, not at B.
		expect(edges(graphOf("parallel", [{ name: "a", reportsTo: ["b"] }, { name: "b" }]))).toEqual({
			a: [],
			b: ["a"],
		});
	});

	it("ignores a relation naming an agent the swarm does not define", () => {
		expect(edges(graphOf("parallel", [{ name: "a", waitsFor: ["ghost"], reportsTo: ["ghost"] }]))).toEqual({ a: [] });
	});

	it("chains a pipeline by declaration order when nothing was declared explicitly", () => {
		expect(edges(graphOf("pipeline", [{ name: "first" }, { name: "second" }, { name: "third" }]))).toEqual({
			first: [],
			second: ["first"],
			third: ["second"],
		});
	});

	it("chains a sequential swarm the same way", () => {
		expect(edges(graphOf("sequential", [{ name: "a" }, { name: "b" }]))).toEqual({ a: [], b: ["a"] });
	});

	it("never chains a parallel swarm, whose agents are meant to run at once", () => {
		expect(edges(graphOf("parallel", [{ name: "a" }, { name: "b" }, { name: "c" }]))).toEqual({
			a: [],
			b: [],
			c: [],
		});
	});

	it("leaves an explicitly wired pipeline alone rather than adding the order chain on top", () => {
		// One explicit edge anywhere means the author wired it, and the implicit chain would add
		// dependencies they did not ask for — including, here, a cycle.
		expect(edges(graphOf("pipeline", [{ name: "a", waitsFor: ["b"] }, { name: "b" }]))).toEqual({
			a: ["b"],
			b: [],
		});
	});
});

describe("detectCycles", () => {
	it("reports nothing for a graph that can be ordered", () => {
		expect(detectCycles(graphOf("pipeline", [{ name: "a" }, { name: "b" }, { name: "c" }]))).toBeNull();
	});

	it("reports nothing for a graph with no edges at all", () => {
		expect(detectCycles(graphOf("parallel", [{ name: "a" }, { name: "b" }]))).toBeNull();
	});

	it("names the agents in the cycle", () => {
		expect(detectCycles(cyclic())?.sort()).toEqual(["a", "b"]);
	});

	it("names an agent that waits for itself", () => {
		expect(detectCycles(new Map([["a", new Set(["a"])]]))).toEqual(["a"]);
	});

	it("names only the agents in the cycle, not the ones that can still run", () => {
		const deps = new Map([
			["free", new Set<string>()],
			["a", new Set(["b"])],
			["b", new Set(["a"])],
			["after", new Set(["free"])],
		]);

		expect(detectCycles(deps)?.sort()).toEqual(["a", "b"]);
	});
});

describe("buildExecutionWaves", () => {
	it("puts independent agents in one wave so they run at once", () => {
		expect(buildExecutionWaves(graphOf("parallel", [{ name: "b" }, { name: "a" }]))).toEqual([["a", "b"]]);
	});

	it("orders a wave deterministically rather than by insertion", () => {
		// Declared c, a, b; the wave comes back sorted, so two runs of one swarm agree.
		expect(buildExecutionWaves(graphOf("parallel", [{ name: "c" }, { name: "a" }, { name: "b" }]))).toEqual([
			["a", "b", "c"],
		]);
	});

	it("gives a chain one wave per link", () => {
		expect(buildExecutionWaves(graphOf("pipeline", [{ name: "a" }, { name: "b" }, { name: "c" }]))).toEqual([
			["a"],
			["b"],
			["c"],
		]);
	});

	it("holds an agent until every one of its dependencies has run", () => {
		// join waits for both arms, which are independent of each other.
		const deps = new Map([
			["left", new Set<string>()],
			["right", new Set<string>()],
			["join", new Set(["left", "right"])],
		]);

		expect(buildExecutionWaves(deps)).toEqual([["left", "right"], ["join"]]);
	});

	it("places an agent in the wave after its deepest dependency, not its first", () => {
		const deps = new Map([
			["a", new Set<string>()],
			["b", new Set(["a"])],
			["c", new Set(["a", "b"])],
		]);

		expect(buildExecutionWaves(deps)).toEqual([["a"], ["b"], ["c"]]);
	});

	it("returns no waves for a swarm with no agents", () => {
		expect(buildExecutionWaves(new Map())).toEqual([]);
	});

	it("refuses a cyclic graph by name instead of looping until something kills it", () => {
		// The loop runs until every agent is placed, so the only alternative to this throw is a
		// hang. The message has to name who is stuck for that to be actionable.
		expect(() => buildExecutionWaves(cyclic())).toThrow(/Deadlock: agents \[a, b\]/);
	});
});
