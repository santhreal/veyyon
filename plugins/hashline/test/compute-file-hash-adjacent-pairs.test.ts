/**
 * Adjacent string pairs that differ by one character produce different hashes (no free collisions in sample).
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash } from "@veyyon/hashline";

describe("computeFileHash adjacent pairs differ", () => {
	const pairs: Array<[string, string]> = [];
	for (let i = 0; i < 50; i++) {
		const a = `line-${i}\ncontent\n`;
		const b = `line-${i}\ncontent!\n`;
		pairs.push([a, b]);
	}
	for (const [a, b] of pairs) {
		it(`differs for ${JSON.stringify(a).slice(0, 20)}…`, () => {
			expect(computeFileHash(a)).not.toBe(computeFileHash(b));
		});
	}
});
