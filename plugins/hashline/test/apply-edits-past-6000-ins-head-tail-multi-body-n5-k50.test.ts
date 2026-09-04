/**
 * INS.HEAD/TAIL multi-row body k=50 on base n=5.
 * Why: multi-line insert bodies must prefix/suffix exact order.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS HEAD TAIL multi body n5 k50", () => {
	const lines = Array.from({ length: 5 }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const body = Array.from({ length: 50 }, (_, i) => `+I${i + 1}`).join("\n");
	const inserted = Array.from({ length: 50 }, (_, i) => `I${i + 1}`);

	it("HEAD", () => {
		const out = applyEdits(base, parsePatch(`INS.HEAD:\n${body}`).edits).text.split("\n");
		expect(out).toEqual([...inserted, ...lines]);
	});

	it("TAIL", () => {
		const out = applyEdits(base, parsePatch(`INS.TAIL:\n${body}`).edits).text.split("\n");
		expect(out).toEqual([...lines, ...inserted]);
	});
});
