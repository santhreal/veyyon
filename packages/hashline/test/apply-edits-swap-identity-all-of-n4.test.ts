/**
 * Identity SWAP each line of 4-line file.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits identity SWAP n=4", () => {
	const base = ["w", "x", "y", "z"];
	const text = base.join("\n");
	for (let i = 0; i < 4; i++) {
		it(`line ${i + 1}`, () => {
			const { text: out } = applyEdits(text, parsePatch(`SWAP ${i + 1}.=${i + 1}:\n+${base[i]}`).edits);
			expect(out).toBe(text);
		});
	}
});
