import { afterEach, describe, expect, it } from "bun:test";
import { generateTaskName, resetTaskNames } from "@veyyon/coding-agent/task/name-generator";

/**
 * generateTaskName hands every task a unique two-word label; a collision would
 * make two concurrent tasks indistinguishable in the UI and logs. resetTaskNames
 * is marked "for testing" yet nothing tested it. These tests pin the uniqueness
 * contract under both ordinary and pathological RNG (all draws collide, forcing
 * the exhaustive fallback) and prove reset actually frees the used-name set.
 */

describe("generateTaskName", () => {
	afterEach(() => {
		resetTaskNames();
	});

	it("produces two capitalized words", () => {
		resetTaskNames();
		expect(generateTaskName()).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
	});

	it("never repeats a name across many draws", () => {
		resetTaskNames();
		const names = new Set<string>();
		for (let i = 0; i < 500; i++) names.add(generateTaskName());
		expect(names.size).toBe(500);
	});

	it("stays unique via the exhaustive fallback even when every random draw collides", () => {
		const originalRandom = Math.random;
		// Force Math.floor(random * len) to 0 on every draw: the 50 random attempts
		// all land on the same first-word/first-noun pair, so the second call must
		// escape through the deterministic exhaustive search to stay unique.
		Math.random = () => 0;
		try {
			resetTaskNames();
			const first = generateTaskName();
			const second = generateTaskName();
			expect(second).not.toBe(first);
		} finally {
			Math.random = originalRandom;
		}
	});

	it("frees names after reset so the same first draw returns", () => {
		const originalRandom = Math.random;
		Math.random = () => 0;
		try {
			resetTaskNames();
			const first = generateTaskName();
			resetTaskNames();
			// With the RNG pinned to the first pair, a cleared used-set must hand back
			// the identical name; if reset did not clear state it would fall through to
			// a different pair.
			expect(generateTaskName()).toBe(first);
		} finally {
			Math.random = originalRandom;
		}
	});
});
