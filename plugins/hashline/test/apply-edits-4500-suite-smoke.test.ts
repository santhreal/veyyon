/**
 * Smoke at 4500 pure tests for SQLITE-DEPTH-2.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits 4500 suite smoke", () => {
	it("DEL then INS.HEAD restore count", () => {
		const base = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join("\n");
		const empty = applyEdits(base, parsePatch("DEL 1.=10").edits).text;
		expect(empty).toBe("");
		const rows = Array.from({ length: 10 }, (_, i) => `+L${i + 1}`).join("\n");
		const back = applyEdits(empty, parsePatch(`INS.HEAD:\n${rows}`).edits).text;
		expect(back).toBe(base);
	});
});
