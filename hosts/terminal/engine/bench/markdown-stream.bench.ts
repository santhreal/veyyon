/**
 * Markdown streaming-render performance harness.
 *
 * Measures Markdown.render() per streamed token in the shapes the coding
 * agent actually produces, isolating the component (no TUI/terminal):
 *
 *   1. prose        — paragraphs separated by blank lines; the frozen-prefix
 *                     machinery (#lexTokens / StreamPrefixLineCache) should
 *                     bound per-token cost to the open tail block.
 *   2. code fence   — one long streaming ```fence``` that never crosses a
 *                     freezable "\n\n" boundary; the whole fence re-renders
 *                     per token (the known residual).
 *   3. new-instance — non-fast-path shape: a fresh Markdown per update, as
 *                     assistant-message does when #canFastPath fails.
 *
 * Each shape runs with transientRenderCache on (streaming mode) and off, so
 * the incremental machinery's contribution is recorded in-run. Guards assert
 * the final render contains the last streamed token.
 */
import { Markdown } from "../src/components/markdown";
import { defaultMarkdownTheme } from "../test/test-themes.js";
import { benchFail, benchStats } from "./_harness";

const WIDTH = 100;
const WORDS = "the quick brown fox jumps over the lazy dog while the agent streams tokens into a long transcript".split(
	" ",
);

function report(label: string, samples: number[], extra = ""): void {
	const { p50, p95, mean } = benchStats(samples);
	console.log(
		`${label.padEnd(40)} n=${String(samples.length).padStart(5)}  ` +
			`p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  mean=${mean.toFixed(3)}ms${extra ? `  ${extra}` : ""}`,
	);
}

type TokenFn = (t: number) => string;

const proseToken: TokenFn = t => `${WORDS[t % WORDS.length]}${t > 0 && t % 12 === 0 ? "\n\n" : " "}`;
const fenceToken: TokenFn = t =>
	t === 0 ? "```ts\n" : `const v${t} = ${(t * 7) % 100}; // ${WORDS[t % WORDS.length]}\n`;

function benchSameInstance(label: string, token: TokenFn, tokens: number, transient: boolean): void {
	const md = new Markdown("", 0, 0, defaultMarkdownTheme);
	md.transientRenderCache = transient;
	let text = "";
	for (let t = 0; t < 50; t++) {
		text += token(t);
		md.setText(text);
		md.render(WIDTH);
	}
	const samples: number[] = [];
	for (let t = 50; t < tokens; t++) {
		text += token(t);
		if (t === tokens - 1) text += " FINAL_SENTINEL";
		md.setText(text);
		const start = performance.now();
		md.render(WIDTH);
		samples.push(performance.now() - start);
	}
	const last = md.render(WIDTH).join("\n");
	if (!last.includes("FINAL_SENTINEL")) benchFail(`${label}: last token never rendered`);
	report(`${label}${transient ? " transient" : ""}`, samples, `chars=${text.length}`);
}

function benchNewInstancePerUpdate(label: string, token: TokenFn, tokens: number): void {
	let text = "";
	for (let t = 0; t < 50; t++) text += token(t);
	const samples: number[] = [];
	let lines: readonly string[] = [];
	for (let t = 50; t < tokens; t++) {
		text += token(t);
		if (t === tokens - 1) text += " FINAL_SENTINEL";
		const start = performance.now();
		const md = new Markdown(text, 0, 0, defaultMarkdownTheme);
		md.transientRenderCache = true;
		lines = md.render(WIDTH);
		samples.push(performance.now() - start);
	}
	if (!lines.join("\n").includes("FINAL_SENTINEL")) benchFail(`${label}: last token never rendered`);
	report(`${label} new-instance`, samples, `chars=${text.length}`);
}

