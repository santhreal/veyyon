/**
 * MV destinations: paths with dashes, slashes, extensions.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../src/parser";

describe("parsePatch MV dest matrix", () => {
	const dests = [
		"a.ts",
		"src/a.ts",
		"path-with-dash.ts",
		"under_score.ts",
		"pkg/nested/deep.ts",
		"file.tsx",
		"file.mjs",
	];
	for (const dest of dests) {
		it(`MV ${dest}`, () => {
			const { fileOp, edits } = parsePatch(`MV ${dest}`);
			expect(edits).toEqual([]);
			expect(fileOp).toEqual({ kind: "move", dest });
		});
	}
});
