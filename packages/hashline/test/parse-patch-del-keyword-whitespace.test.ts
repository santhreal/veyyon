/**
 * DEL parsing tolerates no trailing junk; exact line from keyword form.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch DEL keyword forms", () => {
	it("DEL N", () => {
		const { edits } = parsePatch("DEL 42");
		expect(edits).toHaveLength(1);
		if (edits[0]?.kind === "delete") expect(edits[0].anchor.line).toBe(42);
	});

	it("DEL N.=M", () => {
		const { edits } = parsePatch("DEL 10.=12");
		expect(
			edits.filter(e => e.kind === "delete").map(e => (e.kind === "delete" ? e.anchor.line : 0)),
		).toEqual([10, 11, 12]);
	});

	it("DEL 1 is valid", () => {
		const { edits } = parsePatch("DEL 1");
		if (edits[0]?.kind === "delete") expect(edits[0].anchor.line).toBe(1);
	});
});
