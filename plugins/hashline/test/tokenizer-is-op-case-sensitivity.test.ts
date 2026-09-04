/**
 * Tokenizer.isOp is case-sensitive for keywords (lowercase fails).
 */
import { describe, expect, it } from "bun:test";
import { Tokenizer } from "../src/tokenizer";

const tok = new Tokenizer();

describe("Tokenizer.isOp case sensitivity", () => {
	const upper = ["SWAP 1.=1:", "DEL 1", "INS.HEAD:", "REM", "MV x"];
	const lower = ["swap 1.=1:", "del 1", "ins.head:", "rem", "mv x"];
	const mixed = ["Swap 1.=1:", "Del 1", "Ins.HEAD:"];

	for (const line of upper) {
		it(`accepts ${JSON.stringify(line)}`, () => {
			expect(tok.isOp(line)).toBe(true);
		});
	}
	for (const line of lower) {
		it(`rejects lowercase ${JSON.stringify(line)}`, () => {
			expect(tok.isOp(line)).toBe(false);
		});
	}
	for (const line of mixed) {
		it(`rejects mixed ${JSON.stringify(line)}`, () => {
			expect(tok.isOp(line)).toBe(false);
		});
	}
});
