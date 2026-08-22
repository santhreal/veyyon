/**
 * WHY: a streamed markdown render normalized the whole transcript on every
 * frame. Tab expansion and the two structural-nesting caps were applied to the
 * entire text per arrival, and the nesting scan alone was 0.030ms of a 0.053ms
 * frame at 10,000 streamed tokens — spent on bytes that had been scanned on
 * every earlier frame. Only the arrived tail is scanned now, and text needing no
 * transform is returned by reference.
 *
 * The class this closes is a normalization that disagrees with a cold render
 * because it was skipped for a span already checked. The variant space is every
 * shape the two transforms can take, crossed with where it arrives: in the
 * checked head, in the tail, straddling a line the append lands in, and after a
 * long clean prefix — each streamed to the byte and compared against a cold full
 * render of the same prefix at every step, the same oracle
 * `markdown-incremental-lex.test.ts` uses for the lexer half.
 *
 * What it does not catch: a transform that stops being line-local. If a future
 * cap looks across a line boundary the head-reuse premise breaks, and only a
 * shape whose lines interact would show it — there is no such shape today, so
 * there is no case for it here.
 */
import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const THEME = defaultMarkdownTheme;

function renderCold(text: string, width: number): readonly string[] {
	clearRenderCache();
	const out = new Markdown(text, 0, 0, THEME).render(width);
	clearRenderCache();
	return out;
}

/** Stream `full` through one transient instance, comparing every step to a cold render. */
function assertStreamMatchesCold(full: string, width = 60, step = 7): void {
	const streaming = new Markdown("", 0, 0, THEME);
	streaming.transientRenderCache = true;
	for (let len = 1; len <= full.length; len += step) {
		const slice = full.slice(0, len);
		clearRenderCache();
		streaming.setText(slice);
		expect(streaming.render(width)).toEqual(renderCold(slice, width));
	}
	clearRenderCache();
	streaming.setText(full);
	expect(streaming.render(width)).toEqual(renderCold(full, width));
}

const CLEAN_PREFIX =
	"First settled paragraph with enough words to freeze as a stable block.\n\n" +
	"Second settled paragraph, also complete, also frozen before the shape below arrives.\n\n";

// Every shape the render normalization reacts to. A cap is exceeded only past
// its threshold, so each over-nesting case carries one more marker than allowed.
const SHAPES: readonly { name: string; text: string }[] = [
	{ name: "a tab inside prose", text: "one\ttwo three\n\nfour\tfive six\n\nseven" },
	{ name: "a tab opening a line", text: "\tindented by a tab\n\nplain paragraph after it\n\ntail" },
	{ name: "a tab inside a fence", text: "```ts\nconst x = 1;\n\tconst y = 2;\n```\n\nprose after\n\ntail" },
	{ name: "blockquote nesting at the cap", text: `${">".repeat(24)} quoted at the cap\n\nplain\n\ntail` },
	{ name: "blockquote nesting past the cap", text: `${">".repeat(25)} quoted past the cap\n\nplain\n\ntail` },
	{ name: "leading indent at the cap", text: `${" ".repeat(64)}deep\n\nplain\n\ntail` },
	{ name: "leading indent past the cap", text: `${" ".repeat(65)}deeper\n\nplain\n\ntail` },
	{ name: "a tab and over-nesting together", text: `\tone\n\n${">".repeat(25)} two\n\nthree\n\ntail` },
	{ name: "nothing to normalize", text: "plain one\n\nplain two\n\nplain three\n\ntail" },
];

