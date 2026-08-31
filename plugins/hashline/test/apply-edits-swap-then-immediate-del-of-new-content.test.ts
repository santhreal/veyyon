/**
 * SWAP then DEL the replacement line: net is original with that line removed.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

function apply(text: string, patch: string): string {
	return applyEdits(text, parsePatch(patch).edits).text;
}

describe("applyEdits SWAP then immediate DEL of new content", () => {
	const base = "a\nb\nc\nd\ne";
	for (let line = 1; line <= 5; line++) {
		it(`line ${line}`, () => {
			let t = apply(base, `SWAP ${line}.=${line}:\n+TEMP`);
			expect(t.split("\n")[line - 1]).toBe("TEMP");
			t = apply(t, `DEL ${line}`);
			const want = base
				.split("\n")
				.filter((_, i) => i + 1 !== line)
				.join("\n");
			expect(t).toBe(want);
		});
	}
});
