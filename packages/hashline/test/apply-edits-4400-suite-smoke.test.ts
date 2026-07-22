/**
 * Smoke at 4400-test pure suite depth for SQLITE-DEPTH-2.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits 4400 suite smoke", () => {
	it("roundtrip del all rebuild", () => {
		const base = "1\n2\n3\n4";
		const empty = applyEdits(base, parsePatch("DEL 1.=4").edits).text;
		expect(empty).toBe("");
		const back = applyEdits(empty, parsePatch("INS.HEAD:\n+1\n+2\n+3\n+4").edits).text;
		expect(back).toBe(base);
	});
});
