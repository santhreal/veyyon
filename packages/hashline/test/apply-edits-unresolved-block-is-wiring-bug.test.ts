/**
 * `applyEdits` must never see a still-deferred `kind: "block"` edit.
 *
 * Parser output for `SWAP.BLK` / `DEL.BLK` / `INS.BLK.POST` is a deferred
 * `block` node. `resolveBlockEdits` is the only owner of turning that into
 * inserts+deletes. If the applier is reached with the deferred node still
 * present, that is a wiring bug — throw `UNRESOLVED_BLOCK_INTERNAL`.
 *
 * Anchor classification for block / insert / delete is already in
 * an-insertion-may-anchor-a-line-too-wide-to-print.test.ts and
 * anchor-lines.test.ts. The string itself is in messages-exact-contract.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits } from "../src/apply";
import { UNRESOLVED_BLOCK_INTERNAL } from "../src/messages";
import type { Edit } from "../src/types";

function blockEdit(line: number, payloads: string[]): Edit {
	return {
		kind: "block",
		anchor: { line },
		payloads,
		lineNum: line,
		index: 0,
	};
}

describe("applyEdits refuses an unresolved block before touching the body", () => {
	it("throws the internal wiring string for a replace_block node", () => {
		expect(() => applyEdits("alpha\nbeta\n", [blockEdit(1, ["NEW"])])).toThrow(UNRESOLVED_BLOCK_INTERNAL);
	});

	it("throws when the block is the last edit after a well-formed delete", () => {
		const del: Edit = { kind: "delete", anchor: { line: 2 }, lineNum: 2, index: 0 };
		expect(() => applyEdits("a\nb\nc\n", [del, blockEdit(3, ["z"])])).toThrow(UNRESOLVED_BLOCK_INTERNAL);
	});
});
