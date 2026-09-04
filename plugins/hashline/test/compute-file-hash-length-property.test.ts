import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

/**
 * computeFileHash always returns exactly 4 hex digits for many sizes.
 */

describe("computeFileHash length property", () => {
	it("length is 4 hex for sizes 0..200 step 1", () => {
		for (let n = 0; n <= 200; n++) {
			const h = computeFileHash("x".repeat(n));
			expect(h).toMatch(/^[0-9A-Fa-f]{4}$/);
			expect(h.length).toBe(4);
		}
	});

	it("length is 4 hex for multi-kb bodies", () => {
		for (const n of [1000, 5000, 10000, 50000]) {
			const h = computeFileHash("y".repeat(n));
			expect(h).toMatch(/^[0-9A-Fa-f]{4}$/);
		}
	});
});
