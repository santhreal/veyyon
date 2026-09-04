/**
 * formatNumberedLine / formatNumberedLines: exact "N:body" shape and startLine offset.
 * Why: numbered context is what agents and mismatch messages show; off-by-one breaks recovery.
 */
import { describe, expect, it } from "bun:test";
import { formatNumberedLine, formatNumberedLines } from "@veyyon/hashline";

describe("applyEdits past 6000 format numbered lines matrix", () => {
	it("formatNumberedLine single digits through large", () => {
		for (const n of [1, 2, 9, 10, 99, 100, 999, 1000, 10000, 100000]) {
			expect(formatNumberedLine(n, "body")).toBe(`${n}:body`);
			expect(formatNumberedLine(n, "")).toBe(`${n}:`);
			expect(formatNumberedLine(n, "a:b")).toBe(`${n}:a:b`);
		}
	});

	it("formatNumberedLines empty is empty", () => {
		expect(formatNumberedLines("")).toBe("1:");
	});

	it("formatNumberedLines default start 1", () => {
		expect(formatNumberedLines("a\nb\nc")).toBe("1:a\n2:b\n3:c");
	});

	it("formatNumberedLines startLine offsets", () => {
		for (const start of [1, 5, 10, 100, 1000]) {
			const out = formatNumberedLines("x\ny", start);
			expect(out).toBe(`${start}:x\n${start + 1}:y`);
		}
	});

	it("formatNumberedLines preserves blank and unicode", () => {
		expect(formatNumberedLines("\n")).toBe("1:\n2:");
		expect(formatNumberedLines("café\n🚀")).toBe("1:café\n2:🚀");
	});

	it("formatNumberedLines n=50 exact", () => {
		const lines = Array.from({ length: 50 }, (_, i) => `L${i + 1}`);
		const out = formatNumberedLines(lines.join("\n"));
		const got = out.split("\n");
		expect(got).toHaveLength(50);
		for (let i = 0; i < 50; i++) {
			expect(got[i]).toBe(`${i + 1}:L${i + 1}`);
		}
	});
});
