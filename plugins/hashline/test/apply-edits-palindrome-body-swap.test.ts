/**
 * Palindrome line bodies and reverse-file swaps: content is opaque.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits palindrome body SWAP", () => {
	const palindromes = ["aba", "abba", "a", "12321", "racecar"];
	for (const p of palindromes) {
		it(p, () => {
			const { text } = applyEdits("x", parsePatch(`SWAP 1.=1:\n+${p}`).edits);
			expect(text).toBe(p);
			expect(text).toBe([...text].reverse().join(""));
		});
	}
});
