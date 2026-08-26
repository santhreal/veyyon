/**
 * The driver for the inline markdown oracle registry.
 *
 * WHY THIS EXISTS:
 * `renderInlineMarkdown` is reached with two shapes of caller: nine call sites hand it a base colour
 * so the label reads in the colour the row's state chose, and three hand it none. Both shapes go
 * through the same lexer and the same token walk, so a defect in either is a defect in a row somebody
 * looks at. A sweep that drove only the coloured shape would not see a fragment that paints its cells
 * with no attribute open, and a sweep that drove only the bare shape would not see a base colour that
 * changes which cells are painted.
 *
 * WHAT A CASE IS:
 * One source and one caller shape. Everything else an oracle needs is a further render of the same
 * source, and the state carries those so no oracle drives the renderer it judges.
 */

import { renderInlineMarkdown, visibleWidth } from "@veyyon/tui";
import type {
	InlineMarkdownEvaluationResult,
	InlineMarkdownOracleFrameState,
} from "../../../src/modes/components/defect-oracles";
import { evaluateAllInlineMarkdownOracles } from "../../../src/modes/components/defect-oracles";
import { getMarkdownTheme } from "../../../src/modes/theme/markdown-theme";

/**
 * The sources.
 *
 * Each is a construct that has broken a lexer, a style walk or a row somewhere, or a shape a label
 * reaching this function actually carries: a model-written option label, a hook description from
 * configuration, a file path, a diagnostic quoting terminal output.
 */
export const INLINE_SOURCES: Readonly<Record<string, string>> = {
	plain: "just words",
	bold: "a **bold** word",
	italic: "an _italic_ word",
	code: "a `code` span",
	link: "see [the docs](https://example.com/a/very/long/path)",
	bareUrl: "see https://example.com/a/very/long/path",
	strike: "a ~~struck~~ word",
	nested: "**bold _and italic_** tail",
	twoLines: "first line\nsecond line",
	twoParagraphs: "first para\n\nsecond para",
	tab: "before\tafter",
	crlf: "a\r\nb",
	contentSgr: "content \x1b[31mred\x1b[0m bytes",
	contentSgrUnterminated: "content \x1b[31m unterminated",
	contentOscLink: "osc \x1b]8;;http://example.com\x07link\x1b]8;;\x07 tail",
	contentBell: "a \x07 bell",
	contentCsiCursor: "move \x1b[2A up",
	// A source that supplies the exact sequence the base colour closes with. A surplus computed as a set
	// difference rather than a multiset one cannot see this: the theme emits the same bytes, so the
	// source's copy hides inside the theme's. This is the sequence a hostile label would choose.
	contentSgrMimic: "content \x1b[39m mimic",
	bullets: "- one\n- two\n- three",
	ordered: "1. one\n2. two",
	heading: "# Heading text",
	fence: "```ts\nconst value = 1;\n```",
	inlineFenceMarker: "a ```ts marker mid label",
	entity: "alpha &amp; beta &lt; gamma",
	wideGlyphs: "毎日 **漢字** です",
	zwjFamily: "a 👨‍👩‍👧‍👦 family",
	math: "inline $x^2$ math",
	html: "a <b>tagged</b> word",
	htmlComment: "<!-- hidden -->",
	nul: "alpha\u0000beta",
	loneSurrogate: "alpha\ud800beta",
	empty: "",
	blank: "   ",
	underscoreWord: "snake_case_name stays intact",
	starMath: "5 * 3 * 2 equals thirty",
	backtickUnclosed: "a `code span that never closes",
	asteriskUnclosed: "a **bold that never closes",
	table: "| alpha | beta |\n| - | - |\n| one | two |",
	blockquote: "> quoted line",
	rule: "---",
	checkbox: "- [ ] todo item\n- [x] done item",
	homePath: "/home/someone/projects/thing/src/main.ts",
	longWord: `word${"x".repeat(200)}`,
	onlyMarkup: "**__``__**",
	escapedStar: "a \\*literal\\* star",
	imageRef: "an ![alt text](https://example.com/pic.png) image",
};

export const INLINE_SOURCE_NAMES: readonly string[] = Object.keys(INLINE_SOURCES);

/** The caller shapes, which is the axis the twelve call sites divide on. */
export const INLINE_CALLER_SHAPES = ["based", "bare"] as const;

export type InlineCallerShape = (typeof INLINE_CALLER_SHAPES)[number];

export interface InlineMarkdownCase {
	/** A key of `INLINE_SOURCES`. */
	fixture: string;
	/** Whether the caller supplies a base colour. */
	shape: InlineCallerShape;
}

/**
 * The base colour a call site supplies.
 *
 * A real caller passes `theme.fg(token, text)`, which is an extended-colour open and a foreground
 * reset around the text. This is that shape with a fixed colour, so a sweep does not depend on which
 * theme happens to be loaded while still exercising the wrapping the callers do.
 */
const BASE_COLOUR_OPEN = "\x1b[38;5;250m";
const BASE_COLOUR_CLOSE = "\x1b[39m";

const baseColour = (text: string): string => `${BASE_COLOUR_OPEN}${text}${BASE_COLOUR_CLOSE}`;

/** Every escape byte removed, which is the control the content-escape guarantee compares against. */
function withoutEscapes(source: string): string {
	return source.replaceAll("\x1b", "");
}

/** Build the state for one case, rendering everything an oracle may need to compare against. */
export function inlineMarkdownStateFor(spec: InlineMarkdownCase): InlineMarkdownOracleFrameState {
	const source = INLINE_SOURCES[spec.fixture];
	if (source === undefined) {
		throw new Error(
			`unknown inline markdown fixture ${JSON.stringify(spec.fixture)}; the known ones are ${INLINE_SOURCE_NAMES.join(", ")}`,
		);
	}
	const mdTheme = getMarkdownTheme();
	const hasBaseColour = spec.shape === "based";
	const render = (text: string): string =>
		hasBaseColour ? renderInlineMarkdown(text, mdTheme, baseColour) : renderInlineMarkdown(text, mdTheme);
	return {
		fixture: spec.fixture,
		source,
		hasBaseColour,
		fragment: render(source),
		fragmentFromASecondRender: render(source),
		fragmentWithNoBaseColour: renderInlineMarkdown(source, mdTheme),
		fragmentFromSourceWithNoEscapes: render(withoutEscapes(source)),
		widthOf: visibleWidth,
	};
}

/** Judge one case. */
export function evaluateInlineMarkdownCase(spec: InlineMarkdownCase): InlineMarkdownEvaluationResult {
	return evaluateAllInlineMarkdownOracles(inlineMarkdownStateFor(spec));
}

/** Every case the sweep drives: each source in each caller shape. */
export function inlineMarkdownCases(): readonly InlineMarkdownCase[] {
	const cases: InlineMarkdownCase[] = [];
	for (const fixture of INLINE_SOURCE_NAMES) {
		for (const shape of INLINE_CALLER_SHAPES) cases.push({ fixture, shape });
	}
	return cases;
}
