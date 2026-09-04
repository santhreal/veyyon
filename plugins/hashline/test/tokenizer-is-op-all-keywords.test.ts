/**
 * Tokenizer.isOp true for every shipped keyword form used in product prompts.
 */
import { describe, expect, it } from "bun:test";
import { Tokenizer } from "../src/tokenizer";

const tok = new Tokenizer();

describe("Tokenizer.isOp all keywords", () => {
	const lines = [
		"SWAP 1.=1:",
		"SWAP 10.=20:",
		"DEL 1",
		"DEL 5.=9",
		"INS.HEAD:",
		"INS.TAIL:",
		"INS.PRE 1:",
		"INS.POST 99:",
		"SWAP.BLK 1:",
		"DEL.BLK 2",
		"INS.BLK.POST 3:",
		"REM",
		"MV dest.ts",
		"MV path/to/file.ts",
	];
	for (const line of lines) {
		it(line, () => {
			expect(tok.isOp(line)).toBe(true);
		});
	}
});
