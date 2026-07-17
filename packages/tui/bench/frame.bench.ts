/**
 * Frame-pipeline performance harness.
 *
 * Models the real interactive costs of the TUI render loop with a synchronous
 * scheduler and a byte-sink terminal, so the numbers isolate compose + diff +
 * emit (no WASM terminal, no process I/O):
 *
 *   1. streaming  — a long transcript where tokens append to the LAST child
 *      and every token requests a full frame (the assistant-response path).
 *   2. spinner    — component-scoped renders from one animating child in an
 *      otherwise quiet long transcript (the partial-compose fast path).
 *   3. cold paint — first full compose+paint of a long transcript (session
 *      replay / resize geometry rebuild cost).
 *
 * Guards: each phase asserts the terminal actually received bytes and that
 * the final frame contains the last streamed token, so a "fast" result can
 * never come from frames silently not rendering.
 */
import { Text } from "../src/components/text";
import { TUI, type RenderScheduler } from "../src/tui";
import type { Terminal, TerminalAppearance } from "../src/terminal";

// ─── Sink terminal ──────────────────────────────────────────────────────────

class SinkTerminal implements Terminal {
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

// Manual scheduler: callbacks queue and run on flush(). Running them inline
// would fire the render callback BEFORE `#renderTimer` is assigned, leaving a
// stale timer handle that silently blocks every later frame.
class ManualScheduler implements RenderScheduler {
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

// ─── Deterministic transcript ───────────────────────────────────────────────

const WORDS =
	"the quick brown fox jumps over the lazy dog while the agent streams tokens into a long transcript".split(" ");

function paragraph(seed: number, sentences: number): string {
	const parts: string[] = [];
	for (let s = 0; s < sentences; s++) {
		const line: string[] = [];
		for (let w = 0; w < 12 + ((seed + s) % 9); w++) {
			line.push(WORDS[(seed * 7 + s * 3 + w) % WORDS.length] ?? "the");
		}
		parts.push(line.join(" "));
	}
	return parts.join("\n");
}

function buildTranscript(tui: TUI, blocks: number): void {
	for (let i = 0; i < blocks; i++) {
		tui.addChild(new Text(paragraph(i, 2 + (i % 4))));
	}
}

function makeTui(blocks: number): { tui: TUI; terminal: SinkTerminal; scheduler: ManualScheduler } {
	const terminal = new SinkTerminal();
	const scheduler = new ManualScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	buildTranscript(tui, blocks);
	tui.start();
	tui.requestRender(); // initial paint outside the measured window
	scheduler.flush();
	return { tui, terminal, scheduler };
}

function stats(samplesMs: number[]): { p50: number; p95: number; mean: number } {
	const sorted = [...samplesMs].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
	const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
	return { p50: at(0.5), p95: at(0.95), mean };
}

function report(label: string, samples: number[], extra = ""): void {
	const { p50, p95, mean } = stats(samples);
	console.log(
		`${label.padEnd(34)} n=${String(samples.length).padStart(5)}  ` +
			`p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  mean=${mean.toFixed(3)}ms  ` +
			`(${(1000 / Math.max(mean, 0.0001)).toFixed(0)} fps)${extra ? `  ${extra}` : ""}`,
	);
}

function fail(message: string): never {
	console.error(`GUARD FAILED: ${message}`);
	process.exit(1);
}

// ─── Phase 1: token streaming into the last block ───────────────────────────

/**
 * @param newlineEvery paragraph shape: a "\n" lands every N tokens (0 = one
 *   giant logical line, the wrap cache's worst case — real prose/code has
 *   frequent newlines and hits the incremental path).
 * @param legacy invalidate() the live component before every frame, forcing
 *   the pre-cache full re-wrap so the incremental win is measured in-run.
 */
function benchStreaming(blocks: number, tokens: number, newlineEvery: number, legacy = false): void {
	const { tui, terminal, scheduler } = makeTui(blocks);
	const live = new Text("");
	tui.addChild(live);
	let text = "";
	const token = (t: number) => `${WORDS[t % WORDS.length]}${newlineEvery > 0 && t % newlineEvery === 0 ? "\n" : " "}`;
	// Warmup
	for (let t = 0; t < 50; t++) {
		text += token(t);
		live.setText(text);
		tui.requestRender();
		scheduler.flush();
	}
	const bytesBefore = terminal.bytes;
	const samples: number[] = [];
	for (let t = 0; t < tokens; t++) {
		text += token(t);
		if (t === tokens - 1) text += "FINAL_SENTINEL";
		live.setText(text);
		if (legacy) live.invalidate();
		const start = performance.now();
		tui.requestRender();
		scheduler.flush();
		samples.push(performance.now() - start);
	}
	if (terminal.bytes === bytesBefore) fail("streaming phase wrote no bytes");
	if (!terminal.lastChunk.includes("FINAL_SENTINEL")) fail("last streamed token never reached the terminal");
	const shape = newlineEvery > 0 ? "prose" : "one-line";
	report(`streaming ${shape}${legacy ? " legacy" : ""} (${blocks} blocks)`, samples, `bytes=${terminal.bytes - bytesBefore}`);
	tui.stop();
}

// ─── Phase 2: component-scoped spinner ticks ────────────────────────────────

function benchSpinner(blocks: number, ticks: number): void {
	const { tui, terminal, scheduler } = makeTui(blocks);
	const spinner = new Text("|");
	tui.addChild(spinner);
	tui.requestRender();
	scheduler.flush();
	const frames = ["|", "/", "-", "\\"];
	for (let t = 0; t < 50; t++) {
		spinner.setText(frames[t % 4] ?? "|");
		tui.requestComponentRender(spinner);
		scheduler.flush();
	}
	const bytesBefore = terminal.bytes;
	const samples: number[] = [];
	for (let t = 0; t < ticks; t++) {
		spinner.setText(frames[t % 4] ?? "|");
		const start = performance.now();
		tui.requestComponentRender(spinner);
		scheduler.flush();
		samples.push(performance.now() - start);
	}
	if (terminal.bytes === bytesBefore) fail("spinner phase wrote no bytes");
	report(`spinner ticks (${blocks} blocks)`, samples, `bytes=${terminal.bytes - bytesBefore}`);
	tui.stop();
}

// ─── Phase 3: cold full paint ───────────────────────────────────────────────

function benchColdPaint(blocks: number, repeats: number): void {
	const samples: number[] = [];
	let bytes = 0;
	for (let r = 0; r < repeats; r++) {
		const terminal = new SinkTerminal();
		const scheduler = new ManualScheduler();
		const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
		buildTranscript(tui, blocks);
		tui.start();
		const start = performance.now();
		tui.requestRender();
		scheduler.flush();
		samples.push(performance.now() - start);
		bytes = terminal.bytes;
		if (terminal.bytes === 0) fail("cold paint wrote no bytes");
		tui.stop();
	}
	report(`cold paint (${blocks} blocks)`, samples, `bytes/frame=${bytes}`);
}

// ─── Run ────────────────────────────────────────────────────────────────────

console.log("frame.bench: TUI frame pipeline (sink terminal, sync scheduler)\n");
benchStreaming(50, 2000, 12);
benchStreaming(500, 2000, 12);
benchStreaming(2000, 2000, 12);
benchStreaming(500, 2000, 12, true); // pre-cache behavior for comparison
benchStreaming(500, 2000, 0); // worst case: one giant logical line
benchStreaming(500, 2000, 0, true);
benchSpinner(500, 2000);
benchSpinner(2000, 2000);
benchColdPaint(500, 20);
benchColdPaint(2000, 10);
