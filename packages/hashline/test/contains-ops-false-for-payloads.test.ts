/**
 * containsRecognizableHashlineOperations false for payload-only and prose.
 */
import { describe, expect, it } from "bun:test";
import { containsRecognizableHashlineOperations } from "@veyyon/hashline";

describe("containsRecognizableHashlineOperations negatives", () => {
	const no = [
		"",
		" ",
		"+payload only",
		"++plus",
		"function main() {}",
		"// DEL 1 in a comment is not an op line alone",
		"*** Begin Patch",
		"*** End Patch",
		"[path#ABCD]",
		"hello\nworld",
		"1:numbered read output without op",
	];
	for (const s of no) {
		it(`false: ${JSON.stringify(s).slice(0, 40)}`, () => {
			expect(containsRecognizableHashlineOperations(s)).toBe(false);
		});
	}
});
