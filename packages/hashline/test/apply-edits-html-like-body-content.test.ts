/**
 * HTML-like tags in body are opaque content, not stripped.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits HTML-like body content", () => {
	const bodies = [
		"<div class=\"x\">",
		"</div>",
		"<script>alert(1)</script>",
		"<!-- comment -->",
		"<a href=\"http://x\">link</a>",
	];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
