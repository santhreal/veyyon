import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

/**
 * computeFileHash on special character bodies.
 */

describe("computeFileHash special characters", () => {
	const samples = [
		"",
		"\0",
		"\n",
		"\r\n",
		"\t",
		"a\0b",
		"\\\"",
		"🙂🎉",
		"éüñ",
		"a".repeat(1),
		"a".repeat(100),
		" ".repeat(50),
	];

	it("every sample produces a stable 4-hex hash", () => {
		for (const s of samples) {
			const h = computeFileHash(s);
			expect(h).toMatch(/^[0-9A-Fa-f]{4}$/);
			expect(computeFileHash(s)).toBe(h);
		}
	});

	it("pairwise distinct samples usually have distinct hashes", () => {
		const hashes = samples.map(s => computeFileHash(s));
		const unique = new Set(hashes);
		// 16-bit tags can collide; require a majority of distinct values.
		expect(unique.size).toBeGreaterThanOrEqual(Math.floor(samples.length * 0.6));
	});
});
