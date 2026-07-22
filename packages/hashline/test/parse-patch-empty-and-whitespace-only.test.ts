/**
 * parsePatch empty / whitespace: no edits or throws — exact shipped behavior.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "@veyyon/hashline";

describe("parsePatch empty and whitespace", () => {
	it("empty string yields no edits", () => {
		const r = parsePatch("");
		expect(r.edits).toEqual([]);
	});

	it("whitespace only yields no edits", () => {
		const r = parsePatch("   \n\t\n  ");
		expect(r.edits).toEqual([]);
	});

	it("bare body without hunk header throws", () => {
		expect(() => parsePatch("just some text\nnot an op")).toThrow(
			/no preceding hunk header|payload line/i,
		);
	});
});
