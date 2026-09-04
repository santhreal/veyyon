import { describe, expect, it } from "bun:test";
import { EpisodicGraph, type GraphEdge } from "@veyyon/mnemopi/core/episodic-graph";
import { closeQuietly, openDatabase } from "@veyyon/mnemopi/db";

function withGraph<T>(fn: (graph: EpisodicGraph) => T): T {
	const db = openDatabase(":memory:");
	try {
		const graph = new EpisodicGraph({ db });
		return fn(graph);
	} finally {
		closeQuietly(db);
	}
}

function edge(source: string, target: string, edgeType: string, weight: number): GraphEdge {
	return { source, target, edgeType, weight, timestamp: "2026-05-30T00:00:00.000Z" };
}

describe("EpisodicGraph CRUD", () => {
	it("extracts, stores, and reads gists and facts", () => {
		withGraph(graph => {
			const gist = graph.extractGist(
				"Alice had a meeting with Bob yesterday at the office. She was excited about Project Atlas.",
				"mem_001",
			);
			expect(gist.id).toBe("gist_mem_001");
			expect(gist.participants).toContain("Alice");
			expect(gist.participants).toContain("Bob");
			expect(gist.timeScope).toBe("point_in_time");
			expect(gist.emotion).toBe("positive");

			graph.storeGist(gist, "mem_001");
			expect(graph.getGist(gist.id)?.participants).toContain("Alice");
			expect(graph.findGistsByParticipant("Bob")).toHaveLength(1);

			const facts = graph.extractFacts("Alice is a senior developer. Alice uses Python.", "mem_001");
			expect(facts.length).toBeGreaterThanOrEqual(2);
			for (const fact of facts) graph.storeFact(fact, "mem_001", "test");

			const aliceFacts = graph.findFactsBySubject("Alice");
			expect(aliceFacts.map(fact => fact.predicate)).toContain("is");
			expect(aliceFacts.map(fact => fact.predicate)).toContain("uses");
			expect(graph.getStats()).toEqual({
				gists: 1,
				facts: facts.length,
				edges: 0,
				totalNodes: facts.length + 1,
			});
		});
	});

	it("reads a stored fact back by id and returns null for an unknown id", () => {
		withGraph(graph => {
			const fact = {
				id: "fact_1",
				subject: "Ada",
				predicate: "prefers",
				object: "dark mode",
				timestamp: "2026-05-30T00:00:00.000Z",
				confidence: 0.9,
			};
			graph.storeFact(fact, "mem_x", "sess");
			expect(graph.getFact("fact_1")).toEqual({
				id: "fact_1",
				subject: "Ada",
				predicate: "prefers",
				object: "dark mode",
				timestamp: "2026-05-30T00:00:00.000Z",
				confidence: 0.9,
				temporalQualifier: null,
			});
			expect(graph.getFact("missing")).toBeNull();
		});
	});
});

describe("EpisodicGraph links and traversal", () => {
	it("creates idempotent weighted links and traverses neighborhoods", () => {
		withGraph(graph => {
			graph.addEdge(edge("mem_a", "mem_b", "ctx", 0.8));
			graph.addEdge(edge("mem_b", "mem_c", "ctx", 0.7));
			graph.addEdge(edge("mem_a", "mem_d", "syn", 0.4));
			graph.addEdge(edge("mem_a", "mem_b", "ctx", 0.9));

			const all = graph.findRelatedMemories("mem_a", 2);
			expect(all.map(item => item.memoryId)).toContain("mem_b");
			expect(all.map(item => item.memoryId)).toContain("mem_c");
			expect(all.find(item => item.memoryId === "mem_b")?.weight).toBe(0.9);

			const ctxOnly = graph.findRelatedMemories("mem_a", 2, "ctx");
			expect(ctxOnly.map(item => item.memoryId)).toContain("mem_b");
			expect(ctxOnly.map(item => item.memoryId)).toContain("mem_c");
			expect(ctxOnly.map(item => item.memoryId)).not.toContain("mem_d");

			const strongOnly = graph.findRelatedMemories("mem_a", 2, "", 0.75);
			expect(strongOnly.map(item => item.memoryId)).toEqual(["mem_b"]);

			const oneHop = graph.findRelatedMemories("mem_a", 1);
			expect(oneHop.map(item => item.memoryId)).not.toContain("mem_c");
			expect(graph.getStats().edges).toBe(3);
		});
	});

	it("accepts agent-declared edge types", () => {
		withGraph(graph => {
			graph.addEdge(edge("bug_123", "fix_456", "caused", 0.9));
			const results = graph.findRelatedMemories("bug_123", 1, "caused");
			expect(results).toEqual([{ memoryId: "fix_456", edgeType: "caused", weight: 0.9, depth: 1 }]);
		});
	});

	it("lists all edges and filters by an endpoint via getEdges", () => {
		withGraph(graph => {
			graph.addEdge(edge("mem_a", "mem_b", "ctx", 0.8));
			graph.addEdge(edge("mem_b", "mem_c", "ctx", 0.7));
			graph.addEdge(edge("mem_x", "mem_y", "syn", 0.4));

			// No argument returns every edge in insertion order.
			expect(graph.getEdges()).toEqual([
				{ source: "mem_a", target: "mem_b", edgeType: "ctx", weight: 0.8, timestamp: "2026-05-30T00:00:00.000Z" },
				{ source: "mem_b", target: "mem_c", edgeType: "ctx", weight: 0.7, timestamp: "2026-05-30T00:00:00.000Z" },
				{ source: "mem_x", target: "mem_y", edgeType: "syn", weight: 0.4, timestamp: "2026-05-30T00:00:00.000Z" },
			]);

			// An endpoint argument matches edges where it is either source or target.
			expect(graph.getEdges("mem_b")).toEqual([
				{ source: "mem_a", target: "mem_b", edgeType: "ctx", weight: 0.8, timestamp: "2026-05-30T00:00:00.000Z" },
				{ source: "mem_b", target: "mem_c", edgeType: "ctx", weight: 0.7, timestamp: "2026-05-30T00:00:00.000Z" },
			]);
			expect(graph.getEdges("mem_x")).toEqual([
				{ source: "mem_x", target: "mem_y", edgeType: "syn", weight: 0.4, timestamp: "2026-05-30T00:00:00.000Z" },
			]);
		});
	});
});

