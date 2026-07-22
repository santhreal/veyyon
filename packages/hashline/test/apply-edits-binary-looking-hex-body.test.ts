/**
 * Hex and binary-looking body strings are opaque text content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits binary-looking hex body", () => {
	const bodies = [
		"0xDEADBEEF",
		"\\x00\\x01\\x02",
		"ff00aabb",
		"0b101010",
		"base64:SGVsbG8=",
	];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
