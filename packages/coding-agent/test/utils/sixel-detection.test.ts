import { describe, expect, it } from "bun:test";
import { containsSixelSequence, getSixelLineMask, isSixelLine } from "@veyyon/coding-agent/utils/sixel";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const SIXEL_START = `${ESC}Pq`;
const SIXEL_START_WITH_PARAMS = `${ESC}P0;1q`;
const SIXEL_END = `${ESC}\\`;

/**
 * The SIXEL detection helpers decide which terminal output lines are raw image control
 * sequences that must be preserved verbatim rather than sanitized. Only the composed
 * sanitizeWithOptionalSixelPassthrough had a test; the primitives it relies on did not.
 * getSixelLineMask in particular is a line-spanning state machine: a regression that loses
 * the "still inside a sequence" state would sanitize the middle of a multi-line SIXEL image
 * and corrupt it. Pinned:
 *   - containsSixelSequence / isSixelLine detect the `ESC P … q` start (with or without
 *     numeric params) and nothing else;
 *   - getSixelLineMask marks the start line and every following line true until a line
 *     containing the String Terminator (ESC \) or a BEL closes the block; an unterminated
 *     block stays marked to EOF.
 */

describe("containsSixelSequence / isSixelLine", () => {
	it("detects a SIXEL start sequence with or without numeric params", () => {
		expect(containsSixelSequence(`hi ${SIXEL_START}data`)).toBe(true);
		expect(isSixelLine(`${SIXEL_START_WITH_PARAMS}x`)).toBe(true);
	});

	it("returns false for plain text with no start sequence", () => {
		expect(containsSixelSequence("plain text")).toBe(false);
		expect(isSixelLine("nope")).toBe(false);
	});
});

describe("getSixelLineMask", () => {
	it("marks the start line through the String-Terminator line of a multi-line block", () => {
		const lines = ["before", `${SIXEL_START}row1`, "row2", `row3${SIXEL_END}`, "after"];
		expect(getSixelLineMask(lines)).toEqual([false, true, true, true, false]);
	});

	it("closes the block on a BEL terminator on the same line as the start", () => {
		expect(getSixelLineMask(["a", `${SIXEL_START_WITH_PARAMS}d${BEL}`, "b"])).toEqual([false, true, false]);
	});

	it("keeps an unterminated block marked through to the end of input", () => {
		expect(getSixelLineMask(["x", `${SIXEL_START}d`, "y"])).toEqual([false, true, true]);
	});
});
