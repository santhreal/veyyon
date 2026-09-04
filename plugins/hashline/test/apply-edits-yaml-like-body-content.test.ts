/**
 * YAML-like body content with colons and dashes is opaque (not confused with headers).
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits YAML-like body content", () => {
	it("key colon value", () => {
		const body = "name: value";
		const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
		expect(text).toBe(body);
	});

	it("list dash", () => {
		const patch = "SWAP 1.=1:\n+- item1\n+- item2";
		const { text } = applyEdits("old", parsePatch(patch).edits);
		expect(text).toBe("- item1\n- item2");
	});

	it("nested indent", () => {
		const patch = "SWAP 1.=1:\n+parent:\n+  child: 1";
		const { text } = applyEdits("old", parsePatch(patch).edits);
		expect(text).toBe("parent:\n  child: 1");
	});
});
