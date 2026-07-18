/**
 * Table inter-row rules: a grid line after every single-line row doubled the
 * height of every table in the product (the /hotkeys table was 2x tall). Rules
 * are drawn only around rows whose cells wrap to multiple lines, where they
 * visually group the wrapped row; single-line tables get header + outer border
 * only.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { Markdown } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

function renderPlain(text: string, width: number): string[] {
	return new Markdown(text, 0, 0, defaultMarkdownTheme)
		.render(width)
		.map(line => stripVTControlCharacters(line).trimEnd());
}

// Border/rule lines carry no cell text — only frame glyphs (ASCII test theme
// uses +/-, shipped themes use ┌─├). Top border + header rule + bottom border
// are always present; anything beyond 3 is an inter-row rule.
const frameLineCount = (lines: string[]) =>
	lines.filter(line => line.length > 0 && /^[+\-┌┐└┘├┤┬┴┼─]+$/.test(line)).length;

describe("Markdown table inter-row rules", () => {
	it("draws no rules between single-line rows: header rule only", () => {
		const lines = renderPlain("| Key | Action |\n|---|---|\n| a | one |\n| b | two |\n| c | three |", 60);
		expect(frameLineCount(lines)).toBe(3);
		// 3 body rows + header + the 3 frame lines = 7 painted lines.
		expect(lines.filter(line => line.length > 0)).toHaveLength(7);
	});

	it("keeps rules around a row whose cell wraps to multiple lines", () => {
		const long = "this cell is far too long to fit and must wrap across several lines";
		const lines = renderPlain(`| Key | Action |\n|---|---|\n| a | one |\n| b | ${long} |\n| c | three |`, 30);
		// The 3 standing frame lines + a rule on each side of the wrapped middle row.
		expect(frameLineCount(lines)).toBe(5);
	});
});
