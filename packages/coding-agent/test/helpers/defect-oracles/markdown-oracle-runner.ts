/**
 * Drive the real `Markdown` component and hand each render to the oracle registry.
 *
 * The component is the one the product paints from, constructed the way its call sites construct it,
 * and the theme comes from `getMarkdownTheme()` after `initTheme`. Nothing here reimplements a wrap or
 * a width: the oracles read the product's own `visibleWidth`.
 */

import { Markdown, visibleWidth } from "@veyyon/tui";
import {
	evaluateAllMarkdownOracles,
	type MarkdownEvaluationResult,
	type MarkdownOracleFrameState,
} from "../../../src/modes/components/defect-oracles";
import { getMarkdownTheme } from "../../../src/modes/theme/markdown-theme";

/**
 * The sources. Each is a construct that has broken a wrap, a cache or a lexer somewhere: nesting that
 * recurses, a fence that never closes, a fence around a fence, CRLF, escape bytes inside code, a table
 * whose cells are wider than any terminal, a link whose URL is longer than the row, hard breaks, and
 * bytes that are not text.
 */
export const MARKDOWN_FIXTURES: Readonly<Record<string, string>> = {
	paragraph: "A paragraph of ordinary prose that has to wrap somewhere sensible when the terminal is narrow.",
	headings: "# Title\n\n## Section\n\ntext under it\n\n### Deeper\n\nmore",
	bullets: "- first item\n- second item that is long enough to wrap at a narrow width\n  - nested item\n- third",
	ordered: "1. one\n2. two\n3. three with a much longer body that wraps",
	deepList: "- a\n  - b\n    - c\n      - d\n        - e\n          - f",
	deepQuote: "> l1\n> > l2\n> > > l3\n> > > > l4",
	fence: "before\n\n```ts\nconst x: number = 1;\nfunction f() { return x; }\n```\n\nafter",
	fenceNoLanguage: "```\nplain block\n  indented\n```",
	unclosedFence: "text\n\n```ts\nconst a = 1;\nconst b = 2;",
	fenceInFence: "````\n```\ninner\n```\n````",
	ansiInCode: '```\nconst s = "\\x1b[31mred\\x1b[0m";\n```',
	table: "| col a | col b |\n| --- | --- |\n| 1 | 2 |\n| long cell value here | another long cell |",
	wideTable: `| ${"a".repeat(60)} | ${"b".repeat(60)} |\n| --- | --- |\n| 1 | 2 |`,
	quote: "> quoted line one\n> quoted line two that is long enough to wrap somewhere\n\nafter",
	inline: "text with `code`, **bold**, *em*, ~~del~~ and a [link](https://example.com/very/long/path).",
	longUrl: "see [the docs](https://example.com/a/very/long/url/that/wraps) for more",
	wideGlyphs: "漢字漢字漢字 mixed with ascii 漢字漢字漢字漢字漢字漢字漢字漢字",
	zwjEmoji: "👩‍👩‍👧‍👦 family and 👨🏽‍💻 dev in a paragraph that wraps",
	tabs: "a line with\ttabs\tin it",
	crlf: "line one\r\n\r\nline two\r\nline three",
	hardBreaks: "# Heading   \n\nbody   \nwith hard break  \nend",
	rule: "above\n\n---\n\nbelow",
	longWord: "supercalifragilisticexpialidociousandthensomemorebesidesthatnevereverends",
	rawHtml: "<div>raw html</div>\n\ntext",
	htmlComment: "<!-- hidden -->\n\nvisible",
	mathBlock: "$$\n\\frac{a}{b} = c\n$$\n\ntext",
	mermaid: "```mermaid\ngraph TD\n  A --> B\n```",
	checklist: "- [ ] todo item\n- [x] done item",
	nulByte: "text with a \u0000 nul byte",
	loneSurrogate: "text with a lone \ud800 surrogate",
	empty: "",
} as const;

/** The widths the sweep drives, ascending, so each state can read the next one. */
export const MARKDOWN_WIDTHS = [1, 5, 10, 20, 40, 80, 200] as const;

/** The horizontal paddings the sweep drives. Two is what the assistant message uses. */
export const MARKDOWN_PADDINGS = [0, 2] as const;

/** Everything a state is built from, and the axis a corpus case records. */
export interface MarkdownCase {
	fixture: string;
	width: number;
	paddingX: number;
}

function render(source: string, width: number, paddingX: number): readonly string[] {
	return new Markdown(source, paddingX, 0, getMarkdownTheme()).render(width);
}

/** The largest blank-line-bounded prefix of a source, or `null` when it has no blank line. */
function frozenPrefixOf(source: string): string | null {
	const at = source.lastIndexOf("\n\n");
	return at === -1 ? null : source.slice(0, at + 2);
}

/** Build the state one render produces, driving the real component. */
export function markdownStateFor(spec: MarkdownCase): MarkdownOracleFrameState {
	const source = MARKDOWN_FIXTURES[spec.fixture];
	if (source === undefined) {
		throw new Error(`fixture ${spec.fixture} is not one the runner drives.`);
	}
	const rows = render(source, spec.width, spec.paddingX);

	// The resize arm needs one instance, rendered at another width and back. Which other width does not
	// matter as long as it is not this one, so the widest is used unless this is the widest.
	const otherWidth = spec.width === MARKDOWN_WIDTHS.at(-1) ? MARKDOWN_WIDTHS[0] : MARKDOWN_WIDTHS.at(-1);
	const instance = new Markdown(source, spec.paddingX, 0, getMarkdownTheme());
	instance.render(spec.width);
	instance.render(otherWidth ?? spec.width);

	const nextWidth = MARKDOWN_WIDTHS[MARKDOWN_WIDTHS.indexOf(spec.width as (typeof MARKDOWN_WIDTHS)[number]) + 1];
	const prefixText = frozenPrefixOf(source);

	return {
		fixture: spec.fixture,
		source,
		width: spec.width,
		paddingX: spec.paddingX,
		rows,
		rowsFromASecondInstance: render(source, spec.width, spec.paddingX),
		rowsAfterAResize: instance.render(spec.width),
		rowsAtTheNextWidth: nextWidth === undefined ? null : render(source, nextWidth, spec.paddingX),
		prefix: prefixText === null ? null : { text: prefixText, rows: render(prefixText, spec.width, spec.paddingX) },
		sourceHasATable: /^\s*\|/m.test(source),
		widthOf: visibleWidth,
	};
}

/** Judge one render. */
export function evaluateMarkdownCase(spec: MarkdownCase): MarkdownEvaluationResult {
	return evaluateAllMarkdownOracles(markdownStateFor(spec));
}

/** Every render the sweep drives. */
export function markdownCases(): readonly MarkdownCase[] {
	const cases: MarkdownCase[] = [];
	for (const fixture of Object.keys(MARKDOWN_FIXTURES)) {
		for (const width of MARKDOWN_WIDTHS) {
			for (const paddingX of MARKDOWN_PADDINGS) {
				cases.push({ fixture, width, paddingX });
			}
		}
	}
	return cases;
}
