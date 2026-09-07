/**
 * Viewport slide bench: what a room switch costs with the slide off and on.
 *
 * A room switch replaces the transcript on screen with a peer's and repaints.
 * The off arm is that repaint alone: the forced full paint with the native
 * scrollback cleared, which is what the switch performed before the slide
 * existed and what it still performs where the engine refuses a slide. The on
 * arm captures the window first, swaps the transcript, then slides: seven
 * throwaway column-window frames on the alternate screen followed by the same
 * settle paint. Both arms run on the sink terminal and the manual scheduler
 * the frame bench uses, so the reading is compose + diff + emit and nothing
 * else, and the timers between slid frames cost nothing here: the figure is
 * the CPU a switch spends, not the ~130ms of wall time the slide is paced over.
 *
 * Parity: the off arm is the pre-slide switch to the byte, since the code path
 * it takes (`requestRender(true, { clearScrollback: true })`) is unchanged, and
 * the on arm ends in that same paint. Guards: the off arm never enters the
 * alternate screen and the on arm enters and leaves it once per switch, every
 * switch lands the peer's sentinel in the final paint, and the on arm paints
 * exactly `steps - 1` throwaway frames per switch.
 *
 * Run with the multiplexer variables cleared, since a slide is refused in one:
 *   env -u TMUX -u STY -u ZELLIJ bun hosts/terminal/engine/bench/viewport-slide.bench.ts
 */
import { Text } from "../src/components/text";
import { Container } from "../src/core/container";
import { TUI } from "../src/tui";
import { benchFail, benchStats } from "./_harness";
import { ManualScheduler, SinkTerminal } from "./_sink";

for (const name of ["TMUX", "STY", "ZELLIJ", "VEYYON_TUI_RESIZE_IN_PLACE"]) {
	if (process.env[name] !== undefined) {
		benchFail(`${name} is set, and the engine refuses a slide in a multiplexer session; run under env -u ${name}`);
	}
}

const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
const ERASE_SCROLLBACK = "\x1b[3J";
const SLIDE_STEPS = 8;

class RecordingSink extends SinkTerminal {
	chunks: string[] = [];
	override write(data: string): void {
		super.write(data);
		this.chunks.push(data);
	}
	take(): string {
		const joined = this.chunks.join("");
		this.chunks.length = 0;
		return joined;
	}
}

// ─── Two deterministic transcripts ──────────────────────────────────────────

const WORDS = "the quick brown fox jumps over the lazy dog while a peer conversation streams beside this one".split(
	" ",
);

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

/** Fill `chat` with transcript `which`; the last block carries that transcript's sentinel. */
function fillTranscript(chat: Container, which: "A" | "B", blocks: number): void {
	chat.clear();
	const offset = which === "A" ? 0 : 100_000;
	for (let i = 0; i < blocks; i++) {
		chat.addChild(new Text(paragraph(offset + i, 2 + (i % 4))));
	}
	chat.addChild(new Text(`SENTINEL_${which}`));
}

function count(haystack: string, needle: string): number {
	let n = 0;
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		n++;
		at = haystack.indexOf(needle, at + needle.length);
	}
	return n;
}

// ─── One arm ────────────────────────────────────────────────────────────────

interface ArmReading {
	samples: number[];
	bytesPerSwitch: number;
}

