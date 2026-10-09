/**
 * `parseJsonlLenient` appended the records parsed after a skipped line with `push(...records)`, which
 * passes every record as one call argument. Past about a million records that call exceeds the engine's
 * stack and throws `RangeError`, so a single malformed line near the top of a large JSONL file lost the
 * whole file. Every append after a skip goes through the same step, so these cases hold the class: any
 * number of records after any number of skips comes back whole and in source order.
 *
 * Not covered: a file whose records do not fit in memory at all.
 */
import { describe, expect, it } from "bun:test";
import { parseJsonlLenient } from "@veyyon/utils/stream";

// Above the argument count at which a spread call throws under JavaScriptCore (between 500,000 and
// 1,000,000 numbers on Bun 1.4).
const PAST_ARGUMENT_LIMIT = 1_200_000;

describe("parseJsonlLenient after a skipped record", () => {
	it("returns every record that follows a skip, however many there are", () => {
		const skips: number[] = [];
		const entries = parseJsonlLenient<number>(`0\n{broken\n${"7\n".repeat(PAST_ARGUMENT_LIMIT)}`, {
			onSkip: skip => skips.push(skip.offset),
		});
		expect(skips).toEqual([2]);
		expect(entries.length).toBe(1 + PAST_ARGUMENT_LIMIT);
		expect(entries[0]).toBe(0);
		expect(entries.every((entry, k) => entry === (k === 0 ? 0 : 7))).toBe(true);
	});

	it("keeps the records before, between and after two skips in source order", () => {
		const block = (start: number) => Array.from({ length: PAST_ARGUMENT_LIMIT }, (_, k) => start + k).join("\n");
		const text = `${block(0)}\n{broken\n${block(PAST_ARGUMENT_LIMIT)}\n[also broken\n${block(2 * PAST_ARGUMENT_LIMIT)}\n`;
		const skips: number[] = [];
		const entries = parseJsonlLenient<number>(text, { onSkip: skip => skips.push(skip.offset) });
		expect(skips.length).toBe(2);
		expect(entries.length).toBe(3 * PAST_ARGUMENT_LIMIT);
		expect(entries.every((entry, k) => entry === k)).toBe(true);
	});
});
