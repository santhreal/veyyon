/**
 * Emoji ZWJ sequences and skin tones are opaque multi-codepoint content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits emoji ZWJ sequences body", () => {
	const bodies = ["👨‍👩‍👧‍👦", "🏳️‍🌈", "👍🏽", "🇺🇸", "a👍b"];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
