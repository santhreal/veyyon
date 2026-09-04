/**
 * Five exact cases to cross 4500 pure suite tests.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits five to reach 4500", () => {
	it("1", () => expect(applyEdits("a", parsePatch("DEL 1").edits).text).toBe(""));
	it("2", () => expect(applyEdits("", parsePatch("INS.HEAD:\n+x").edits).text).toBe("x"));
	it("3", () => expect(applyEdits("a", parsePatch("SWAP 1.=1:\n+b").edits).text).toBe("b"));
	it("4", () => expect(applyEdits("a\nb", parsePatch("INS.TAIL:\n+c").edits).text).toBe("a\nb\nc"));
	it("5", () => expect(applyEdits("a\nb", parsePatch("INS.HEAD:\n+z").edits).text).toBe("z\na\nb"));
});
