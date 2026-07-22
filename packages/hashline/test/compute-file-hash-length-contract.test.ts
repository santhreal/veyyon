/**
 * computeFileHash always HL_FILE_HASH_LENGTH and matches formatHashlineHeader embedding.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatHashlineHeader,
	HL_FILE_HASH_LENGTH,
	HL_FILE_HASH_SEP,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
} from "@veyyon/hashline";

describe("computeFileHash length contract", () => {
	const samples = ["", "a", "a\nb\nc", "unicode 日本語", "x".repeat(5000), "\n\n\n"];

	for (const s of samples) {
		it(`length for ${JSON.stringify(s).slice(0, 30)}`, () => {
			const h = computeFileHash(s);
			expect(h).toHaveLength(HL_FILE_HASH_LENGTH);
			expect(h).toMatch(/^[0-9A-F]+$/);
			const header = formatHashlineHeader("f.ts", h);
			expect(header).toBe(`${HL_FILE_PREFIX}f.ts${HL_FILE_HASH_SEP}${h}${HL_FILE_SUFFIX}`);
		});
	}
});
