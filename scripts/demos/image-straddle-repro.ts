// An inline image whose top rows have scrolled into native scrollback, then a
// forced viewport repaint, in a REAL terminal, live.
//
// The defect this belongs to: an image in the transcript renders whole, and
// later — after more output pushed its first rows into scrollback and something
// forced the viewport to repaint (an overlay opening or closing, a resize, a
// tool finalizing) — only its top part is visible, or it sits shifted over the
// rows below it. The placement line is the block's LAST row and reaches the
// image origin with `CUU rows-1`; once the origin is above the viewport, CUU
// clamps at row 0 and the image lands `k` rows too low.
//
// Run inside the terminal under test (WezTerm attaches image pixels to cells,
// so any row it rewrites erases that band of the picture):
//
//   bun scripts/demos/image-straddle-repro.ts [--tail 30] [--hold 60000]
//
// Phases, each held for --step ms so a recorder can screenshot them:
//   A  image fully in the viewport
//   B  --tail rows appended below it; its first rows are now in scrollback
//   C  forced viewport repaint (`requestRender(true)`), the defect frame
//   D  a second forced repaint, to show whether C was the steady state

import { setTimeout as sleep } from "node:timers/promises";
import * as zlib from "node:zlib";
import { type Component, CURSOR_MARKER, type Focusable, Image, ProcessTerminal, TUI } from "@veyyon/tui";
import { TranscriptContainer } from "../../packages/coding-agent/src/modes/terminal/components/transcript/transcript-container";
import { HomeAnchorLayout } from "../../packages/coding-agent/src/modes/terminal/controllers/home-anchor-layout";
import { initTheme, theme } from "../../packages/coding-agent/src/theme/theme";

const args = process.argv.slice(2);

function flag(name: string, fallback: number): number {
	const index = args.indexOf(`--${name}`);
	if (index === -1) return fallback;
	const value = Number(args[index + 1]);
	return Number.isFinite(value) ? value : fallback;
}

const TAIL = flag("tail", 30);
const STEP_MS = flag("step", 3000);
const HOLD_MS = flag("hold", 60_000);
const IMAGE_W = flag("w", 600);
const IMAGE_H = flag("h", 432);

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function pngChunk(type: string, data: Uint8Array): Uint8Array {
	const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
	const out = Buffer.alloc(body.length + 8);
	out.writeUInt32BE(data.length, 0);
	body.copy(out, 4);
	out.writeUInt32BE(Bun.hash.crc32(body) >>> 0, out.length - 4);
	return out;
}

/**
 * A picture whose halves are unmistakable: red above, blue below, a white
 * band on the midline, and a yellow band on the last rows so a clipped
 * bottom is visible at a glance.
 */
function bandedPng(width: number, height: number): string {
	const stride = width * 3;
	const raw = Buffer.alloc((stride + 1) * height);
	for (let y = 0; y < height; y++) {
		const row = y * (stride + 1);
		raw[row] = 0;
		let r = 200;
		let g = 40;
		let b = 40;
		if (y >= height / 2) [r, g, b] = [40, 60, 220];
		if (Math.abs(y - height / 2) < 4) [r, g, b] = [255, 255, 255];
		if (y >= height - 12) [r, g, b] = [250, 220, 30];
		for (let x = 0; x < width; x++) {
			const px = row + 1 + x * 3;
			raw[px] = r;
			raw[px + 1] = g;
			raw[px + 2] = b;
		}
	}
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const png = Buffer.concat([
		PNG_SIGNATURE,
		pngChunk("IHDR", ihdr),
		pngChunk("IDAT", zlib.deflateSync(raw)),
		pngChunk("IEND", new Uint8Array(0)),
	]);
	return png.toString("base64");
}

class Block implements Component {
	constructor(private readonly lines: string[]) {}
	invalidate(): void {}
	render(): string[] {
		return this.lines;
	}
}

class Composer implements Component, Focusable {
	focused = true;
	invalidate(): void {}
	setUseTerminalCursor(): void {}
	handleInput(): void {}
	render(): string[] {
		return [`> ask anything${CURSOR_MARKER}`];
	}
}

function turn(n: number): Block {
	return new Block([`> turn ${n}: a line of transcript`, `  reply ${n}: another line below the picture`, ""]);
}

async function main(): Promise<void> {
	await initTheme(false, "unicode", false, "titanium", "dark");
	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal, true);
	tui.setScrollbackRebuild(true);

	const transcript = new TranscriptContainer();
	const anchor = new HomeAnchorLayout({
		ui: tui,
		transcriptChildCount: () => transcript.children.length,
		hasHero: () => false,
	});
	tui.addChild(anchor.topFill);
	tui.addChild(transcript);
	tui.addChild(anchor.bottomFill);
	tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(1);
	tui.onBeforeCompose = () => anchor.sync();
	tui.start();

	for (let n = 1; n <= 3; n++) transcript.addChild(turn(n));
	transcript.addChild(
		new Image(
			bandedPng(IMAGE_W, IMAGE_H),
			"image/png",
			{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
			// The caps the app resolves: a column setting and 60% of the viewport rows.
			{
				budget: tui.imageBudget,
				imageKey: "repro:0",
				maxWidthCells: 80,
				maxHeightCells: Math.floor(terminal.rows * 0.6),
			},
			{ widthPx: IMAGE_W, heightPx: IMAGE_H },
		),
	);
	transcript.addChild(new Block(["  [end of image block]", ""]));
	tui.requestRender();
	await sleep(STEP_MS); // A

	for (let n = 4; n < 4 + TAIL; n++) {
		transcript.addChild(turn(n));
		tui.requestRender();
		await sleep(40);
	}
	await sleep(STEP_MS); // B

	tui.requestRender(true);
	await sleep(STEP_MS); // C

	tui.requestRender(true);
	await sleep(STEP_MS); // D

	await sleep(HOLD_MS);
	tui.stop();
}

await main();
