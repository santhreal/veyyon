/**
 * Frame-pipeline performance harness.
 *
 * Models real TUI workloads against synthetic transcripts:
 *
 *   1. Token streaming — incremental appends into the active block.
 *   2. Component-scoped redraw — spinner tick while the rest is frozen.
 *   3. Cold paint — initial render of a 500- or 2,000-block transcript.
 *
 * Sink terminal + manual scheduler so execution is synchronous and headless,
 * isolating pure layout/diff/ANSI-emit cost from terminal I/O latency.
 *
 * Guards: each phase asserts the terminal actually received bytes and that
 * the final frame contains the last streamed token, so a "fast" result can
 * never come from frames silently not rendering.
 */
import { Text } from "../src/components/text";
import { TUI } from "../src/tui";
import { BENCH_WORDS, benchFail, buildTranscript, ManualScheduler, reportBench, SinkTerminal } from "./_harness";

function makeTui(
	blocks: number,
	grid: { columns: number; rows: number } = { columns: 100, rows: 40 },
): { tui: TUI; terminal: SinkTerminal; scheduler: ManualScheduler } {
	const terminal = new SinkTerminal(grid.columns, grid.rows);
	const scheduler = new ManualScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	buildTranscript(tui, blocks);
	tui.start();
	tui.requestRender();
	scheduler.flush();
	return { tui, terminal, scheduler };
}

const HD_GRID = { columns: 213, rows: 32 };

function benchStreaming(
	blocks: number,
	tokens: number,
	newlineEvery: number,
	legacy = false,
	grid?: { columns: number; rows: number },
): void {
	const { tui, terminal, scheduler } = makeTui(blocks, grid);
	const live = new Text("");
	tui.addChild(live);
	let text = "";
	const token = (t: number) =>
		`${BENCH_WORDS[t % BENCH_WORDS.length]}${newlineEvery > 0 && t % newlineEvery === 0 ? "\n" : " "}`;

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
	if (terminal.bytes === bytesBefore) benchFail("streaming phase wrote no bytes");
	if (!terminal.lastChunk.includes("FINAL_SENTINEL")) benchFail("last streamed token never reached the terminal");
	const shape = newlineEvery > 0 ? "prose" : "one-line";
	const where = grid ? ` ${grid.columns}x${grid.rows}` : "";
	reportBench(
		`streaming ${shape}${legacy ? " legacy" : ""} (${blocks} blocks)${where}`,
		samples,
		`bytes=${terminal.bytes - bytesBefore}`,
		34,
		true,
	);
	tui.stop();
}

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
	if (terminal.bytes === bytesBefore) benchFail("spinner phase wrote no bytes");
	reportBench(`spinner ticks (${blocks} blocks)`, samples, `bytes=${terminal.bytes - bytesBefore}`, 34, true);
	tui.stop();
}

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
		if (terminal.bytes === 0) benchFail("cold paint wrote no bytes");
		tui.stop();
	}
	reportBench(`cold paint (${blocks} blocks)`, samples, `bytes/frame=${bytes}`, 34, true);
}

console.log("frame.bench: TUI frame pipeline (sink terminal, sync scheduler)\n");
benchStreaming(50, 2000, 12);
benchStreaming(500, 2000, 12);
benchStreaming(2000, 2000, 12);
benchStreaming(500, 2000, 12, true);
benchStreaming(500, 2000, 0);
benchStreaming(500, 2000, 0, true);
benchStreaming(500, 2000, 12, false, HD_GRID);
benchStreaming(500, 2000, 0, false, HD_GRID);
benchSpinner(500, 2000);
benchSpinner(2000, 2000);
benchColdPaint(500, 20);
benchColdPaint(2000, 10);
