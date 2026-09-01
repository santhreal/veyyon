import { describe, expect, it } from "bun:test";
import { getStreamMarkupHealingPattern, StreamMarkupHealing } from "../src/utils/stream-markup-healing";

describe("getStreamMarkupHealingPattern", () => {
	it("returns 'thinking' for unknown provider/model", () => {
		expect(getStreamMarkupHealingPattern("unknown", "unknown-model")).toBe("thinking");
	});
	it("returns a pattern for any provider/model combination", () => {
		const result = getStreamMarkupHealingPattern("openai", "gpt-4o");
		expect(typeof result).toBe("string");
	});
});

describe("StreamMarkupHealing", () => {
	it("constructs with thinking pattern", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		expect(healing.pattern).toBe("thinking");
	});
	it("feed returns text for thinking pattern", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		const result = healing.feed("hello");
		expect(typeof result).toBe("string");
	});
	it("drainCompleted returns empty array initially", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		expect(healing.drainCompleted()).toEqual([]);
	});
	it("sectionClosed is false initially", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		expect(healing.sectionClosed).toBe(false);
	});
	it("flushPending returns string", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		expect(typeof healing.flushPending()).toBe("string");
	});
	it("flushEvents returns array", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		expect(Array.isArray(healing.flushEvents())).toBe(true);
	});
	it("feedEvents returns array of events", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		const events = healing.feedEvents("hello world");
		expect(Array.isArray(events)).toBe(true);
	});
	it("feedEventsWithoutCalls returns array of events", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		const events = healing.feedEventsWithoutCalls("hello world");
		expect(Array.isArray(events)).toBe(true);
	});
	it("can process empty string", () => {
		const healing = new StreamMarkupHealing({ pattern: "thinking" });
		expect(healing.feed("")).toBe("");
	});
});
