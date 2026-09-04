import { describe, expect, it } from "bun:test";
import { formatNumberedLine, formatNumberedLines } from "@veyyon/hashline";

/**
 * formatNumberedLines property over many start lines and bodies.
 */

describe("formatNumberedLines property", () => {
	it("formatNumberedLine is N:body for many N", () => {
		for (let n = 1; n <= 500; n += 7) {
			expect(formatNumberedLine(n, "x")).toBe(`${n}:x`);
			expect(formatNumberedLine(n, "")).toBe(`${n}:`);
			expect(formatNumberedLine(n, "a:b")).toBe(`${n}:a:b`);
		}
	});

	it("formatNumberedLines numbers consecutive lines from startLine", () => {
		for (const start of [1, 5, 100]) {
			const body = "a\nb\nc\n";
			const out = formatNumberedLines(body, start);
			expect(out).toContain(`${start}:a`);
			expect(out).toContain(`${start + 1}:b`);
			expect(out).toContain(`${start + 2}:c`);
		}
	});

	it("empty body produces empty or header-only without inventing lines", () => {
		const out = formatNumberedLines("", 1);
		expect(out === "" || !out.includes(":invented")).toBe(true);
	});
});
