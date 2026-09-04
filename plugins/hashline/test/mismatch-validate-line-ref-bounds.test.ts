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
		// The accepted set is the boundary: pin it exactly, both edges at once, so
		// an off-by-one in either direction shows up as a set difference.
		it(`len=${len} accepts exactly lines 1..${len}`, () => {
			const probe = Array.from({ length: len + 3 }, (_, i) => i - 1);
			const accepted = probe.filter(line => {
				try {
					validateLineRef({ line }, lines);
					return true;
				} catch {
					return false;
				}
			});
			expect(accepted).toEqual(Array.from({ length: len }, (_, i) => i + 1));
		});
		it(`len=${len} rejects 0 and ${len + 1}`, () => {
			expect(() => validateLineRef({ line: 0 }, lines)).toThrow(/does not exist/);
			expect(() => validateLineRef({ line: len + 1 }, lines)).toThrow(/does not exist/);
		});
	}
});
