/**
 * formatHashlineHeader exact for path/hash pairs.
 */
import { describe, expect, it } from "bun:test";
import { formatHashlineHeader, HL_FILE_HASH_SEP, HL_FILE_PREFIX, HL_FILE_SUFFIX } from "@veyyon/hashline";

describe("formatHashlineHeader exact", () => {
	const pairs: Array<[string, string]> = [
		["a.ts", "0000"],
		["src/a.ts", "ABCD"],
		["path-with-dash.ts", "FFFF"],
		["日本語.ts", "1234"],
		["a/b/c.tsx", "9F3E"],
	];
	for (const [path, hash] of pairs) {
		it(`${path}#${hash}`, () => {
			expect(formatHashlineHeader(path, hash)).toBe(
				`${HL_FILE_PREFIX}${path}${HL_FILE_HASH_SEP}${hash}${HL_FILE_SUFFIX}`,
			);
		});
	}
});
