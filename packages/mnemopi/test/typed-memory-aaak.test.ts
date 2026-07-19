import { describe, expect, it } from "bun:test";
import { CATEGORY_MAP, encode, PHRASE_MAP, STRUCTURAL_REPLACEMENTS } from "@veyyon/mnemopi/core/aaak";
import {
	classifyBatch,
	classifyMemory,
	getDecayRate,
	getTypePriority,
	MemoryType,
	shouldConsolidate,
} from "@veyyon/mnemopi/core/typed-memory";

describe("typed memory classification", () => {
	it("classifies the Python integration test cases", () => {
		const fact = classifyMemory("The API is at https://example.com");
		expect(fact.memory_type).toBe(MemoryType.FACT);
		expect(fact.memoryType).toBe(MemoryType.FACT);
		expect(fact.confidence).toBeGreaterThan(0.5);

		expect(classifyMemory("I prefer dark mode").memory_type).toBe(MemoryType.PREFERENCE);
		expect(classifyMemory("I will deliver by Friday").memory_type).toBe(MemoryType.COMMITMENT);
		expect(classifyMemory("Alice decided to use PostgreSQL for the new project.").memory_type).toBe(
			MemoryType.DECISION,
		);
	});

	it("applies Python fallback classification for empty, short, and long unmatched text", () => {
		expect(classifyMemory("   ")).toEqual({
			memory_type: MemoryType.UNKNOWN,
			memoryType: MemoryType.UNKNOWN,
			confidence: 0,
			matched_pattern: "",
			matchedPattern: "",
			priority: "stable",
		});

		const short = classifyMemory("blue kettle");
		expect(short.memory_type).toBe(MemoryType.FACT);
		expect(short.confidence).toBe(0.3);
		expect(short.matched_pattern).toBe("default_short");

		const long = classifyMemory("blue kettle beside quiet window without known trigger words");
		expect(long.memory_type).toBe(MemoryType.CONTEXT);
		expect(long.confidence).toBe(0.3);
		expect(long.matched_pattern).toBe("default_long");
	});

	it("keeps priority, consolidation, decay, and batch helpers aligned with Python", () => {
		expect(getTypePriority(MemoryType.INSTRUCTION)).toBeGreaterThan(getTypePriority(MemoryType.EVENT));
		expect(getTypePriority(MemoryType.COMMITMENT)).toBe(9);
		expect(getTypePriority(MemoryType.ARTIFACT)).toBe(1);
		expect(getDecayRate(MemoryType.CONTEXT)).toBeGreaterThan(getDecayRate(MemoryType.FACT));
		expect(getDecayRate(MemoryType.ERROR)).toBe(0.05);
		expect(shouldConsolidate(MemoryType.DECISION)).toBe(true);
		expect(shouldConsolidate(MemoryType.EVENT)).toBe(false);
		expect(shouldConsolidate(MemoryType.ERROR)).toBe(false);
		expect(
			classifyBatch(["I prefer dark mode", "Meeting with Alice yesterday"]).map(match => match.memory_type),
		).toEqual([MemoryType.PREFERENCE, MemoryType.EVENT]);
	});

	it("uses Python confidence boosts and type-order tie breaking", () => {
		const boosted = classifyMemory("The official API is at https://example.com and documented");
		expect(boosted.memory_type).toBe(MemoryType.FACT);
		expect(boosted.confidence).toBeCloseTo(0.9);

		const tieBroken = classifyMemory("This is a type of persistent error");
		expect(tieBroken.memory_type).toBe(MemoryType.ERROR);
		expect(tieBroken.priority).toBe("persistent");
	});

	it("adds the +0.1 confidence boost when the matched span exceeds 20 characters", () => {
		// The GOAL pattern matches the full 24-char "grow to 100000 customers": base 0.8 + 0.1.
		const long = classifyMemory("grow to 100000 customers");
		expect(long.memory_type).toBe(MemoryType.GOAL);
		expect(long.confidence).toBeCloseTo(0.9, 10);
		expect(long.priority).toBe("high");
	});

	it("maps every memory type to its exact retention priority", () => {
		expect(getTypePriority(MemoryType.INSTRUCTION)).toBe(10);
		expect(getTypePriority(MemoryType.COMMITMENT)).toBe(9);
		expect(getTypePriority(MemoryType.ERROR)).toBe(8);
		expect(getTypePriority(MemoryType.GOAL)).toBe(7);
		expect(getTypePriority(MemoryType.DECISION)).toBe(6);
		expect(getTypePriority(MemoryType.PREFERENCE)).toBe(5);
		expect(getTypePriority(MemoryType.FACT)).toBe(4);
		expect(getTypePriority(MemoryType.RELATIONSHIP)).toBe(4);
		expect(getTypePriority(MemoryType.LEARNING)).toBe(3);
		expect(getTypePriority(MemoryType.OBSERVATION)).toBe(3);
		expect(getTypePriority(MemoryType.EVENT)).toBe(2);
		expect(getTypePriority(MemoryType.CONTEXT)).toBe(2);
		expect(getTypePriority(MemoryType.ARTIFACT)).toBe(1);
		expect(getTypePriority(MemoryType.UNKNOWN)).toBe(0);
		expect(getTypePriority("not-a-real-type")).toBe(0);
	});

	it("maps every memory type to its exact decay rate", () => {
		expect(getDecayRate(MemoryType.CONTEXT)).toBe(0.9);
		expect(getDecayRate(MemoryType.EVENT)).toBe(0.7);
		expect(getDecayRate(MemoryType.OBSERVATION)).toBe(0.5);
		expect(getDecayRate(MemoryType.UNKNOWN)).toBe(0.5);
		expect(getDecayRate(MemoryType.COMMITMENT)).toBe(0.5);
		expect(getDecayRate(MemoryType.GOAL)).toBe(0.4);
		expect(getDecayRate(MemoryType.LEARNING)).toBe(0.3);
		expect(getDecayRate(MemoryType.DECISION)).toBe(0.3);
		expect(getDecayRate(MemoryType.PREFERENCE)).toBe(0.2);
		expect(getDecayRate(MemoryType.FACT)).toBe(0.1);
		expect(getDecayRate(MemoryType.RELATIONSHIP)).toBe(0.1);
		expect(getDecayRate(MemoryType.ARTIFACT)).toBe(0.1);
		expect(getDecayRate(MemoryType.INSTRUCTION)).toBe(0.05);
		expect(getDecayRate(MemoryType.ERROR)).toBe(0.05);
		expect(getDecayRate("not-a-real-type")).toBe(0.3);
	});

	it("consolidates the accumulating knowledge types and skips the transient ones", () => {
		for (const type of [
			MemoryType.FACT,
			MemoryType.PREFERENCE,
			MemoryType.DECISION,
			MemoryType.GOAL,
			MemoryType.LEARNING,
			MemoryType.OBSERVATION,
			MemoryType.RELATIONSHIP,
			MemoryType.INSTRUCTION,
		]) {
			expect(shouldConsolidate(type)).toBe(true);
		}
		for (const type of [
			MemoryType.COMMITMENT,
			MemoryType.EVENT,
			MemoryType.CONTEXT,
			MemoryType.ERROR,
			MemoryType.ARTIFACT,
			MemoryType.UNKNOWN,
		]) {
			expect(shouldConsolidate(type)).toBe(false);
		}
	});
});

describe("AAAK encoding", () => {
	it("exports the Python public maps", () => {
		expect(CATEGORY_MAP.PREFERENCE).toBe("PREF");
		expect(PHRASE_MAP["User requested "]).toBe("REQ ");
		expect(STRUCTURAL_REPLACEMENTS).toContainEqual([" and ", "+"]);
	});

	it("compresses category prefixes, phrases, structure, and parentheses like Python", () => {
		expect(encode("PREFERENCE: Imperial units for GPS, 12-hour time format ( 5:30 PM )")).toBe(
			"PREF|Imperial units→GPS | 12-hour time format (5:30 PM)",
		);
		expect(encode("User asked for real-time transcription and translation using self-hosted automation")).toBe(
			"ASK RT transc+transl→selfhost auto",
		);
		expect(encode("User email is alice@example.com, GitHub: alice")).toBe("@alice@example.com | GH:alice");
	});

	it("leaves compact AAAK text unchanged and uses Python completion compaction order", () => {
		expect(encode("PREF|dark-mode")).toBe("PREF|dark-mode");
		expect(encode("TASK: backup working correctly, migration completed")).toBe("TASK: backup OK | migration DONEd");
	});
});
