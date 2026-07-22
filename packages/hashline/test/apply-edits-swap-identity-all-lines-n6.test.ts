/**
 * SWAP each line of 6-line file to itself is identity.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits identity SWAP all lines n=6", () => {
	const base = ["a", "b", "c", "d", "e", "f"];
	const text = base.join("\n");
	for (let i = 0; i < base.length; i++) {
		it(`line ${i + 1}`, () => {
			const { text: out } = applyEdits(
				text,
				parsePatch(`SWAP ${i + 1}.=${i + 1}:\n+${base[i]}`).edits,
			);
			expect(out).toBe(text);
		});
	}
});
