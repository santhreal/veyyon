/**
 * `*** Begin Patch` is consumed and does not become a warning or an edit.
 *
 * WHY THIS SUITE EXISTS. Some models wrap a hashline payload in a
 * unified-diff-style envelope. The begin marker is optional and silent: if
 * it were treated as a raw line it would fail the "ops only" parse, and if
 * it warned, the model would strip a marker the operator's paste still
 * includes. A begin marker AFTER the first hunk is still consumed (it is
 * not an end). Only `*** End Patch` / `*** Abort` stop the parse.
 */
import { describe, expect, it } from "bun:test";
import { BEGIN_PATCH_MARKER } from "../src/messages";
import { parsePatch } from "../src/parser";

describe("Begin Patch is a silent envelope start", () => {
	it("a payload wrapped in Begin/End Patch parses the inner INS.HEAD", () => {
		const parsed = parsePatch(`${BEGIN_PATCH_MARKER}\nINS.HEAD:\n+x\n*** End Patch\n`);
		expect(parsed.warnings).toEqual([]);
		expect(parsed.edits).toHaveLength(1);
		expect(parsed.edits[0]?.kind).toBe("insert");
	});

	it("a Begin Patch with no following ops is an empty edit list, not an error warning", () => {
		const parsed = parsePatch(`${BEGIN_PATCH_MARKER}\n`);
		expect(parsed.edits).toEqual([]);
		expect(parsed.warnings).toEqual([]);
	});

	it("a second Begin Patch in the middle does not terminate the parse", () => {
		const parsed = parsePatch(`INS.HEAD:\n+a\n${BEGIN_PATCH_MARKER}\nINS.TAIL:\n+b\n`);
		expect(parsed.edits).toHaveLength(2);
		expect(parsed.warnings).toEqual([]);
	});

	it("*** Begin Patch extra is not the marker: it is a raw line and fails loud", () => {
		expect(() => parsePatch("*** Begin Patch extra\nINS.HEAD:\n+x\n")).toThrow(/no preceding hunk header/);
	});
});
