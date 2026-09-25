import { afterEach, describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { type Component, TUI } from "@veyyon/tui";
import { StressRenderScheduler } from "./render-stress-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

// WHY. The room view attaches another conversation under its fullscreen
// overlay, asks the engine what that conversation will show with
// `composeViewport()`, zooms into those rows, and only then closes the overlay.
// If the preview and the repaint that follows disagree, the zoom lands on one
// screen and the terminal jumps to another. The class this closes is a preview
// that is not the screen the overlay closes onto: rows composed from the
// overlay instead of the children under it, from the children as they were
// before the swap, at a geometry other than the terminal's, or a preview that
// commits what it composed so the next frame's diff believes those rows are
// already on screen and skips them. It also pins that there is no preview to
// serve before the first render or after stop(). Each case is swept over a
// conversation left behind that overflows the viewport (so its next frame
// re-anchors history) and one that does not (so its next frame is a plain
// in-window diff, the frame a committed preview would silence), crossed with
// an incoming conversation taller than, equal to and shorter than the
// viewport, closed by an ordinary frame and by a forced repaint.
//
// It does not catch what the zoom animation paints between the preview and the
// close, inline images (the rows are compared as plain text, so an image
// placeholder and its graphic are not checked), or a preview taken at one size
// and consumed after a resize.

const WIDTH = 24;
const HEIGHT = 5;
const NO_MULTIPLEXER_ENV: Record<string, string | undefined> = {
	TMUX: undefined,
	STY: undefined,
	ZELLIJ: undefined,
	TERM_PROGRAM: undefined,
	TERM: "xterm-256color",
	VEYYON_TUI_RESIZE_IN_PLACE: undefined,
};

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
	constructor(readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(width: number): string[] {
		return this.lines.map(line => line.slice(0, width));
	}
}

/** `count` rows of a conversation, each carrying SGR so the preview goes through the same styling path as a paint. */
function conversation(name: string, count: number): Rows {
	return new Rows(Array.from({ length: count }, (_, i) => `\x1b[36m${name}\x1b[0m row ${i}`));
}

function plain(rows: readonly string[]): string[] {
	return rows.map(row => stripVTControlCharacters(row).trimEnd());
}

/** The screen a conversation fills: its last HEIGHT rows, top-aligned over blank rows when shorter. */
function windowOf(rows: Rows): string[] {
	const tail = plain(rows.lines).slice(-HEIGHT);
	return [...tail, ...Array.from({ length: HEIGHT - tail.length }, () => "")];
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

// The conversation on screen when the room view opens, and the one it zooms
// into, against a viewport of HEIGHT rows.
const HOMES = [
	{ shape: "an overflowing", rows: HEIGHT + 3 },
	{ shape: "a short", rows: HEIGHT - 2 },
];
const INCOMING = [
	{ shape: "taller than the viewport", rows: HEIGHT + 4 },
	{ shape: "exactly the viewport", rows: HEIGHT },
	{ shape: "shorter than the viewport", rows: HEIGHT - 3 },
];
const CLOSES = [
	{ close: "an ordinary frame", force: false },
	{ close: "a forced repaint", force: true },
];

describe("composeViewport", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("has nothing to compose before the first render or after stop()", async () => {
		await withEnv(NO_MULTIPLEXER_ENV, async () => {
			const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
			const scheduler = new StressRenderScheduler();
			const tui = new TUI(term, undefined, { renderScheduler: scheduler });
			tui.addChild(conversation("home", 3));
			expect(tui.composeViewport()).toBeUndefined();
			tui.start();
			// start() only schedules the first frame.
			expect(tui.composeViewport()).toBeUndefined();
			await scheduler.drain(term);
			expect(plain(tui.composeViewport()?.rows ?? [])).toEqual(["home row 0", "home row 1", "home row 2", "", ""]);
			tui.stop();
			expect(tui.composeViewport()).toBeUndefined();
		});
	});

	for (const from of HOMES) {
		for (const incoming of INCOMING) {
			for (const { close, force } of CLOSES) {
				it(`previews a conversation ${incoming.shape} under a fullscreen overlay over ${from.shape} one exactly as ${close} paints it`, async () => {
					await withEnv(NO_MULTIPLEXER_ENV, async () => {
						const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
						const scheduler = new StressRenderScheduler();
						const tui = new TUI(term, undefined, { renderScheduler: scheduler });
						const home = conversation("home", from.rows);
						tui.addChild(home);
						try {
							tui.start();
							await scheduler.drain(term);
							const overlay = tui.showOverlay(new Rows(["ROOM VIEW"]), FULLSCREEN);
							await scheduler.drain(term);
							expect(plain(term.getViewport())).toContain("ROOM VIEW");

							const next = conversation("next", incoming.rows);
							tui.removeChild(home);
							tui.addChild(next);
							const writes = captureWrites(term);
							const snapshot = tui.composeViewport();
							// A preview writes nothing: the overlay still owns the screen.
							expect(writes).toEqual([]);
							if (snapshot === undefined) throw new Error("composeViewport returned nothing after a render");
							expect({ width: snapshot.width, height: snapshot.height }).toEqual({
								width: WIDTH,
								height: HEIGHT,
							});
							expect(plain(snapshot.rows)).toEqual(windowOf(next));

							overlay.hide();
							if (force) tui.requestRender(true);
							await scheduler.drain(term);
							expect(plain(term.getViewport())).toEqual(plain(snapshot.rows));
						} finally {
							tui.stop();
						}
					});
				});
			}
		}
	}

	for (const from of HOMES) {
		for (const incoming of INCOMING) {
			it(`commits nothing it composed, so the next frame still replaces ${from.shape} conversation with one ${incoming.shape}`, async () => {
				await withEnv(NO_MULTIPLEXER_ENV, async () => {
					const term = new VirtualTerminal(WIDTH, HEIGHT, 100);
					const scheduler = new StressRenderScheduler();
					const tui = new TUI(term, undefined, { renderScheduler: scheduler });
					const home = conversation("home", from.rows);
					tui.addChild(home);
					try {
						tui.start();
						await scheduler.drain(term);
						const fullRedraws = tui.fullRedraws;

						const next = conversation("next", incoming.rows);
						tui.removeChild(home);
						tui.addChild(next);
						const snapshot = tui.composeViewport();
						if (snapshot === undefined) throw new Error("composeViewport returned nothing after a render");
						// Still the old screen: the preview painted nothing and counted no paint.
						expect(plain(term.getViewport())).toEqual(windowOf(home));
						expect(tui.fullRedraws).toBe(fullRedraws);

						tui.requestRender();
						await scheduler.drain(term);
						expect(plain(term.getViewport())).toEqual(plain(snapshot.rows));
					} finally {
						tui.stop();
					}
				});
			});
		}
	}
});
