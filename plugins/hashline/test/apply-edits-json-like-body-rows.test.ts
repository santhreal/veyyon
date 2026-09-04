/**
 * JSON-like body rows with braces and quotes survive SWAP/INS.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits JSON-like body rows", () => {
	it("object literal line", () => {
		const base = "const x = {};";
		const body = 'const x = { "a": 1, "b": [2, 3] };';
		const { text } = applyEdits(base, parsePatch(`SWAP 1.=1:\n+${body}`).edits);
		expect(text).toBe(body);
	});

	it("multi-line JSON block", () => {
		const base = "old";
		const patch = `SWAP 1.=1:\n+{\n+  "k": "v"\n+}`;
		const { text } = applyEdits(base, parsePatch(patch).edits);
		expect(text).toBe('{\n  "k": "v"\n}');
	});
});
