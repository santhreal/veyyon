import { afterEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type Component, type OverlayHandle, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// WHY. When the last fullscreen overlay closes, the engine leaves the alternate
// screen and repaints the normal one in the same frame, but as two writes. On
// `1049l` the terminal restores the normal screen as it was when the overlay
// opened, so a terminal that presents between the two writes shows that stale
// screen for a frame; when the room view zooms into a different conversation,
// that frame is the previous conversation. The class this closes is an overlay
// exit whose restored screen can be presented on its own under synchronized
// output: the exit must open a DEC 2026 update that is still open when the
// repaint's bytes land, whichever emitter paints the frame (an ordinary diff, a
// forced repaint, the geometry rebuild after a resize on the alternate screen,
// each over a conversation that overflowed into history and one that fits),
// and a frame that paints nothing must still close it. Across the whole stream
// no update is closed that was not opened and every update opened is closed.
// With synchronized output off, the exit bytes are pinned to what they were
// before the bracket existed, for every one of those frames.
//
// It does not catch a terminal that ignores DEC 2026 or times an update out
// before the repaint arrives, nor an exit taken outside the render loop
// (stop() leaves the alternate screen with no repaint after it).

const WIDTH = 24;
const HEIGHT = 5;
const SYNC_BEGIN = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";
const ALT_SCREEN_EXIT = "\x1b[?1049l";
// Mouse tracking off (SGR, any-motion, button), the kitty keyboard frame
// popped, then the alternate screen left: the one write an overlay exit made
// before synchronized output bracketed it.
const UNSYNCED_OVERLAY_EXIT = "\x1b[?1006l\x1b[?1003l\x1b[?1000l\x1b[<u\x1b[?1049l";
const BASE_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	TERM_PROGRAM: undefined,
	TERM: "xterm-256color",
	VEYYON_TUI_RESIZE_IN_PLACE: undefined,
	VEYYON_TUI_SYNC_OUTPUT: undefined,
};
const SYNC_ON = { ...BASE_ENV, VEYYON_FORCE_SYNC_OUTPUT: "1", VEYYON_NO_SYNC_OUTPUT: undefined };
const SYNC_OFF = { ...BASE_ENV, VEYYON_FORCE_SYNC_OUTPUT: undefined, VEYYON_NO_SYNC_OUTPUT: "1" };

