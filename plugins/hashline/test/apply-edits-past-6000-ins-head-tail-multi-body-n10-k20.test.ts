/**
 * INS.HEAD/TAIL multi-row body k=20 on base n=10.
 * Why: multi-line insert bodies must prefix/suffix exact order.
 */
import { describe, expect, it } from "bun:test";
import { applyEdits, parsePatch } from "@veyyon/hashline";

describe("applyEdits past 6000 INS HEAD TAIL multi body n10 k20", () => {
	const lines = Array.from({ length: 10 }, (_, i) => `L${i + 1}`);
	const base = lines.join("\n");
	const body = Array.from({ length: 20 }, (_, i) => `+I${i + 1}`).join("\n");
	const inserted = Array.from({ length: 20 }, (_, i) => `I${i + 1}`);

	it("HEAD", () => {
		const out = applyEdits(base, parsePatch(`INS.HEAD:\n${body}`).edits).text.split("\n");
		expect(out).toEqual([...inserted, ...lines]);
	});

	it("TAIL", () => {
		const out = applyEdits(base, parsePatch(`INS.TAIL:\n${body}`).edits).text.split("\n");
		expect(out).toEqual([...lines, ...inserted]);
	});
});
