/**
 * a-z file: DEL vowels, SWAP consonants subset.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits alphabet file ops", () => {
	const letters = "abcdefghijklmnopqrstuvwxyz".split("");
	const base = letters.join("\n");
	const vowels = new Set(["a", "e", "i", "o", "u"]);

	it("DEL all vowels", () => {
		const dels = letters
			.map((ch, i) => (vowels.has(ch) ? `DEL ${i + 1}` : null))
			.filter(Boolean)
			.join("\n");
		const { text } = applyEdits(base, parsePatch(dels).edits);
		expect(text.split("\n")).toEqual(letters.filter(ch => !vowels.has(ch)));
	});

	it("SWAP first and last", () => {
		const { text } = applyEdits(base, parsePatch("SWAP 1.=1:\n+z\nSWAP 26.=26:\n+a").edits);
		const out = text.split("\n");
		expect(out[0]).toBe("z");
		expect(out[25]).toBe("a");
	});
});
