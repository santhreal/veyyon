/**
 * detectLineEnding first-match matrix.
 */
import { describe, expect, it } from "bun:test";
import { detectLineEnding } from "../src/normalize";

describe("detectLineEnding matrix", () => {
	const cases: Array<[string, "\n" | "\r\n"]> = [
		["", "\n"],
		["no nl", "\n"],
		["a\nb", "\n"],
		["a\r\nb", "\r\n"],
		["a\r\nb\nc", "\r\n"],
		["a\nb\r\nc", "\n"],
		["\n", "\n"],
		["\r\n", "\r\n"],
		["mixed\r\nearly\nlater", "\r\n"],
		["mixed\nearly\r\nlater", "\n"],
	];
	for (const [input, want] of cases) {
		it(`${JSON.stringify(input)} -> ${JSON.stringify(want)}`, () => {
			expect(detectLineEnding(input)).toBe(want);
		});
	}
});
