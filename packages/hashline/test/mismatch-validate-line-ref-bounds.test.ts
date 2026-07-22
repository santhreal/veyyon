/**
 * validateLineRef bounds matrix for file lengths 0..5.
 */
import { describe, expect, it } from "bun:test";
import { validateLineRef } from "../src/mismatch";

describe("validateLineRef bounds matrix", () => {
	for (const len of [0, 1, 2, 5]) {
		const lines = Array.from({ length: len }, (_, i) => `L${i + 1}`);
		if (len === 0) {
			it("empty file rejects line 1", () => {
				expect(() => validateLineRef({ line: 1 }, lines)).toThrow(/does not exist/);
			});
			continue;
		}
		it(`len=${len} accepts 1 and ${len}`, () => {
			expect(() => validateLineRef({ line: 1 }, lines)).not.toThrow();
			expect(() => validateLineRef({ line: len }, lines)).not.toThrow();
		});
		it(`len=${len} rejects 0 and ${len + 1}`, () => {
			expect(() => validateLineRef({ line: 0 }, lines)).toThrow(/does not exist/);
			expect(() => validateLineRef({ line: len + 1 }, lines)).toThrow(/does not exist/);
		});
	}
});
