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
/** Short renders per timed window: enough text for the window to span tens of clock steps. */
const SHORT_RENDERS = 16;
const RATIO_BOUND = 40;

const SHAPES: Record<string, (i: number) => string> = {
	"headings, paragraphs and lists": i =>
		`## Step ${i}\n\nThe ${i}th change edits the parser.\nIt keeps the cache.\n\n- item a${i}\n- item b${i}`,
	"quotes and rules": i => `## Part ${i}\n\nText ${i}.\n\n> > quoted ${i}\n\n---`,
	"code, tables and inline math": i =>
		`Run ${i} costs $x_${i}$ and $y$.\n\n\`\`\`ts\nconst v${i} = ${i};\n\`\`\`\n\n| k | v |\n|---|---|\n| a | ${i} |`,
};

let unique = 0;

/** CPU time the calling thread has spent, in milliseconds. Time a preempted thread waits is not in it. */
function threadCpuMs(): number {
	const { user, system } = process.threadCpuUsage();
	return (user + system) / 1000;
}

/**
 * Thread CPU time of one cold full render of the message, the mean of `renders` renders timed as one
 * window, fastest of five windows. Wall time is not used: on a host running more test processes than it
 * has cores, a render longer than a scheduler slice waits out the other processes' slices and a short one
 * does not, which moved the ratio from 18 to between 45 and 83 with nothing super-linear in the renderer.
 * The thread's CPU clock advances in steps of a millisecond, so a short render is timed in a batch.
 */
function fastestRenderCpuMs(shape: (i: number) => string, sections: number, renders: number): number {
	const doc = Array.from({ length: sections }, (_, i) => shape(i)).join("\n\n");
	let fastest = Number.POSITIVE_INFINITY;
	for (let sample = 0; sample < 5; sample++) {
		const messages = Array.from(
			{ length: renders },
			() => new Markdown(`${doc}\n\nsample ${unique++}`, 0, 0, defaultMarkdownTheme),
		);
		const start = threadCpuMs();
		for (const md of messages) {
			clearRenderCache();
			md.render(80);
		}
		fastest = Math.min(fastest, (threadCpuMs() - start) / renders);
	}
	return fastest;
}

describe("a full render of a long message", () => {
	for (const [name, shape] of Object.entries(SHAPES)) {
		it(`takes time linear in its length for ${name}`, () => {
			fastestRenderCpuMs(shape, SHORT_SECTIONS, SHORT_RENDERS);
			const short = fastestRenderCpuMs(shape, SHORT_SECTIONS, SHORT_RENDERS);
			const long = fastestRenderCpuMs(shape, LONG_SECTIONS, 1);
			expect(long / short, `short ${short.toFixed(2)} ms, long ${long.toFixed(2)} ms`).toBeLessThan(RATIO_BOUND);
		}, 30_000);
	}
});
