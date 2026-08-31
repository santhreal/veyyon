/**
 * Markdown fence bodies in SWAP: backticks and fences are opaque content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits markdown fence body", () => {
	it("fenced code block replace", () => {
		const base = "old";
		const patch = "SWAP 1.=1:\n+```ts\n+const x = 1;\n+```";
		const { text } = applyEdits(base, parsePatch(patch).edits);
		expect(text).toBe("```ts\nconst x = 1;\n```");
	});

	it("inline backticks", () => {
		const base = "x";
		const { text } = applyEdits(base, parsePatch("SWAP 1.=1:\n+use `code` here").edits);
		expect(text).toBe("use `code` here");
	});
});
