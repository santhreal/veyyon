/**
 * formatHashlineHeader + computeFileHash: every path/body pair produces a
 * header that embeds the exact hash of the body.
 */
import { describe, expect, it } from "bun:test";
import {
	computeFileHash,
	formatHashlineHeader,
	HL_FILE_HASH_LENGTH,
	HL_FILE_PREFIX,
	HL_FILE_SUFFIX,
	HL_FILE_HASH_SEP,
} from "@veyyon/hashline";

describe("formatHashlineHeader + computeFileHash roundtrip matrix", () => {
	const paths = ["a.ts", "src/foo.ts", "path with space.ts", "x", "/abs/p.ts"];
	const bodies = ["", "x", "a\nb\n", "unicode ☃\n", "  trail  \n"];

	for (const path of paths) {
		for (const body of bodies) {
			it(`${JSON.stringify(path)} / ${JSON.stringify(body)}`, () => {
				const h = computeFileHash(body);
				expect(h).toHaveLength(HL_FILE_HASH_LENGTH);
				const header = formatHashlineHeader(path, h);
				expect(header).toBe(
					`${HL_FILE_PREFIX}${path}${HL_FILE_HASH_SEP}${h}${HL_FILE_SUFFIX}`,
				);
				expect(header.startsWith(HL_FILE_PREFIX)).toBe(true);
				expect(header.endsWith(HL_FILE_SUFFIX)).toBe(true);
				expect(header).toContain(h);
				expect(header).toContain(path);
			});
		}
	}
});
