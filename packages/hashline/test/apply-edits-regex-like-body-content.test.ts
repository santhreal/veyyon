/**
 * Regex-like body content with special chars is opaque, not interpreted.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits regex-like body content", () => {
	const bodies = [
		"/^foo.*bar$/",
		"[a-z]+",
		"(?:non)capturing",
		"a\\nb\\tc",
		"$1 $2",
		".*",
	];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
