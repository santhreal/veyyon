/**
 * WHY: marked runs every block extension's tokenizer at every block and every block extension's `start`
 * before every paragraph, each with the rest of the document. The rule, math-block and bare-environment
 * extensions searched that whole rest, so a full render of a message cost time quadratic in its length: a
 * 1,600-section answer took 400 to 520 ms to render where a 100-section one took 3 to 4 ms. A resumed
 * transcript renders every message in full.
 *
 * The class this closes: any block extension hook whose work grows with the text after the block it is
 * called at. No document below holds a math block or a bare environment, so every hook that searches
 * ahead for one searches to the end. The bound is on the ratio of render times for a message sixteen
 * times longer: 14 to 18 with every hook bounded, 130 to 150 with every hook scanning ahead, and 105 to
 * 126 with the bare-environment tokenizer alone scanning ahead.
 *
 * Not caught: one `start` hook alone scanning ahead lands near the bound (41 to 44), so
 * `a-block-after-a-blank-line-leaves-the-paragraph-before-it-alone.test.ts` holds the `start` hooks to the
 * paragraph they are called for. Super-linear work inside marked's own tokenizers passes up to the bound.
 */
import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown } from "@veyyon/tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

const SHORT_SECTIONS = 100;
const LONG_SECTIONS = SHORT_SECTIONS * 16;
const RATIO_BOUND = 40;

const SHAPES: Record<string, (i: number) => string> = {
	"headings, paragraphs and lists": i =>
		`## Step ${i}\n\nThe ${i}th change edits the parser.\nIt keeps the cache.\n\n- item a${i}\n- item b${i}`,
	"quotes and rules": i => `## Part ${i}\n\nText ${i}.\n\n> > quoted ${i}\n\n---`,
	"code, tables and inline math": i =>
		`Run ${i} costs $x_${i}$ and $y$.\n\n\`\`\`ts\nconst v${i} = ${i};\n\`\`\`\n\n| k | v |\n|---|---|\n| a | ${i} |`,
};

let unique = 0;

/** The fastest of several cold full renders, so a pause in one sample does not set the ratio. */
function fastestRenderMs(shape: (i: number) => string, sections: number): number {
	const doc = Array.from({ length: sections }, (_, i) => shape(i)).join("\n\n");
	let fastest = Number.POSITIVE_INFINITY;
	for (let sample = 0; sample < 5; sample++) {
		clearRenderCache();
		const md = new Markdown(`${doc}\n\nsample ${unique++}`, 0, 0, defaultMarkdownTheme);
		const start = performance.now();
		md.render(80);
		fastest = Math.min(fastest, performance.now() - start);
	}
	return fastest;
}

describe("a full render of a long message", () => {
	for (const [name, shape] of Object.entries(SHAPES)) {
		it(`takes time linear in its length for ${name}`, () => {
			fastestRenderMs(shape, SHORT_SECTIONS);
			const short = fastestRenderMs(shape, SHORT_SECTIONS);
			const long = fastestRenderMs(shape, LONG_SECTIONS);
			expect(long / short, `short ${short.toFixed(2)} ms, long ${long.toFixed(2)} ms`).toBeLessThan(RATIO_BOUND);
		}, 30_000);
	}
});
