/**
 * truncateTail maxLines 1..50 on 100-line file: keeps last N lines exact.
 * Why: tail buffer contract is line-complete from the end.
 */
import { describe, expect, it } from "bun:test";
import { truncateTail } from "../src/session/streaming-output";

describe("truncateTail maxLines 1 to 50 matrix", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
	const content = lines.join("\n");

	for (let max = 1; max <= 50; max++) {
		it(`maxLines=${max}`, () => {
			const r = truncateTail(content, { maxLines: max, maxBytes: 10_000_000 });
			expect(r.truncated).toBe(true);
			expect(r.content.split("\n")).toEqual(lines.slice(100 - max));
			expect(r.totalLines).toBe(100);
		});
	}
});