function benchSwitch(
	blocks: number,
	repeats: number,
	grid: { columns: number; rows: number },
	slide: boolean,
): ArmReading {
	const terminal = new RecordingSink(grid.columns, grid.rows);
	const scheduler = new ManualScheduler();
	const tui = new TUI(terminal, undefined, { renderScheduler: scheduler });
	const chat = new Container();
	tui.addChild(chat);
	fillTranscript(chat, "A", blocks);
	tui.start();
	tui.requestRender();
	scheduler.flush();
	terminal.take();

	const samples: number[] = [];
	let bytes = 0;
	let onScreen: "A" | "B" = "A";
	for (let r = 0; r < repeats; r++) {
		const next: "A" | "B" = onScreen === "A" ? "B" : "A";
		const framesBefore = tui.viewportSlideFrames;
		const start = performance.now();
		// The capture happens before the transcript changes, as RoomController does it.
		const from = slide ? tui.captureViewport() : undefined;
		if (slide && from === undefined) benchFail(`switch ${r}: the engine refused a capture`);
		fillTranscript(chat, next, blocks);
		if (from !== undefined) {
			if (!tui.slideViewport(from, next === "B" ? "left" : "right"))
				benchFail(`switch ${r}: the engine refused the slide`);
		} else {
			tui.requestRender(true, { clearScrollback: true });
		}
		scheduler.flush();
		samples.push(performance.now() - start);

		const written = terminal.take();
		bytes += written.length;
		if (!written.includes(`SENTINEL_${next}`))
			benchFail(`switch ${r}: the peer's transcript never reached the terminal`);
		if (tui.viewportSlideActive) benchFail(`switch ${r}: the slide did not end within the flush`);
		if (count(written, ERASE_SCROLLBACK) !== 1) benchFail(`switch ${r}: expected one scrollback erase per switch`);
		const enters = count(written, ALT_SCREEN_ENTER);
		const exits = count(written, ALT_SCREEN_EXIT);
		if (slide) {
			if (tui.viewportSlideFrames - framesBefore !== SLIDE_STEPS - 1) {
				benchFail(
					`switch ${r}: painted ${tui.viewportSlideFrames - framesBefore} slid frames, expected ${SLIDE_STEPS - 1}`,
				);
			}
			if (enters !== 1 || exits !== 1)
				benchFail(`switch ${r}: alternate screen entered ${enters}x and left ${exits}x`);
		} else if (enters !== 0 || exits !== 0) {
			benchFail(`switch ${r}: the plain repaint touched the alternate screen`);
		}
		onScreen = next;
	}
	tui.stop();
	return { samples, bytesPerSwitch: Math.round(bytes / repeats) };
}

// ─── Run ────────────────────────────────────────────────────────────────────

function report(label: string, reading: ArmReading): void {
	const { p50, p95, mean } = benchStats(reading.samples);
	console.log(
		`${label.padEnd(40)} n=${String(reading.samples.length).padStart(4)}  ` +
			`p50=${p50.toFixed(3)}ms  p95=${p95.toFixed(3)}ms  mean=${mean.toFixed(3)}ms  bytes/switch=${reading.bytesPerSwitch}`,
	);
}

/** The recorder's grid: 1920x1080 at font size 15 in `proof/docker/xsession.sh`. */
const HD_GRID = { columns: 213, rows: 32 };
const REPEATS = 200;

console.log(
	`viewport-slide.bench: a room switch, slide off vs on (${SLIDE_STEPS} steps; sink terminal, sync scheduler)\n`,
);
for (const grid of [{ columns: 100, rows: 40 }, HD_GRID]) {
	for (const blocks of [50, 500]) {
		const where = `${grid.columns}x${grid.rows}`;
		const off = benchSwitch(blocks, REPEATS, grid, false);
		const on = benchSwitch(blocks, REPEATS, grid, true);
		report(`switch off (${blocks} blocks) ${where}`, off);
		report(`switch on  (${blocks} blocks) ${where}`, on);
		const meanOff = benchStats(off.samples).mean;
		const meanOn = benchStats(on.samples).mean;
		console.log(
			`  slide adds ${(meanOn - meanOff).toFixed(3)}ms and ${on.bytesPerSwitch - off.bytesPerSwitch} bytes per switch ` +
				`(${((on.bytesPerSwitch - off.bytesPerSwitch) / (SLIDE_STEPS - 1)).toFixed(0)} bytes per slid frame)\n`,
		);
	}
}
