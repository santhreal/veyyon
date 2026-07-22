import { describe, expect, it } from "bun:test";
import { formatMatchLine } from "@veyyon/coding-agent/tools/match-line-format";

/**
 * Grep/ast-grep renderers depend on the exact marker + separator so hashline
 * mode stays editable (`N:content`) and plain mode stays display-only (`N|content`).
 * A swapped separator breaks hashline apply and column alignment.
 */
describe("formatMatchLine", () => {
	it("formats a match line in plain mode with star and pipe", () => {
		expect(formatMatchLine(12, "const x = 1;", true, { useHashLines: false })).toBe("*12|const x = 1;");
	});

	it("formats a context line in plain mode with space and pipe", () => {
		expect(formatMatchLine(13, "return x;", false, { useHashLines: false })).toBe(" 13|return x;");
	});

	it("formats a match line in hashline mode with star and colon", () => {
		expect(formatMatchLine(1, "export {}", true, { useHashLines: true })).toBe("*1:export {}");
	});

	it("formats a context line in hashline mode with space and colon", () => {
		expect(formatMatchLine(2, "", false, { useHashLines: true })).toBe(" 2:");
	});

	it("never left-pads line numbers (column alignment is the marker width only)", () => {
		expect(formatMatchLine(1, "a", true, { useHashLines: false })).toBe("*1|a");
		expect(formatMatchLine(1000, "a", true, { useHashLines: false })).toBe("*1000|a");
		expect(formatMatchLine(9, "a", false, { useHashLines: true })).toBe(" 9:a");
	});

	it("preserves unicode and leading spaces in the line body", () => {
		expect(formatMatchLine(3, "  日本語", true, { useHashLines: true })).toBe("*3:  日本語");
		expect(formatMatchLine(4, "\tindent", false, { useHashLines: false })).toBe(" 4|\tindent");
	});
});
