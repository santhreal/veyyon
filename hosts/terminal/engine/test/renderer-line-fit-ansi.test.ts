import { describe, expect, it } from "bun:test";
import { prepareLine } from "@veyyon/tui/core/renderer";

describe("prepareLine ANSI preservation", () => {
	it("preserves ANSI color and styling escape sequences when line exceeds source length threshold", () => {
		// Construct a line exceeding LINE_FIT_MIN_SOURCE_CODE_UNITS (4096) with ANSI SGR styling
		const styledWord = "\x1b[31;1mredbold\x1b[0m";
		// Repeating the styled word to exceed 4096 chars
		const longStyledLine = styledWord.repeat(300);
		expect(longStyledLine.length).toBeGreaterThan(4096);

		const prepared = prepareLine(longStyledLine, 80);
		// The prepared line must retain the ANSI styling sequences (\x1b[31;1m) rather than having stripped them
		expect(prepared.line).toContain("\x1b[31;1m");
		expect(prepared.line).toContain("\x1b[0m");
	});
});
