/**
 * blockSingleLineMessage exact forms for all BlockOp values.
 */
import { describe, expect, it } from "bun:test";
import { HL_RANGE_SEP } from "../src/format";
import { blockSingleLineMessage } from "../src/messages";

describe("blockSingleLineMessage ops", () => {
	for (const line of [1, 7, 42]) {
		it(`replace ${line}`, () => {
			const m = blockSingleLineMessage(line, "replace");
			expect(m).toContain(`SWAP.BLK ${line}`);
			expect(m).toContain(`SWAP ${line}${HL_RANGE_SEP}${line}:`);
		});
		it(`delete ${line}`, () => {
			const m = blockSingleLineMessage(line, "delete");
			expect(m).toContain(`DEL.BLK ${line}`);
			expect(m).toContain(`DEL ${line}`);
		});
		it(`insert_after ${line}`, () => {
			const m = blockSingleLineMessage(line, "insert_after");
			expect(m).toContain("INS.BLK.POST");
			expect(m).toContain(`INS.POST ${line}:`);
		});
	}
});
