import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
	aggregateVeracity,
	clampVeracity,
	computeFactId,
	VERACITY_WEIGHTS,
	VeracityConsolidator,
} from "@veyyon/mnemopi/core/veracity-consolidation";

describe("VeracityConsolidator", () => {
	it("does not close a caller-owned Database handle", () => {
		const db = new Database(":memory:", { create: true, readwrite: true, strict: true });
		try {
			const consolidator = new VeracityConsolidator(":memory:", db);
			consolidator.consolidateFact("Alice", "likes", "tea", "stated", "test");

			consolidator.close();

			const row = db.query("SELECT COUNT(*) AS count FROM consolidated_facts").get() as { count: number };
			expect(row.count).toBe(1);
		} finally {
			db.close();
		}
	});

	it("accumulates confidence and dedupes sources when the same fact is consolidated again", () => {
		const consolidator = new VeracityConsolidator();
		try {
			const first = consolidator.consolidateFact("Alice", "likes", "tea", "stated", "chat");
			// base confidence = VERACITY_WEIGHTS.stated (1.0) * 0.5.
			expect(first.confidence).toBe(0.5);
			expect(first.mention_count).toBe(1);
			expect(first.sources).toEqual(["chat"]);

			// bayesianUpdate: c + (1 - c) * weight * 0.3, weight(stated) = 1.0.
			const second = consolidator.consolidateFact("Alice", "likes", "tea", "stated", "chat");
			expect(second.confidence).toBe(0.65);
			expect(second.mention_count).toBe(2);
			// "chat" already present, so a repeat source is not duplicated; a new one appends.
			expect(second.sources).toEqual(["chat"]);
			const third = consolidator.consolidateFact("Alice", "likes", "tea", "stated", "email");
			expect(third.sources).toEqual(["chat", "email"]);
			expect(third.confidence).toBeCloseTo(0.755, 10);
			expect(third.id).toBe(computeFactId("Alice", "likes", "tea"));
		} finally {
			consolidator.close();
		}
	});

	it("records a contradiction conflict when the object changes and resolves it by superseding the loser", () => {
		const consolidator = new VeracityConsolidator();
		try {
			const tea = consolidator.consolidateFact("Alice", "drinks", "tea", "stated", "s1");
			const coffee = consolidator.consolidateFact("Alice", "drinks", "coffee", "stated", "s2");
			if (tea.id === null || coffee.id === null) throw new Error("expected fact ids");

			const conflicts = consolidator.getConflicts();
			expect(conflicts).toHaveLength(1);
			expect(conflicts[0]?.fact_a_id).toBe(coffee.id);
			expect(conflicts[0]?.fact_b_id).toBe(tea.id);
			expect(conflicts[0]?.type).toBe("contradiction");

			// Resolving supersedes the losing fact and drops the conflict from the open list.
			consolidator.resolveConflict(conflicts[0]?.id ?? -1, coffee.id);
			expect(consolidator.getConflicts()).toEqual([]);
			const survivors = consolidator.getConsolidatedFacts("Alice", 0);
			expect(survivors.map(f => f.object)).toEqual(["coffee"]);

			const stats = consolidator.getStats();
			expect(stats.active_facts).toBe(1);
			expect(stats.superseded_facts).toBe(1);
			expect(stats.unresolved_conflicts).toBe(0);

			// A second resolution attempt on the same conflict is a warned no-op, not a throw.
			consolidator.resolveConflict(conflicts[0]?.id ?? -1, tea.id);
			expect(consolidator.getConsolidatedFacts("Alice", 0).map(f => f.object)).toEqual(["coffee"]);
		} finally {
			consolidator.close();
		}
	});

	it("declines to resolve a conflict when the winning id matches neither fact", () => {
		const consolidator = new VeracityConsolidator();
		try {
			const tea = consolidator.consolidateFact("Bob", "owns", "tea", "stated", "s1");
			consolidator.consolidateFact("Bob", "owns", "coffee", "stated", "s2");
			const conflictId = consolidator.getConflicts()[0]?.id ?? -1;

			consolidator.resolveConflict(conflictId, "cf_does_not_exist");
			// Both facts remain active; nothing was superseded.
			expect(consolidator.getConsolidatedFacts("Bob", 0)).toHaveLength(2);
			expect(consolidator.getConflicts()).toHaveLength(1);
			void tea;
		} finally {
			consolidator.close();
		}
	});

	it("summarizes only high-confidence facts and reports when there are none", () => {
		const consolidator = new VeracityConsolidator();
		try {
			expect(consolidator.getHighConfidenceSummary("Zoe")).toBe("No high-confidence facts about Zoe.");

			// Four "stated" consolidations lift confidence to 0.8285 (>= the 0.8 threshold).
			for (let i = 0; i < 4; i++) consolidator.consolidateFact("Alice", "likes", "tea", "stated", "chat");
			const facts = consolidator.getConsolidatedFacts("Alice", 0.8);
			expect(facts).toHaveLength(1);
			expect(facts[0]?.confidence).toBeCloseTo(0.8285, 10);

			expect(consolidator.getHighConfidenceSummary("Alice")).toBe(
				"High-confidence facts about Alice:\n  - Alice likes tea (conf: 0.83, mentions: 4)",
			);
			// A low-confidence fact stays below the default 0.8 threshold and is omitted.
			consolidator.consolidateFact("Alice", "likes", "milk", "unknown", "chat");
			expect(consolidator.getHighConfidenceSummary("Alice")).not.toContain("milk");
		} finally {
			consolidator.close();
		}
	});

	it("resolves stale conflicts in a consolidation pass by favoring the higher-confidence fact", () => {
		const consolidator = new VeracityConsolidator();
		try {
			// Push "tea" to >2 mentions and higher confidence than the single-mention "coffee".
			for (let i = 0; i < 4; i++) consolidator.consolidateFact("Cara", "drinks", "tea", "stated", "s1");
			consolidator.consolidateFact("Cara", "drinks", "coffee", "unknown", "s2");

			consolidator.runConsolidationPass();
			const active = consolidator.getConsolidatedFacts("Cara", 0);
			expect(active.map(f => f.object)).toEqual(["tea"]);
			expect(consolidator.getStats().superseded_facts).toBe(1);
		} finally {
			consolidator.close();
		}
	});
});

