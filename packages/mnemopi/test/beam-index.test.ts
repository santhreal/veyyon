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
