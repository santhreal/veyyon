/**
 * Diff-like body content with +/- prefixes inside the payload is content after sigil.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits diff-like body content", () => {
	it("body starting with minus after sigil", () => {
		// +-foo → content -foo
		const { text } = applyEdits("old", parsePatch("SWAP 1.=1:\n+-foo").edits);
		expect(text).toBe("-foo");
	});

	it("unified diff style lines as content", () => {
		const patch = "SWAP 1.=1:\n+--- a/file\n++++ b/file\n+@@ -1 +1 @@";
		const { text } = applyEdits("old", parsePatch(patch).edits);
		expect(text).toBe("--- a/file\n+++ b/file\n@@ -1 +1 @@");
	});
});
