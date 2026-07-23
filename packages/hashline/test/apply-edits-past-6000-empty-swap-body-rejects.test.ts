/**
 * Empty SWAP body is REJECTED, never lowered to pure deletes.
 *
 * A `SWAP N.=M:` with no `+TEXT` body throws EMPTY_REPLACE (parser.ts): a
 * missing body usually means a truncated stream, and silently deleting the
 * range would be silent data loss. Deleting is spelled `DEL`. This suite locks
 * the rejection across many lines, and that the explicit DEL produces the exact
 * remaining text.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 empty SWAP body is rejected", () => {
	for (let line = 1; line <= 30; line++) {
		it(`SWAP ${line} empty body → throws EMPTY_REPLACE`, () => {
			expect(() => parsePatch(`SWAP ${line}.=${line}:`)).toThrow(EMPTY_REPLACE);
		});
	}

	it("empty SWAP 1.=1 is rejected; DEL 1 deletes line 1 on apply", () => {
		expect(() => parsePatch("SWAP 1.=1:")).toThrow(EMPTY_REPLACE);
		const { text, firstChangedLine } = applyEdits("a\nb", parsePatch("DEL 1").edits);
		expect(text).toBe("b");
		expect(firstChangedLine).toBe(1);
	});

	it("empty SWAP range 2.=3 is rejected; DEL 2.=3 deletes those lines", () => {
		expect(() => parsePatch("SWAP 2.=3:")).toThrow(EMPTY_REPLACE);
		const { text } = applyEdits("a\nb\nc\nd", parsePatch("DEL 2.=3").edits);
		expect(text.split("\n")).toEqual(["a", "d"]);
	});

	it("EMPTY_REPLACE message mentions SWAP and DEL", () => {
		expect(EMPTY_REPLACE).toMatch(/SWAP/);
		expect(EMPTY_REPLACE).toMatch(/DEL/);
		expect(EMPTY_REPLACE).toMatch(/\+TEXT|body/i);
	});
});
