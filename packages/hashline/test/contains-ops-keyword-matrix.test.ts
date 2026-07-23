/**
 * containsRecognizableHashlineOperations keyword matrix.
 */
import { describe, expect, it } from "bun:test";
import { containsRecognizableHashlineOperations } from "@veyyon/hashline";

describe("containsRecognizableHashlineOperations keywords", () => {
	const yes = [
		"SWAP 1.=1:",
		"DEL 1",
		"INS.HEAD:",
		"INS.TAIL:",
		"INS.POST 1:",
		"INS.PRE 2:",
		"REM",
		"MV x",
		"SWAP.BLK 1:",
		"DEL.BLK 1",
		"INS.BLK.POST 1:",
	];
	const no = ["swap 1.=1:", "hello", "function f(){}", "+body", "*** Begin Patch", "[path#ABCD]", ""];

	for (const line of yes) {
		it(`true: ${JSON.stringify(line)}`, () => {
			expect(containsRecognizableHashlineOperations(line)).toBe(true);
			expect(containsRecognizableHashlineOperations(`preamble\n${line}\nmore`)).toBe(true);
		});
	}
	for (const line of no) {
		it(`false: ${JSON.stringify(line)}`, () => {
			expect(containsRecognizableHashlineOperations(line)).toBe(false);
		});
	}
});
