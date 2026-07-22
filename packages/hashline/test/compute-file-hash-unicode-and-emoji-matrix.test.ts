/**
 * computeFileHash treats unicode/emoji as opaque content; different glyphs differ.
 */
import { describe, expect, it } from "bun:test";
import { computeFileHash, HL_FILE_HASH_LENGTH } from "@veyyon/hashline";

describe("computeFileHash unicode and emoji matrix", () => {
	const samples = [
		"plain",
		"日本語",
		"emoji 🚀",
		"combining a\u0301",
		"zero width \u200b",
		"snowman ☃",
		"mixed 日本語 and emoji 🎯\n",
	];

	for (const s of samples) {
		it(`stable ${JSON.stringify(s)}`, () => {
			const h = computeFileHash(s);
			expect(h).toHaveLength(HL_FILE_HASH_LENGTH);
			expect(computeFileHash(s)).toBe(h);
		});
	}

	it("distinct samples mostly distinct tags", () => {
		const tags = new Set(samples.map(s => computeFileHash(s)));
		expect(tags.size).toBe(samples.length);
	});
});
