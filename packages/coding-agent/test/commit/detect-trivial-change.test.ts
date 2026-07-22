import { describe, expect, it } from "bun:test";
import { detectTrivialChange } from "../../src/commit/agentic/trivial";

/**
 * detectTrivialChange is the fast path that skips the model for diffs that are
 * obviously trivial: a purely whitespace/formatting change becomes
 * style/"formatted code", and a change touching only import/export/require lines
 * becomes style/"reorganized imports". Everything else returns null so the real
 * analyzer runs. It had no test. Getting this wrong either wastes a model call
 * on a trivial diff or, worse, mislabels a real code change as trivial, so the
 * boundaries are pinned exactly here.
 *
 * Key contracts:
 *   - diff headers (`+++`, `---`, `@@`) are not content and are ignored;
 *   - a diff with no add/remove content lines is null (nothing to classify);
 *   - whitespace detection keys on the line CONTENT (after the +/-), so a real
 *     token makes it non-trivial;
 *   - import detection skips blank added/removed lines but rejects any non-import
 *     content line;
 *   - whitespace is checked before imports.
 */

const diff = (...lines: string[]): string => lines.join("\n");

describe("detectTrivialChange", () => {
	it("classifies a purely whitespace change as style/'formatted code'", () => {
		expect(detectTrivialChange(diff("@@ -1,2 +1,2 @@", "+   ", "-\t"))).toEqual({
			isTrivial: true,
			type: "style",
			summary: "formatted code",
		});
	});

	it("classifies an import-only change as style/'reorganized imports'", () => {
		expect(
			detectTrivialChange(
				diff('-import a from "a"', '+import a from "b"', '+export { x } from "y"', '+require("fs")'),
			),
		).toEqual({ isTrivial: true, type: "style", summary: "reorganized imports" });
	});

	it("treats blank added/removed lines as compatible with an import-only change", () => {
		// The blank line is skipped by the import check rather than failing it.
		expect(detectTrivialChange(diff('+import a from "a"', "+   "))).toEqual({
			isTrivial: true,
			type: "style",
			summary: "reorganized imports",
		});
	});

	it("returns null when imports are mixed with real code", () => {
		expect(detectTrivialChange(diff('+import a from "a"', "+const x = 1"))).toBeNull();
	});

	it("returns null for a substantive code-only change", () => {
		expect(detectTrivialChange(diff("+const x = 1", "-const x = 0"))).toBeNull();
	});

	it("returns null when a whitespace line also carries a real token", () => {
		// content after '+' is "  x", which trims to "x" -> not whitespace-only.
		expect(detectTrivialChange(diff("-  x", "+    x"))).toBeNull();
	});

	it("returns null when the diff has only headers and no content lines", () => {
		expect(detectTrivialChange(diff("+++ b/file.ts", "--- a/file.ts", "@@ -1 +1 @@"))).toBeNull();
	});

	it("returns null when there are no add/remove lines at all", () => {
		expect(detectTrivialChange(diff("context line", "another context line"))).toBeNull();
	});
});
