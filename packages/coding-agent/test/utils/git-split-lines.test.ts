import { describe, expect, it } from "bun:test";
import { splitLines } from "@veyyon/coding-agent/utils/git";

/**
 * splitLines turns the raw stdout of a git command into a clean list of non-empty, trimmed lines.
 * It is used throughout the git layer to parse porcelain/short output where blank lines and trailing
 * whitespace are noise. It had no direct test. The contract: split on newlines, trim each line, and
 * drop every line that is empty after trimming. A regression that skipped the trim would leak
 * whitespace into parsed refs/paths; one that skipped the filter would yield phantom empty entries
 * that downstream callers (counting branches, listing files) would miscount.
 */
describe("splitLines", () => {
	it("splits on newlines, trims each line, and drops blank lines", () => {
		expect(splitLines("  a \n\nb\n  \n c ")).toEqual(["a", "b", "c"]);
	});

	it("returns an empty array for empty or whitespace-only input", () => {
		expect(splitLines("")).toEqual([]);
		expect(splitLines("\n\n")).toEqual([]);
		expect(splitLines("   \n\t")).toEqual([]);
	});

	it("returns a single trimmed line when there are no newlines", () => {
		expect(splitLines("  only  ")).toEqual(["only"]);
	});
});
