/**
 * computeFileHash avalanche: single-char flip in body changes the 4-hex tag.
 * Adjacent distinct bodies differ (except theoretical 16-bit collision, assert rare).
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

describe("computeFileHash avalanche adjacent property", () => {
	const bases = [
		"hello world",
		"function main() {}\n",
		"a\nb\nc\nd\ne",
		"x".repeat(200),
		"",
	];

	for (const base of bases) {
		it(`single char flip changes hash for ${JSON.stringify(base).slice(0, 40)}`, () => {
			if (base.length === 0) {
				expect(computeFileHash("")).not.toBe(computeFileHash("x"));
				return;
			}
			const h0 = computeFileHash(base);
			const flipped = base.slice(0, -1) + (base.endsWith("a") ? "b" : "a");
			expect(computeFileHash(flipped)).not.toBe(h0);
		});
	}

	it("100 sequential variants have low collision rate", () => {
		const tags = new Set<string>();
		for (let i = 0; i < 100; i++) {
			tags.add(computeFileHash(`variant-${i}\ncontent`));
		}
		// 16-bit space: expect almost all unique for 100 items
		expect(tags.size).toBeGreaterThanOrEqual(95);
	});
});
