/**
 * Body rows that begin with + after the payload sigil: content may include + chars.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits SWAP body with plus chars", () => {
	it("C++ style line", () => {
		const base = "old\n";
		const { text } = applyEdits(base, parsePatch("SWAP 1.=1:\n+int x = a + b;").edits);
		expect(text).toBe("int x = a + b;\n");
	});

	it("leading plus in content after sigil", () => {
		// ++foo as body: first + is sigil, rest is +foo
		const base = "x";
		const { text } = applyEdits(base, parsePatch("SWAP 1.=1:\n++foo").edits);
		expect(text).toBe("+foo");
	});

	it("multiple plus in body", () => {
		const base = "a\nb";
		const { text } = applyEdits(base, parsePatch("SWAP 2.=2:\n+a + b + c").edits);
		expect(text).toBe("a\na + b + c");
	});
});
