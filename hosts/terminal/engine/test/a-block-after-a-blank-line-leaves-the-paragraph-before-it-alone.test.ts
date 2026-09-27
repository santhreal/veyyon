/**
 * WHY: marked calls a block extension's `start` with the rest of the document before every paragraph and cuts
 * the paragraph where the returned block begins; a cut sets the flag that makes marked merge the next
 * paragraph into this one. The rule, math-block and bare-environment extensions searched the whole rest of
 * the document, so a rule or math block anywhere later in a message set that flag for every earlier
 * paragraph. A paragraph that marked's paragraph rule stops at a line no block tokenizer then takes (a table
 * header whose delimiter row has another cell count, `<scriptx`) merged with that line in a full render
 * and stayed apart in a streamed one, whose earlier paragraphs were lexed before the later block arrived.
 * The search also made lexing quadratic in the message length.
 *
 * The class this closes: a paragraph's rows depending on a block after the blank line that ends it. The
 * sweep covers every character that renders as a rule, discovered by rendering each candidate, both
 * display-math delimiters and bare math environments, after each kind of stopped paragraph, in a full
 * render and in a streamed one.
 *
 * A block that opens on one of the paragraph's own lines still ends it there, which is marked's intended use
 * of `start`: every following block above, and a display-math block whose opening line is the paragraph's
 * last line (the line the bounded search ends on), renders after a paragraph line as it does after a blank
 * line. A rule of `-` or `=` is left out there, since under a paragraph line it underlines a setext heading.
 */
import { describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { clearRenderCache, Markdown } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const WIDTH = 40;

function renderCold(text: string): readonly string[] {
	clearRenderCache();
	return new Markdown(text, 0, 0, defaultMarkdownTheme).render(WIDTH);
}

/** Every character in the ASCII, dash and box-drawing ranges whose tripled line renders as a rule row. */
function discoverRuleChars(): string[] {
	const found: string[] = [];
	for (const [first, last] of [
		[0x21, 0x7e],
		[0x2010, 0x2015],
		[0x2500, 0x257f],
	] as const) {
		for (let code = first; code <= last; code++) {
			const char = String.fromCodePoint(code);
			const rows = renderCold(char.repeat(3)).map(row => stripVTControlCharacters(row).trimEnd());
			if (rows.length === 1 && rows[0]!.length === WIDTH && new Set(rows[0]).size === 1) found.push(char);
		}
	}
	return found;
}

const RULE_CHARS = discoverRuleChars();

const FOLLOWING_BLOCKS: readonly string[] = [
	...RULE_CHARS.map(char => char.repeat(3)),
	"$$\nx^2\n$$",
	"\\[\nx^2\n\\]",
	"\\begin{pmatrix}\n1 & 2\n\\end{pmatrix}",
	"f(x) =\n\\begin{cases}\n1\n\\end{cases}",
	"\\begin{align*}\na &= b\n\\end{align*}",
];

/** Rule characters that underline a setext heading when their line follows a paragraph line. */
const SETEXT_UNDERLINES: ReadonlySet<string> = new Set(["-", "="]);

/** Paragraphs marked's paragraph rule stops at a line that no block tokenizer then takes. */
const STOPPED_PARAGRAPHS: readonly string[] = [
	"Summary\n| Name | Value |\n|---|",
	"Intro line\n<scriptx here",
	"Lead in\n  | left | right |\n  |:-:|",
];

describe("a block after a blank line", () => {
	it("is discovered for every rule character", () => {
		expect(RULE_CHARS).toEqual(["*", "-", "=", "_", "–", "—", "─", "━", "═"]);
	});

	it("still ends a paragraph at a block that opens on one of its lines", () => {
		const blocks = [
			...FOLLOWING_BLOCKS.filter(block => !SETEXT_UNDERLINES.has(block[0]!)),
			"$$\n\nx^2\n$$",
			"\\[\n\nx^2\n\\]",
		];
		for (const block of blocks) {
			expect(renderCold(`Lead\n${block}`), JSON.stringify(block)).toEqual(renderCold(`Lead\n\n${block}`));
		}
	});

	for (const paragraph of STOPPED_PARAGRAPHS) {
		it(`leaves the rows of ${JSON.stringify(paragraph)} as they render alone`, () => {
			const alone = [...renderCold(paragraph)];
			for (const block of FOLLOWING_BLOCKS) {
				const rows = renderCold(`${paragraph}\n\n${block}`);
				expect(rows.slice(0, alone.length), `followed by ${JSON.stringify(block)}`).toEqual(alone);
				// The following block renders as its own block rather than as paragraph text.
				expect(rows.length, `followed by ${JSON.stringify(block)}`).toBeGreaterThan(alone.length + 1);
			}
		});

		it(`renders ${JSON.stringify(paragraph)} streamed as a full render does`, () => {
			for (const block of FOLLOWING_BLOCKS) {
				const text = `${paragraph}\n\n${block}\n\nend`;
				const md = new Markdown("", 0, 0, defaultMarkdownTheme);
				md.transientRenderCache = true;
				for (let end = 1; end <= text.length; end++) {
					md.setText(text.slice(0, end));
					md.render(WIDTH);
				}
				expect(md.render(WIDTH), `followed by ${JSON.stringify(block)}`).toEqual(renderCold(text));
			}
		});
	}
});
