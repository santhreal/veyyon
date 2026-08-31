import { describe, expect, it } from "bun:test";
import { BeamMemory } from "@veyyon/mnemopi/core/beam";

describe("BeamMemory hub", () => {
	it("wires index methods to beam module implementations", async () => {
		const beam = new BeamMemory({ dbPath: ":memory:" });
		try {
			const memoryId = beam.remember("Beam hub remembers project Alpha preferences", {
				source: "test",
				importance: 0.8,
			});

			expect(memoryId).toHaveLength(16);
			expect((await beam.recall("Alpha", 5)).some(row => row.id === memoryId)).toBe(true);
			expect((await beam.recallEnhanced("Alpha", 5)).some(row => row.id === memoryId)).toBe(true);
			expect(beam.getContext(10).some(row => (row as { id?: string }).id === memoryId)).toBe(true);
			expect(beam.getWorkingStats()).toMatchObject({ count: 1 });

			const scratchpadId = beam.scratchpadWrite("temporary beam note");
			expect(scratchpadId).toHaveLength(16);
			expect(beam.scratchpadRead().map(row => (row as { content?: string }).content)).toEqual([
				"temporary beam note",
			]);
			beam.scratchpadClear();
			expect(beam.scratchpadRead()).toEqual([]);

			const episodicId = beam.consolidateToEpisodic("Project Alpha summary", [memoryId], "test", 0.7);
			expect(episodicId).toHaveLength(16);
			expect(beam.sleep(true)).toMatchObject({ dry_run: true });

			const exported = beam.exportToDict();
			expect(() => beam.importFromDict(exported)).not.toThrow();
		} finally {
			beam.close();
		}
	});

	it("delegates the working-stats, MEMORIA, degrade, health, and sleep-all methods to their owners", () => {
		const beam = new BeamMemory({ dbPath: ":memory:" });
		try {
			beam.remember("Project Alpha kickoff on 2026-05-30", { source: "test", importance: 0.8 });

			// Global stats see the one row; an author-scoped query for a non-existent author sees none.
			expect(beam.getGlobalWorkingStats()).toMatchObject({ count: 1 });
			expect(beam.getWorkingStats("nobody", "human", "no-channel")).toMatchObject({ count: 0 });

			// Pattern fact extraction over non-matching text yields the zeroed FactCounts.
			expect(beam.extractAndStoreFacts("hello world plain text", 0, null)).toEqual({
				metric: 0,
				date: 0,
				version: 0,
				entity: 0,
				sequence: 0,
				timeline: 0,
				negation: 0,
				decision: 0,
			});

			const retrieved = beam.memoriaRetrieve("Alpha");
			expect(retrieved.query).toBe("Alpha");
			expect(Array.isArray(retrieved.results)).toBe(true);

			// A dry-run degrade over an empty episodic tier reports zero movement.
			expect(beam.degradeEpisodic(true)).toEqual({ status: "dry_run", tier1_to_tier2: 0, tier2_to_tier3: 0 });
			expect(beam.getContaminated(50, 0)).toEqual([]);

			// A fresh store has no successful consolidation, so health reports no_data with zero errors.
			expect(beam.health()).toMatchObject({ status: "no_data", error_count: 0, stale_threshold_hours: 24 });

			// Nothing is old enough to consolidate, so sleepAllSessions is a no_op dry run.
			expect(beam.sleepAllSessions(true)).toMatchObject({
				dry_run: true,
				status: "no_op",
				items_consolidated: 0,
			});
			expect(beam.getConsolidationLog(10)).toEqual([]);
		} finally {
			beam.close();
		}
	});

	it("routes detectLanguage to the single comprehensive owner (all five languages)", () => {
		const beam = new BeamMemory({ dbPath: ":memory:" });
		try {
			// The public method now delegates to helpers.detectLanguage, the one
			// owner. Italian is the tell: the deleted consolidate fork had no Italian
			// branch and returned "en" for this sentence.
			expect(beam.detectLanguage("questo è il progetto e non deve mai cambiare")).toBe("it");
			expect(beam.detectLanguage("Привет, это мой проект и это важно")).toBe("ru");
			expect(beam.detectLanguage("ich bin sehr gern dabei und das ist gut")).toBe("de");
			expect(beam.detectLanguage("recuerda que siempre usa este estilo")).toBe("es");
			expect(beam.detectLanguage("plain English text")).toBe("en");
		} finally {
			beam.close();
		}
	});
});
