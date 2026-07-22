/**
 * TOML-like body content with brackets and equals is opaque.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits TOML-like body content", () => {
	const bodies = [
		"[section]",
		'key = "value"',
		"num = 42",
		"arr = [1, 2, 3]",
		'name = "a = b"',
	];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
