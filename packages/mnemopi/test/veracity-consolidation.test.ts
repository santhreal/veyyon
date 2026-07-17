import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { clampVeracity, VERACITY_WEIGHTS, VeracityConsolidator } from "@veyyon/pi-mnemopi/core/veracity-consolidation";

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
});

describe("getConsolidatedFactsBySubjectWord", () => {
	it("finds facts case-insensitively and inside multi-word subjects", () => {
		const consolidator = new VeracityConsolidator(":memory:");
		try {
			consolidator.consolidateFact("MacBook", "has", "16GB RAM", "stated", "m1");
			consolidator.consolidateFact("Mukund Thiru", "works on", "veyyon", "stated", "m2");
			consolidator.consolidateFact("Martin", "likes", "tea", "stated", "m3");

			const macbook = consolidator.getConsolidatedFactsBySubjectWord("macbook");
			expect(macbook.map(f => f.subject)).toEqual(["MacBook"]);

			const mukund = consolidator.getConsolidatedFactsBySubjectWord("mukund");
			expect(mukund.map(f => f.subject)).toEqual(["Mukund Thiru"]);
			const thiru = consolidator.getConsolidatedFactsBySubjectWord("THIRU");
			expect(thiru.map(f => f.subject)).toEqual(["Mukund Thiru"]);

			// Whole-word only: no substring overmatch ("art" must not hit "Martin").
			expect(consolidator.getConsolidatedFactsBySubjectWord("art")).toEqual([]);
			expect(consolidator.getConsolidatedFactsBySubjectWord("")).toEqual([]);
		} finally {
			consolidator.close();
		}
	});

	it("treats LIKE wildcards in the word as literals", () => {
		const consolidator = new VeracityConsolidator(":memory:");
		try {
			consolidator.consolidateFact("snake_case_name", "is", "a subject", "stated", "m1");
			consolidator.consolidateFact("snakeXcaseXname", "is", "a decoy", "stated", "m2");
			const hits = consolidator.getConsolidatedFactsBySubjectWord("snake_case_name");
			expect(hits.map(f => f.subject)).toEqual(["snake_case_name"]);
		} finally {
			consolidator.close();
		}
	});
});

describe("veracity vocabulary (one owner)", () => {
	it("legacy 'true'/'false'/'likely_true' rows keep their value and get a defined weight", () => {
		expect(clampVeracity("true")).toBe("true");
		expect(clampVeracity("false")).toBe("false");
		expect(clampVeracity("likely_true")).toBe("likely_true");
		expect(VERACITY_WEIGHTS.true).toBe(1.0);
		expect(VERACITY_WEIGHTS.likely_true).toBe(1.0);
		expect(VERACITY_WEIGHTS.false).toBe(0);
		expect(VERACITY_WEIGHTS.unknown).toBe(0.8);
	});

	it("consolidating a legacy 'true' fact uses weight 1.0, not an undefined lookup", () => {
		const consolidator = new VeracityConsolidator(":memory:");
		try {
			const fact = consolidator.consolidateFact("Bob", "owns", "a boat", "true", "test");
			expect(fact.veracity).toBe("true");
			expect(fact.confidence).toBe(0.5); // weight 1.0 * 0.5 base, not NaN and not unknown's 0.4
		} finally {
			consolidator.close();
		}
	});

	it("clampVeracity maps garbage to 'unknown' loudly, never to an unweighted value", () => {
		expect(clampVeracity("contested", "test")).toBe("unknown");
		expect(clampVeracity(null)).toBe("unknown");
		expect(clampVeracity("  Stated ")).toBe("stated");
	});
});
