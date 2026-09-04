/**
 * blockUnresolvedMessage for replace and delete ops with and without context.
 */
import { describe, expect, it } from "bun:test";
import { blockUnresolvedMessage } from "../src/messages";

describe("blockUnresolvedMessage ops", () => {
	for (const line of [1, 5, 99]) {
		it(`replace line ${line}`, () => {
			const m = blockUnresolvedMessage(line, "replace");
			expect(m).toContain(`SWAP.BLK ${line}:`);
			expect(m).toContain(`line ${line}`);
		});
		it(`delete line ${line}`, () => {
			const m = blockUnresolvedMessage(line, "delete");
			expect(m).toContain(`DEL.BLK ${line}`);
			expect(m).toContain(`line ${line}`);
		});
	}

	it("with fileLines includes context marker", () => {
		const m = blockUnresolvedMessage(2, "replace", ["a", "b", "c", "d"]);
		expect(m).toContain("*2:b");
	});
});
