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

const WIDTH = 100;
const WORDS =
	"the quick brown fox jumps over the lazy dog while the agent streams tokens into a long transcript".split(" ");

function stats(samplesMs: number[]): { p50: number; p95: number; mean: number } {
	const sorted = [...samplesMs].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
	return { p50: at(0.5), p95: at(0.95), mean };
}

function report(label: string, samples: number[], extra = ""): void {
	const { p50, p95, mean } = stats(samples);
	console.log(
		`${label.padEnd(40)} n=${String(samples.length).padStart(5)}  ` +
			`p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  mean=${mean.toFixed(3)}ms${extra ? `  ${extra}` : ""}`,
	);
}

function fail(message: string): never {
	console.error(`GUARD FAILED: ${message}`);
	process.exit(1);
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
	if (!last.includes("FINAL_SENTINEL")) fail(`${label}: last token never rendered`);
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
	if (!lines.join("\n").includes("FINAL_SENTINEL")) fail(`${label}: last token never rendered`);
	report(`${label} new-instance`, samples, `chars=${text.length}`);
}

console.log("markdown-stream.bench: Markdown per-token render cost\n");
benchSameInstance("prose (2000 tokens)", proseToken, 2000, true);
benchSameInstance("prose (2000 tokens)", proseToken, 2000, false);
benchSameInstance("code fence (1500 lines)", fenceToken, 1500, true);
benchSameInstance("code fence (1500 lines)", fenceToken, 1500, false);
benchNewInstancePerUpdate("prose (2000 tokens)", proseToken, 2000);
benchNewInstancePerUpdate("code fence (1500 lines)", fenceToken, 1500);
