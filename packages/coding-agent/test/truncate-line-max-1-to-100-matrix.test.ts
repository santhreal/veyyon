/**
 * truncateLine maxChars 1..100: under identity; over prefix+ellipsis exact.
 * Why: grep match column cap must not drop the ellipsis or mis-count length.
 */
import { describe, expect, it } from "bun:test";
import { truncateLine } from "../src/session/streaming-output";

describe("truncateLine max 1 to 100 matrix", () => {
	for (let max = 1; max <= 100; max++) {
		it(`under max=${max}`, () => {
			const s = "a".repeat(max);
			expect(truncateLine(s, max)).toEqual({ text: s, wasTruncated: false });
		});

		it(`over max=${max}`, () => {
			const s = "b".repeat(max + 20);
			const r = truncateLine(s, max);
			expect(r.wasTruncated).toBe(true);
			expect(r.text).toBe(`${"b".repeat(max)}…`);
			expect(r.text.length).toBe(max + 1);
		});
	}

	it("empty under any max", () => {
		for (const max of [1, 10, 50]) {
			expect(truncateLine("", max)).toEqual({ text: "", wasTruncated: false });
		}
	});
});
