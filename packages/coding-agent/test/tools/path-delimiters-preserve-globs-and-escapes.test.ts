import { describe, expect, it } from "bun:test";
import { findTopLevelPathDelimiter, splitTopLevelDelimitedPath } from "@veyyon/coding-agent/tools/core/path-utils";

/**
 * Shared scanning must preserve glob nesting, escaping and each separator policy.
 * The filesystem expansion and read-group suites cover resolution and presentation;
 * this suite covers lexical boundaries and progress without filesystem state.
 */
type ScanMode = Parameters<typeof findTopLevelPathDelimiter>[2];
const whitespace = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).filter(
	character => character.trim() === "",
);
const separatorsByMode = {
	comma: [","],
	semicolon: [";"],
	whitespace,
	mixed: [",", ";", ...whitespace],
	punctuation: [",", ";"],
} satisfies Record<ScanMode, readonly string[]>;

for (const mode of Object.keys(separatorsByMode) as ScanMode[]) {
	describe(`${mode} path delimiters`, () => {
		it("skips nested glob and escaped separators, then advances through every remaining boundary", () => {
			for (const separator of separatorsByMode[mode]) {
				const first = `src/{a${separator}{b${separator}c}${separator}d}/file\\${separator}name`;
				const input = `${first}${separator}next${separator}`;
				const secondBoundary = first.length + separator.length + "next".length;
				expect(findTopLevelPathDelimiter(input, 0, mode)).toBe(first.length);
				expect(findTopLevelPathDelimiter(input, first.length + separator.length, mode)).toBe(secondBoundary);
				expect(findTopLevelPathDelimiter(input, input.length, mode)).toBe(-1);
				if (mode !== "punctuation") expect(splitTopLevelDelimitedPath(input, mode)).toEqual([first, "next", ""]);
			}
		});

		it("keeps unmatched open braces and escaped closing braces distinct from unmatched closing braces", () => {
			for (const separator of separatorsByMode[mode]) {
				const escapedClose = `{left\\}${separator}right}`;
				expect(findTopLevelPathDelimiter(`${escapedClose}${separator}next`, 0, mode)).toBe(escapedClose.length);
				expect(findTopLevelPathDelimiter(`{left${separator}right`, 0, mode)).toBe(-1);
				expect(findTopLevelPathDelimiter(`}left${separator}right`, 0, mode)).toBe("}left".length);
				expect(findTopLevelPathDelimiter(`\\{left${separator}right`, 0, mode)).toBe("\\{left".length);
			}
		});

		it("preserves empty entries and a trailing backslash", () => {
			for (const separator of separatorsByMode[mode]) {
				expect(findTopLevelPathDelimiter(`${separator}last\\`, 1, mode)).toBe(-1);
				if (mode !== "punctuation") {
					expect(splitTopLevelDelimitedPath(`${separator}${separator}last\\`, mode)).toEqual(["", "", "last\\"]);
				}
			}
		});

		it("does not accept another mode's separators", () => {
			for (const separator of separatorsByMode.mixed) {
				if (separatorsByMode[mode].includes(separator)) continue;
				expect(findTopLevelPathDelimiter(`left${separator}right`, 0, mode)).toBe(-1);
			}
		});
	});
}

it("rejects invalid scan offsets before entering the loop", () => {
	for (const offset of [-Infinity, Infinity, NaN, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
		expect(() => findTopLevelPathDelimiter("first,next", offset, "mixed")).toThrow(
			"Path scan start must be a non-negative safe integer",
		);
	}
	expect(findTopLevelPathDelimiter("first,next", Number.MAX_SAFE_INTEGER, "mixed")).toBe(-1);
	expect(findTopLevelPathDelimiter("", 0, "mixed")).toBe(-1);
});
