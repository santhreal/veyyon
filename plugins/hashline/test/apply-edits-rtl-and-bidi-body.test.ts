/**
 * RTL and bidirectional text body content is opaque.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits RTL and bidi body", () => {
	const bodies = ["مرحبا", "שלום", "hello مرحبا world", "\u202Eforced rtl", "mixed עברית english"];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