async function withEnv<T>(patch: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const saved: Record<string, string | undefined> = {};
	for (const key in patch) {
		saved[key] = process.env[key];
		const value = patch[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return await run();
	} finally {
		for (const key in saved) {
			const value = saved[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

class Rows implements Component {
	lines: string[];
	constructor(lines: string[]) {
		this.lines = lines;
	}
	invalidate(): void {}
	render(width: number): string[] {
		return this.lines.map(line => line.slice(0, width));
	}
}

function captureWrites(term: VirtualTerminal): string[] {
	const writes: string[] = [];
	const realWrite = term.write.bind(term);
	vi.spyOn(term, "write").mockImplementation((data: string) => {
		writes.push(data);
		realWrite(data);
	});
	return writes;
}

const FULLSCREEN = { width: "100%", maxHeight: "100%", margin: 0, fullscreen: true } as const;
const NEXT_ROWS = ["next row 0", "next row 1", "next row 2", "next row 3"];
// The conversation under the overlay: one that overflowed into native history,
// whose replacement re-anchors the committed prefix, and one that fits, whose
// replacement is an in-window diff.
const HOMES = [
	{ shape: "an overflowing", rows: HEIGHT + 3 },
	{ shape: "a short", rows: HEIGHT - 2 },
];

interface Harness {
	term: VirtualTerminal;
	scheduler: StressRenderScheduler;
	tui: TUI;
	conversation: Rows;
	overlay: OverlayHandle;
	writes: string[];
}

/** A painted conversation of `homeRows` rows with a fullscreen overlay up over it, every write captured from construction on. */
async function overlayUp(homeRows: number): Promise<Harness> {
	const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
	const writes = captureWrites(term);
	const scheduler = new StressRenderScheduler();
	const tui = new TUI(term, undefined, { renderScheduler: scheduler });
	const conversation = new Rows(Array.from({ length: homeRows }, (_, i) => `home row ${i}`));
	tui.addChild(conversation);
	tui.start();
	await scheduler.drain(term);
	const overlay = tui.showOverlay(new Rows(["ROOM VIEW"]), FULLSCREEN);
	await scheduler.drain(term);
	expect(term.getViewport().map(row => stripVTControlCharacters(row).trimEnd())).toContain("ROOM VIEW");
	return { term, scheduler, tui, conversation, overlay, writes };
}

/**
 * Each way the frame after the overlay closes can paint. `repaints` says
 * whether the frame writes the conversation's rows or leaves the screen the
 * terminal restored as it is.
 */
const CLOSES: ReadonlyArray<{ close: string; repaints: boolean; run(harness: Harness): Promise<void> }> = [
	{
		close: "an ordinary frame diffing in new rows",
		repaints: true,
		async run({ term, scheduler, conversation, overlay }) {
			conversation.lines = NEXT_ROWS;
			overlay.hide();
			await scheduler.drain(term);
		},
	},
	{
		close: "a forced repaint",
		repaints: true,
		async run({ term, scheduler, tui, conversation, overlay }) {
			conversation.lines = NEXT_ROWS;
			overlay.hide();
			tui.requestRender(true);
			await scheduler.drain(term);
		},
	},
	{
		close: "the geometry rebuild after a resize on the alternate screen",
		repaints: true,
		async run({ term, scheduler, conversation, overlay }) {
			term.resize(WIDTH + 6, HEIGHT + 1);
			await scheduler.drain(term);
			conversation.lines = NEXT_ROWS;
			overlay.hide();
			await scheduler.drain(term);
		},
	},
	{
		close: "a frame with nothing to paint",
		repaints: false,
		async run({ term, scheduler, overlay }) {
			overlay.hide();
			await scheduler.drain(term);
		},
	},
];

describe("leaving a fullscreen overlay", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	for (const home of HOMES) {
		for (const { close, repaints, run } of CLOSES) {
			it(`under synchronized output, presents the exit over ${home.shape} conversation and ${close} as one update`, async () => {
				await withEnv(SYNC_ON, async () => {
					const harness = await overlayUp(home.rows);
					try {
						const from = harness.writes.length;
						await run(harness);
						const stream = harness.writes.slice(from).join("");
						const exit = stream.indexOf(ALT_SCREEN_EXIT);
						expect(exit).toBeGreaterThanOrEqual(0);

						// DEC 2026 is a mode, not a stack: the first reset after a set
						// presents everything since, so the update the exit belongs to runs
						// from the last set before it to the first reset after that set.
						const begin = stream.lastIndexOf(SYNC_BEGIN, exit);
						const end = stream.indexOf(SYNC_END, begin);
						expect(begin).toBeGreaterThanOrEqual(0);
						expect(end).toBeGreaterThan(exit);

						const presented = stripVTControlCharacters(stream.slice(exit, end));
						if (repaints) {
							// The repaint landed inside the update the exit opened.
							for (const row of NEXT_ROWS) expect(presented).toContain(row);
							const screen = harness.term.getViewport().map(row => stripVTControlCharacters(row).trimEnd());
							expect(screen.slice(0, NEXT_ROWS.length)).toEqual(NEXT_ROWS);
						} else {
							// Nothing painted, and the update was still closed.
							expect(presented).toBe("");
							expect(stream.slice(begin)).toMatch(/^\x1b\[\?2026h[\s\S]*\x1b\[\?1049l\x1b\[\?2026l$/);
						}
					} finally {
						harness.tui.stop();
					}

					// Across everything written since construction, no update closes
					// that was not opened, and every update opened is closed.
					let depth = 0;
					for (const mark of harness.writes.join("").matchAll(/\x1b\[\?2026([hl])/g)) {
						depth += mark[1] === "h" ? 1 : -1;
						expect(depth).toBeGreaterThanOrEqual(0);
					}
					expect(depth).toBe(0);
				});
			});
		}
	}

	for (const home of HOMES) {
		for (const { close, run } of CLOSES) {
			it(`without synchronized output, leaves the exit bytes over ${home.shape} conversation unchanged for ${close}`, async () => {
				await withEnv(SYNC_OFF, async () => {
					const harness = await overlayUp(home.rows);
					try {
						const from = harness.writes.length;
						await run(harness);
						const exits = harness.writes.slice(from).filter(write => write.includes(ALT_SCREEN_EXIT));
						expect(exits).toEqual([UNSYNCED_OVERLAY_EXIT]);
					} finally {
						harness.tui.stop();
					}
					expect(harness.writes.join("")).not.toContain("\x1b[?2026");
				});
			});
		}
	}
});
