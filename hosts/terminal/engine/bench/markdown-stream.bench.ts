/**
 * Markdown streaming-render performance harness.
 *
 * Simulates an agent generating a long response token-by-token:
 *
 *   1. Re-render the same Markdown instance as text grows.
 *   2. Re-create a new Markdown instance each update (the naive path).
 *   3. Measure scaling across lengths: 500, 2000, 10000 tokens.
 *
 * Compares two render strategies:
 *   - Transient render cache: caches intermediate layout state across calls.
 *   - Full re-render: layout from scratch every token (pre-optimization baseline).
 *
 * Guards: each phase asserts the final render produced output and contained
 * the last token, so a fast number cannot come from a broken pipeline.
 *
 * The stream scaling guard asserts that the marginal cost of late tokens
 * (between 2,000 and 10,000 tokens) does not grow faster than the transcript
 * length justifies, catching regressions that re-scan settled prefix rows.
 */
import { Markdown } from "../src/components/markdown";
import { defaultMarkdownTheme } from "../test/test-themes.js";
import { BENCH_WORDS, benchFail, benchStats, reportBench, trimmedMean } from "./_harness";

const WIDTH = 100;
type TokenFn = (t: number) => string;

const proseToken: TokenFn = t => `${BENCH_WORDS[t % BENCH_WORDS.length]}${t > 0 && t % 12 === 0 ? "\n\n" : " "}`;
const fenceToken: TokenFn = t =>
	t === 0 ? "```ts\n" : `const v${t} = ${(t * 7) % 100}; // ${BENCH_WORDS[t % BENCH_WORDS.length]}\n`;

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
	reportBench(`${label}${transient ? " transient" : ""}`, samples, `chars=${text.length}`, 40);
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
	reportBench(`${label} new-instance`, samples, `chars=${text.length}`, 40);
}

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
		reportBench(
			`prose scaling (${tokens} tokens)`,
			best.second,
			`trimmed=${best.trimmed.toFixed(4)}ms cumulative=${best.cumulative.toFixed(0)}ms`,
			40,
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