describe("veracity pure helpers", () => {
	it("clamps veracity strings, defaulting the empty and unknown cases", () => {
		expect(clampVeracity(null)).toBe("unknown");
		expect(clampVeracity(undefined)).toBe("unknown");
		expect(clampVeracity("   ")).toBe("unknown");
		expect(clampVeracity("STATED")).toBe("stated");
		expect(clampVeracity("Inferred")).toBe("inferred");
		expect(clampVeracity("nonsense")).toBe("unknown");
	});

	it("aggregates source veracities by majority, then lowest weight, then unknown floor", () => {
		expect(aggregateVeracity(null)).toBe("unknown");
		expect(aggregateVeracity([])).toBe("unknown");
		expect(aggregateVeracity(["bogus", "also-bad"])).toBe("unknown");
		// All-unknown falls back to the unknown pool rather than emptying the candidates.
		expect(aggregateVeracity(["unknown", "unknown"])).toBe("unknown");
		// A single non-unknown outweighs the unknowns that get filtered out.
		expect(aggregateVeracity(["unknown", "stated"])).toBe("stated");
		// Majority wins outright.
		expect(aggregateVeracity(["stated", "stated", "inferred"])).toBe("stated");
		// A tie breaks toward the lowest-weight veracity (tool = 0.5 < stated = 1.0).
		expect(VERACITY_WEIGHTS.tool).toBe(0.5);
		expect(aggregateVeracity(["stated", "tool"])).toBe("tool");
	});

	it("hashes fact ids deterministically with length-prefixed, collision-resistant fields", () => {
		expect(computeFactId("Alice", "likes", "tea")).toBe(computeFactId("Alice", "likes", "tea"));
		expect(computeFactId("Alice", "likes", "tea")).not.toBe(computeFactId("Alice", "likes", "coffee"));
		// Length prefixes stop the "a|b|cd" vs "a|bc|d" boundary collision.
		expect(computeFactId("a", "b", "cd")).not.toBe(computeFactId("a", "bc", "d"));
		expect(computeFactId("Alice", "likes", "tea")).toMatch(/^cf_[0-9a-f]{24}$/);
		expect(() => computeFactId("", "likes", "tea")).toThrow("subject must be non-empty");
	});
});
