/**
 * Shared benchmark harness for TUI and terminal engine benchmarks.
 */

import { Text } from "../src/components/text";
import type { Terminal, TerminalAppearance } from "../src/terminal";
import type { RenderScheduler, TUI } from "../src/tui";

export { type BenchStats, benchFail, benchStats, makeBench } from "@veyyon/utils/bench-harness";

import { benchStats } from "@veyyon/utils/bench-harness";

/** Reusable sink terminal for headless/synthetic frame benchmarks. */
export class SinkTerminal implements Terminal {
	bytes = 0;
	writes = 0;
	lastChunk = "";
	constructor(
		public colsValue = 100,
		public rowsValue = 40,
	) {}
	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.bytes += data.length;
		this.writes += 1;
		this.lastChunk = data;
	}
	get columns(): number {
		return this.colsValue;
	}
	get rows(): number {
		return this.rowsValue;
	}
	get kittyProtocolActive(): boolean {
		return false;
	}
	get kittyEnableSequence(): string | null {
		return null;
	}
	readonly keyboardEnhancementEnterSequence = null;
	readonly keyboardEnhancementExitSequence = null;
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	onAppearanceChange(_callback: (appearance: TerminalAppearance) => void): void {}
	get appearance(): TerminalAppearance | undefined {
		return undefined;
	}
}

/** Synchronous manual render scheduler for controlled bench step flushes. */
export class ManualScheduler implements RenderScheduler {
	#queue: Array<(() => void) | null> = [];
	now(): number {
		return performance.now();
	}
	scheduleImmediate(callback: () => void): void {
		this.#queue.push(callback);
	}
	scheduleRender(callback: () => void, _delayMs: number) {
		const index = this.#queue.push(callback) - 1;
		return {
			cancel: () => {
				this.#queue[index] = null;
			},
		};
	}
	flush(): void {
		while (this.#queue.length > 0) {
			const callback = this.#queue.shift();
			callback?.();
		}
	}
}

/** Deterministic transcript vocabulary. */
export const BENCH_WORDS =
	"the quick brown fox jumps over the lazy dog while the agent streams tokens into a long transcript".split(" ");

/** Generate deterministic multi-sentence paragraph from seed. */
export function paragraph(seed: number, sentences: number): string {
	const parts: string[] = [];
	for (let s = 0; s < sentences; s++) {
		const line: string[] = [];
		for (let w = 0; w < 12 + ((seed + s) % 9); w++) {
			line.push(BENCH_WORDS[(seed * 7 + s * 3 + w) % BENCH_WORDS.length] ?? "the");
		}
		parts.push(line.join(" "));
	}
	return parts.join("\n");
}

/** Populate a TUI instance with deterministic text blocks. */
export function buildTranscript(tui: TUI, blocks: number): void {
	for (let i = 0; i < blocks; i++) {
		tui.addChild(new Text(paragraph(i, 2 + (i % 4))));
	}
}

/** Format standard benchmark summary line. */
export function reportBench(label: string, samples: readonly number[], extra = "", width = 34, showFps = false): void {
	const { p50, p95, mean } = benchStats(samples);
	const fpsPart = showFps ? `  (${(1000 / Math.max(mean, 0.0001)).toFixed(0)} fps)` : "";
	console.log(
		`${label.padEnd(width)} n=${String(samples.length).padStart(5)}  ` +
			`p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  mean=${mean.toFixed(3)}ms` +
			`${fpsPart}${extra ? `  ${extra}` : ""}`,
	);
}

/** Mean of fastest `keep` fraction of samples (trims GC noise in streaming benches). */
export function trimmedMean(samples: readonly number[], keep: number): number {
	const sorted = [...samples].sort((a, b) => a - b);
	const kept = sorted.slice(0, Math.max(1, Math.floor(sorted.length * keep)));
	return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

/** Deterministic PRNG generator (LCG). */
export function makeLcg(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (Math.imul(state, 1103515245) + 12345) >>> 0;
		return state / 0x100000000;
	};
}

/** Compute median value of samples. */
export function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Measure repetition execution times. */
export function timeRuns(reps: number, fn: () => void): number[] {
	const samples: number[] = [];
	for (let r = 0; r < reps; r++) {
		const t0 = performance.now();
		fn();
		samples.push(performance.now() - t0);
	}
	return samples;
}