// Mean of the fastest `keep` fraction of the samples. A frame's own cost is what
// this bench compares; the slowest tenth is dominated by whichever frame paid
// for a garbage collection, which grows with the live heap for reasons no
// prefix-shaped change can affect.
function trimmedMean(samples: number[], keep: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const kept = sorted.slice(0, Math.max(1, Math.floor(sorted.length * keep)));
	return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

// Cumulative cost of one stream and the marginal cost at its end, at three
// lengths. A frame that re-reads, re-scans or re-copies the settled prefix makes
// the marginal cost grow with the transcript, so the guard is on the growth
// between 2,000 and 10,000 tokens rather than on any absolute number.
//
// One prefix-shaped operation is intrinsic and stays: the frame copies the
// settled rows into the array it returns, because that array is the render
// contract and callers memoize on its identity. Allocating and filling it is
// O(rows), so the floor is not 1x — a 5x longer transcript reads 1.80x to 1.96x
// across runs on one machine.
//
// What the ratio can resolve is a change in the per-byte cost of the prefix
// work, not one more operation of the same shape. Restoring a whole-text regex
// scan reads 2.86x and 3.13x, normalizing the whole text 3.3x, re-lexing a tail
// that grows 13.8x. One extra pointer copy of the settled rows, one extra pair
// of whole-prefix comparisons, or a re-slice of the frozen tokens read 1.83x to
// 2.25x on repeat runs of the same arm — inside the spread of the clean tree, so
// the budget below cannot see them and does not claim to. Those are recorded as
// the gap in .internal/mutate-markdown-prefix.py.
//
// A marginal frame is 6-13us, so one sample tracks whichever garbage collection
// it paid for and a single run of an arm is not reproducible to the 10% the
// budget needs. Each arm therefore runs three times and keeps its fastest, and
// the statistic is the mean of the second half with the slowest tenth trimmed
// off; p95 is a ceiling only.
function benchStreamScaling(): void {
	const marginal = new Map<number, { trimmed: number; p95: number }>();
	for (const tokens of [500, 2000, 10000]) {
		let best: { trimmed: number; p95: number; second: number[]; cumulative: number } | undefined;
		for (let repeat = 0; repeat < 3; repeat++) {
			const md = new Markdown("", 0, 0, defaultMarkdownTheme);
			md.transientRenderCache = true;
			let text = "";
			const samples: number[] = [];
			const start = performance.now();
			for (let t = 0; t < tokens; t++) {
				text += proseToken(t);
				if (t === tokens - 1) text += " FINAL_SENTINEL";
				md.setText(text);
				const frame = performance.now();
				md.render(WIDTH);
				samples.push(performance.now() - frame);
			}
			const cumulative = performance.now() - start;
			if (!md.render(WIDTH).join("\n").includes("FINAL_SENTINEL")) {
				benchFail(`prose scaling ${tokens}: last token never rendered`);
			}
			// The second half is the interesting one: the first frames of any
			// stream are cheap whatever the total length.
			const second = samples.slice(Math.floor(samples.length / 2));
			const trimmed = trimmedMean(second, 0.9);
			if (best === undefined || trimmed < best.trimmed) {
				best = { trimmed, p95: benchStats(second).p95, second, cumulative };
			}
		}
		if (best === undefined) {
			benchFail(`prose scaling ${tokens}: no run completed`);
			return;
		}
		marginal.set(tokens, { trimmed: best.trimmed, p95: best.p95 });
		report(
			`prose scaling (${tokens} tokens)`,
			best.second,
			`trimmed=${best.trimmed.toFixed(4)}ms cumulative=${best.cumulative.toFixed(0)}ms`,
		);
	}
	const small = marginal.get(2000);
	const large = marginal.get(10000);
	if (small === undefined || large === undefined) {
		benchFail("prose scaling: missing arm");
		return;
	}
	const grew = (pick: "trimmed" | "p95"): number => large[pick] / small[pick];
	if (grew("trimmed") > 2.4 || grew("p95") > 3) {
		benchFail(
			`prose scaling: marginal cost grew ${grew("trimmed").toFixed(2)}x trimmed mean / ${grew("p95").toFixed(2)}x p95 ` +
				"from 2000 to 10000 tokens (budget 2.4x trimmed mean, 3x p95) — " +
				"a frame is scanning or normalizing the settled prefix again",
		);
	}
}

console.log("markdown-stream.bench: Markdown per-token render cost\n");
benchSameInstance("prose (2000 tokens)", proseToken, 2000, true);
benchSameInstance("prose (2000 tokens)", proseToken, 2000, false);
benchSameInstance("code fence (1500 lines)", fenceToken, 1500, true);
benchSameInstance("code fence (1500 lines)", fenceToken, 1500, false);
benchNewInstancePerUpdate("prose (2000 tokens)", proseToken, 2000);
benchNewInstancePerUpdate("code fence (1500 lines)", fenceToken, 1500);
benchStreamScaling();
