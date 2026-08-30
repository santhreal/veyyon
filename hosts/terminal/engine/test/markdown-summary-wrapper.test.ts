import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { clearRenderCache, Markdown } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const WIDTH = 80;

function visibleLines(markdown: string): string[] {
	return new Markdown(markdown, 0, 0, defaultMarkdownTheme)
		.render(WIDTH)
		.map(line => stripVTControlCharacters(line).trimEnd())
		.filter(line => line !== "");
}

describe("Markdown summary wrapper rendering", () => {
	/** Compaction context uses standalone summary tags, which must not leak into the transcript. */
	it("renders a multiline summary wrapper as its body only", () => {
		expect(visibleLines("<summary>\nFirst line\nSecond line\n</summary>")).toEqual(["First line", "Second line"]);
	});

	/** Inline wrappers must preserve surrounding prose instead of introducing or deleting separators. */
	it("removes inline summary tags without changing their text", () => {
		expect(visibleLines("before <summary>visible</summary> after")).toEqual(["before visible after"]);
	});

	/** Provider-authored wrapper capitalization and attributes must follow HTML's case-insensitive syntax. */
	it("removes attributed mixed-case summary tags", () => {
		expect(visibleLines('<SUMMARY data-source="compaction">body</SUMMARY>')).toEqual(["body"]);
	});

	/** A pause-time append render must converge to the same output as a cold render after the closing tag arrives. */
	it("keeps streamed summary rendering equivalent to a cold render", () => {
		clearRenderCache();
		const streamed = new Markdown("<summary>\nAlpha", 0, 0, defaultMarkdownTheme);
		streamed.transientRenderCache = true;
		streamed.render(WIDTH);
		streamed.setText("<summary>\nAlpha\n\nBeta");
		streamed.render(WIDTH);
		const complete = "<summary>\nAlpha\n\nBeta\n</summary>";
		streamed.setText(complete);

		const streamedLines = streamed.render(WIDTH);
		clearRenderCache();
		const coldLines = new Markdown(complete, 0, 0, defaultMarkdownTheme).render(WIDTH);
		expect(streamedLines).toEqual(coldLines);
		expect(streamedLines.map(line => stripVTControlCharacters(line)).join("\n")).not.toContain("summary>");
	});

	/** Code examples must keep literal summary tags because fenced code is not terminal HTML. */
	it("preserves summary tags inside fenced code", () => {
		const text = visibleLines("```html\n<summary>literal</summary>\n```").join("\n");
		expect(text).toContain("<summary>literal</summary>");
	});

	/** Unknown model tags remain visible so this narrow fix cannot silently erase diagnostic content. */
	it("continues to render unknown wrapper tags verbatim", () => {
		expect(visibleLines("<thinking>diagnostic</thinking>")).toEqual(["<thinking>diagnostic</thinking>"]);
	});
});