describe("EpisodicGraph scoring and proactive links", () => {
	it("scores memories by shared graph features", () => {
		withGraph(graph => {
			graph.ingestMemory("Alice is a developer. Alice uses Python at the office.", "mem_a", {
				linkExisting: false,
			});
			graph.ingestMemory("Alice uses Python for backend work at the office.", "mem_b", {
				linkExisting: false,
			});
			graph.ingestMemory("Carol works at MarketCo. Carol uses Rust.", "mem_c", {
				linkExisting: false,
			});

			expect(graph.scoreMemoryLink("mem_a", "mem_b")).toBeGreaterThan(graph.scoreMemoryLink("mem_a", "mem_c"));
			expect(graph.scoreMemoryLink("mem_a", "missing")).toBe(0);
		});
	});

	it("ingestMemory stores episode nodes and creates deterministic ctx/rel/proactive links", () => {
		withGraph(graph => {
			const first = graph.ingestMemory("Alice is a senior developer. Alice uses Python at the office.", "mem_1");
			expect(first.gist.id).toBe("gist_mem_1");
			expect(first.facts.length).toBeGreaterThanOrEqual(2);
			expect(graph.findRelatedMemories("mem_1", 1).map(item => item.memoryId)).toContain("gist_mem_1");

			const second = graph.ingestMemory("Alice uses Python during deployment reviews at the office.", "mem_2", {
				minLinkScore: 0.2,
			});
			expect(
				second.edges.some(item => item.source === "mem_2" && item.target === "mem_1" && item.edgeType === "ctx"),
			).toBe(true);

			const neighbors = graph.findRelatedMemories("mem_2", 2, "", 0.2);
			expect(neighbors.map(item => item.memoryId)).toContain("mem_1");
			expect(neighbors.map(item => item.memoryId)).toContain("gist_mem_2");
			expect(graph.getStats().gists).toBe(2);
			expect(graph.getStats().facts).toBe(first.facts.length + second.facts.length);
		});
	});
});

describe("EpisodicGraph connection ownership", () => {
	it("owns and closes its own connection when constructed without a db", () => {
		// No `db` option: the graph opens its own in-memory connection and owns it.
		const graph = new EpisodicGraph();
		expect(graph.ownsConnection).toBe(true);
		// A fresh owned graph has an empty schema, so stats are all zero.
		expect(graph.getStats()).toEqual({ gists: 0, facts: 0, edges: 0, totalNodes: 0 });
		// close() runs the owns-connection branch: the handle is released and the next
		// query against it throws rather than returning rows.
		graph.close();
		expect(() => graph.getStats()).toThrow();
	});

	it("leaves an injected connection open after close", () => {
		const db = openDatabase(":memory:");
		try {
			const graph = new EpisodicGraph({ db });
			expect(graph.ownsConnection).toBe(false);
			// close() is a no-op on an injected db: the caller still owns it and can query.
			graph.close();
			expect(graph.getStats().gists).toBe(0);
		} finally {
			closeQuietly(db);
		}
	});
});
