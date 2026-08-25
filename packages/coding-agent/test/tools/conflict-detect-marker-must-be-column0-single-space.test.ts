/**
 * Conflict markers are column-0, exact prefix length, then EOL or one space.
 *
 * WHY THIS SUITE EXISTS. `matchMarker` is `startsWith(prefix)` plus either
 * end-of-line or `charCodeAt(prefix.length) === 32`. That is stricter than
 * "looks like a git conflict": a tab, NBSP, colon, or glued label is a
 * lookalike, not a marker. The existing suite pins indent and `<<<<<<<x`.
 * These cases pin the characters that are not a space and the two-space
 * label (which IS a marker whose label includes the extra space).
 *
 * CRLF is already owned: trailing `\r` is stripped before the label. This
 * file does not re-test that.
 */
import { describe, expect, it } from "bun:test";
import { scanConflictLines } from "@veyyon/coding-agent/tools/conflict-detect";

const closed = (ours: string, theirs: string, oursLabel = "HEAD", theirsLabel = "feat") => [
	oursLabel ? `<<<<<<< ${oursLabel}` : "<<<<<<<",
	ours,
	"=======",
	theirs,
	theirsLabel ? `>>>>>>> ${theirsLabel}` : ">>>>>>>",
];

describe("a character other than ASCII space after the prefix is not a marker", () => {
	it("tab between <<<<<<< and HEAD is ignored, so a well-formed block later still parses alone", () => {
		const blocks = scanConflictLines(
			["<<<<<<<\tHEAD", "ours-tab", "=======", "theirs-tab", ">>>>>>>\tfeat", ...closed("real-ours", "real-theirs")],
			1,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].oursLabel).toBe("HEAD");
		expect(blocks[0].oursLines).toEqual(["real-ours"]);
		expect(blocks[0].theirsLines).toEqual(["real-theirs"]);
		expect(blocks[0].startLine).toBe(6);
	});

	it("NBSP after the prefix is ignored", () => {
		const nbsp = "\u00a0";
		const blocks = scanConflictLines(
			[`<<<<<<<${nbsp}HEAD`, "o", "=======", "t", `>>>>>>>${nbsp}feat`],
			1,
		);
		expect(blocks).toEqual([]);
	});

	it("a colon after the prefix (<<<<<<<:HEAD) is ignored", () => {
		const blocks = scanConflictLines(["<<<<<<<:HEAD", "o", "=======", "t", ">>>>>>>:feat"], 1);
		expect(blocks).toEqual([]);
	});

	it("a glued label (<<<<<<<HEAD, no separator) is ignored", () => {
		const blocks = scanConflictLines(["<<<<<<<HEAD", "o", "=======", "t", ">>>>>>>feat"], 1);
		expect(blocks).toEqual([]);
	});

	it("eight equals is not the separator (prefix is exactly seven)", () => {
		const blocks = scanConflictLines(["<<<<<<< HEAD", "o", "========", "t", ">>>>>>> feat"], 1);
		expect(blocks).toEqual([]);
	});

	it("six angles is not an opener", () => {
		const blocks = scanConflictLines(["<<<<<< HEAD", "o", "=======", "t", ">>>>>> feat"], 1);
		expect(blocks).toEqual([]);
	});
});

describe("two ASCII spaces after the prefix ARE a marker; the extra space is part of the label", () => {
	it("keeps the leading space on the label rather than treating the line as malformed", () => {
		const blocks = scanConflictLines(["<<<<<<<  HEAD", "o", "=======", "t", ">>>>>>>  feat"], 1);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].oursLabel).toBe(" HEAD");
		expect(blocks[0].theirsLabel).toBe(" feat");
	});
});

describe("separator must itself be column-0 equals-seven", () => {
	it("an indented ======= inside a real block is body, so the block never closes on it", () => {
		const blocks = scanConflictLines(
			["<<<<<<< HEAD", "o", " =======", "still-ours", "=======", "t", ">>>>>>> feat"],
			1,
		);
		expect(blocks).toHaveLength(1);
		expect(blocks[0].oursLines).toEqual(["o", " =======", "still-ours"]);
		expect(blocks[0].theirsLines).toEqual(["t"]);
	});
});
