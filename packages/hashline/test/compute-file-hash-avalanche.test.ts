import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

/**
 * computeFileHash avalanche-ish sensitivity: small changes produce different tags often.
 */

describe("computeFileHash avalanche", () => {
	it("appending a newline changes the hash", () => {
		expect(computeFileHash("abc")).not.toBe(computeFileHash("abc\n"));
	});

	it("prefix and suffix of length 100 have distinct hashes across 50 variants", () => {
		const hashes = new Set<string>();
		for (let i = 0; i < 50; i++) {
			hashes.add(computeFileHash(`prefix-${i}-${"x".repeat(100)}\n`));
		}
		// 16-bit space can collide; require most unique.
		expect(hashes.size).toBeGreaterThan(40);
	});

	it("byte-identical buffers always match", () => {
		const bodies = ["", "\n", "a\nb\n", "日本語\n", "a".repeat(10_000)];
		for (const b of bodies) {
			expect(computeFileHash(b)).toBe(computeFileHash(b.slice()));
			expect(computeFileHash(b)).toMatch(/^[0-9A-Fa-f]{4}$/);
		}
	});
});
