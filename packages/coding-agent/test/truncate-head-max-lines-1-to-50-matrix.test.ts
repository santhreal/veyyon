/**
 * truncateHead maxLines 1..50 on 100-line file: keeps first N lines exact.
 * Why: head scrollback contract is line-complete, never partial last line.
 */
import { describe, expect, it } from "bun:test";
import { truncateHead } from "../src/session/streaming-output";

describe("truncateHead maxLines 1 to 50 matrix", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
	const content = lines.join("\n");

	for (let max = 1; max <= 50; max++) {
		it(`maxLines=${max}`, () => {
			const r = truncateHead(content, { maxLines: max, maxBytes: 10_000_000 });
			expect(r.truncated).toBe(true);
			expect(r.truncatedBy).toBe("lines");
			expect(r.content.split("\n")).toEqual(lines.slice(0, max));
			expect(r.totalLines).toBe(100);
		});
	}

	it("maxLines >= total is identity", () => {
		const r = truncateHead(content, { maxLines: 100, maxBytes: 10_000_000 });
		expect(r.truncated).toBeFalsy();
		expect(r.content).toBe(content);
	});
});
