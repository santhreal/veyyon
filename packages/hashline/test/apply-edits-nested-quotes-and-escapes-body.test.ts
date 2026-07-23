/**
 * Nested quotes and backslash escapes in body are opaque content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits nested quotes and escapes body", () => {
	const bodies = [`'single'`, `"double"`, `"he said \\"hi\\""`, `path\\to\\file`, `\\n\\t as literals`, `''`, `""`];
	for (const body of bodies) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
