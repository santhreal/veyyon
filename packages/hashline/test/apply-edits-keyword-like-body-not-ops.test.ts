/**
 * Body lines that look like ops (DEL, SWAP, INS) are content after + sigil.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits keyword-like body not ops", () => {
	const keywords = [
		"DEL 1",
		"SWAP 1.=2:",
		"INS.HEAD:",
		"INS.POST 3:",
		"REM",
		"MV dest",
		"*** Begin Patch",
	];
	for (const body of keywords) {
		it(JSON.stringify(body), () => {
			const { text } = applyEdits("old", parsePatch(`SWAP 1.=1:\n+${body}`).edits);
			expect(text).toBe(body);
		});
	}
});