describe("a streamed render", () => {
	it("matches a cold render for every normalization shape, at every arrival", () => {
		for (const shape of SHAPES) {
			assertStreamMatchesCold(shape.text);
		}
	});

	it("matches a cold render when the shape arrives after a settled clean prefix", () => {
		// The head is frozen and checked before the shape appears, which is the
		// exact case a skipped scan would get wrong.
		for (const shape of SHAPES) {
			assertStreamMatchesCold(CLEAN_PREFIX + shape.text);
		}
	});

	it("matches a cold render when a clean tail follows a shape in the head", () => {
		for (const shape of SHAPES) {
			assertStreamMatchesCold(`${shape.text}\n\nA clean trailing paragraph that keeps arriving.\n\nAnd another.`);
		}
	});

	it("matches a cold render when the text is rewritten rather than appended", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (const text of [
			`${CLEAN_PREFIX}tail with\ta tab`,
			// Shorter, and not a prefix of what came before: the checked head is
			// no longer a head of this text.
			"completely different\ttext",
			`${CLEAN_PREFIX}tail with ${">".repeat(25)} nesting`,
			CLEAN_PREFIX,
		]) {
			clearRenderCache();
			streaming.setText(text);
			expect(streaming.render(60)).toEqual(renderCold(text, 60));
		}
	});

	it("matches a cold render when a longer, different text replaces the checked head", () => {
		// The head reuse is keyed on the text still starting with what was checked.
		// A replacement that is longer — so a length test alone lets it through —
		// and carries a tab where the checked head used to be is the case that
		// separates a proof from a guess.
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		clearRenderCache();
		streaming.setText(`${CLEAN_PREFIX}a clean tail with no transform in it`);
		streaming.render(60);
		const rewritten = `\tone\ttabbed line where the checked head was\n\n${CLEAN_PREFIX}and a longer tail than before`;
		expect(rewritten.length).toBeGreaterThan(CLEAN_PREFIX.length);
		clearRenderCache();
		streaming.setText(rewritten);
		expect(streaming.render(60)).toEqual(renderCold(rewritten, 60));
	});

	it("renders a replacement lineage's own rows, not the rows cached for the one before it", () => {
		// Both texts freeze the same number of blocks at the same widths, so the
		// cached rows of the first are shaped exactly like what the second needs
		// and are reused wholesale by a cache that does not check lineage.
		const first = "Alpha paragraph one.\n\nAlpha paragraph two.\n\nAlpha tail";
		const second = "Bravo paragraph one.\n\nBravo paragraph two.\n\nBravo tail";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		clearRenderCache();
		streaming.setText(first);
		streaming.render(60);
		clearRenderCache();
		streaming.setText(second);
		const rendered = streaming.render(60);
		expect(rendered).toEqual(renderCold(second, 60));
		expect(rendered.join("\n")).not.toContain("Alpha");
	});

	it("exposes no settled rows on the frame a replacement lineage first renders", () => {
		// Settled rows are declared final to the host, which commits them to
		// native scrollback. A lineage that did not grow out of the exposed one
		// has to re-earn them, or the host commits rows this render never drew.
		const first = "Alpha paragraph one.\n\nAlpha paragraph two.\n\nAlpha tail";
		const second = "Bravo paragraph one.\n\nBravo paragraph two.\n\nBravo tail";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		streaming.setText(first);
		streaming.render(60);
		expect(streaming.getLastRenderSettledRows()).toBeGreaterThan(0);
		streaming.setText(second);
		streaming.render(60);
		expect(streaming.getLastRenderSettledRows()).toBe(0);
	});

	it("keeps the settled row count monotone while a clean stream grows", () => {
		// The frozen rows are reused by reference now, so the exposure is computed
		// from the reused array rather than from a per-frame accumulator.
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		// A block freezes only once content follows its blank line, so each step
		// carries the next paragraph's opening word.
		let settledBlocks = "";
		let text = "";
		let settled = 0;
		for (let block = 0; block < 12; block++) {
			settledBlocks += `Paragraph ${block} with a few words in it.\n\n`;
			text = `${settledBlocks}Paragraph ${block + 1}`;
			streaming.setText(text);
			streaming.render(60);
			const now = streaming.getLastRenderSettledRows();
			expect(now).toBeGreaterThanOrEqual(settled);
			settled = now;
		}
		expect(settled).toBeGreaterThan(0);
		// Those rows are declared final, so they must be the leading rows of the
		// render they were exposed from.
		const lines = streaming.render(60);
		expect(lines.slice(0, settled)).toEqual(renderCold(text, 60).slice(0, settled));
	});
});
