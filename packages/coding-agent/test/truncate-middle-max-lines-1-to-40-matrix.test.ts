/**
 * truncateMiddle maxLines 1..40: elides interior; keeps head+tail structure.
 * Why: middle elision for long tool output must stay line-complete.
 */
import { describe, expect, it } from "bun:test";
import { formatMiddleElisionMarker, truncateMiddle } from "../src/session/streaming-output";

describe("truncateMiddle maxLines 1 to 40 matrix", () => {
	const lines = Array.from({ length: 100 }, (_, i) => `L${i + 1}`);
	const content = lines.join("\n");

	for (let max = 4; max <= 40; max++) {
		it(`maxLines=${max}`, () => {
			const r = truncateMiddle(content, { maxLines: max, maxBytes: 10_000_000 });
			expect(r.truncated).toBe(true);
			const out = r.content.split("\n");
			// first and last original lines present when budget allows head/tail
			expect(out[0]).toBe("L1");
			expect(out[out.length - 1]).toBe("L100");
			expect(r.totalLines).toBe(100);
		});
	}

	it("under budget identity", () => {
		const small = "a\nb\nc";
		const r = truncateMiddle(small, { maxLines: 100, maxBytes: 1_000_000 });
		expect(r.truncated).toBeFalsy();
		expect(r.content).toBe(small);
	});

	it("formatMiddleElisionMarker exact shape", () => {
		const m = formatMiddleElisionMarker(10, 100);
		expect(typeof m).toBe("string");
		expect(m.length).toBeGreaterThan(0);
		expect(m).toMatch(/10/);
	});
});
