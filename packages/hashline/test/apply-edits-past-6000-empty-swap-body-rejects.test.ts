/**
 * Empty SWAP body: parser currently lowers to pure deletes (no insert rows).
 * EMPTY_REPLACE constant documents the intended operator-facing rule.
 * Why: lock the real wire behavior; empty SWAP must not invent body content.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, EMPTY_REPLACE, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 empty SWAP body behavior", () => {
	for (let line = 1; line <= 30; line++) {
		it(`SWAP ${line} empty body → delete-only edits`, () => {
			const { edits, warnings } = parsePatch(`SWAP ${line}.=${line}:`);
			expect(edits.every((e) => e.kind === "delete")).toBe(true);
			expect(edits.some((e) => e.kind === "insert")).toBe(false);
			expect(Array.isArray(warnings)).toBe(true);
		});
	}

	it("empty SWAP 1.=1 deletes line 1 on apply", () => {
		const { text, firstChangedLine } = applyEdits(
			"a\nb",
			parsePatch("SWAP 1.=1:").edits,
		);
		expect(text).toBe("b");
		expect(firstChangedLine).toBe(1);
	});

	it("empty SWAP range 2.=3 deletes those lines", () => {
		const { text } = applyEdits(
			"a\nb\nc\nd",
			parsePatch("SWAP 2.=3:").edits,
		);
		expect(text.split("\n")).toEqual(["a", "d"]);
	});

	it("EMPTY_REPLACE message mentions SWAP and DEL", () => {
		expect(EMPTY_REPLACE).toMatch(/SWAP/);
		expect(EMPTY_REPLACE).toMatch(/DEL/);
		expect(EMPTY_REPLACE).toMatch(/\+TEXT|body/i);
	});
});
