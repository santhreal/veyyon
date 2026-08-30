/**
 * A direct-placement image is drawn at its own origin or not at all.
 *
 * WHAT THIS CLOSES. An inline picture is emitted as a block: `rows - 1`
 * reserved rows, then a last row that saves the cursor, moves up `rows - 1`
 * with CUU, emits the graphic, and restores. CUU stops at the top of the
 * scroll region. So whenever that last row is written at a screen row lower
 * than `rows - 1` — a resize into a viewport shorter than the picture, a window
 * rewrite reaching a block that straddles the window top — the move lands at
 * row 1 and the terminal stamps the FULL-SIZE picture over whatever text is
 * there, while the block's own rows stay blank. Captured under WezTerm as a
 * picture cut off at the top and repeated across the live transcript.
 *
 * THE CLASS, not the incident. The invariant is not "a 12-row image is safe at
 * height 24". It is that no byte the engine hands the terminal may depend on
 * cursor motion the terminal cannot perform: for every placement anywhere in
 * the emitted stream, the cursor at that exact byte offset must already sit at
 * or below the origin the placement asks for. The oracle replays the real
 * stream into a real VT parser and asks it where the cursor is, so it holds for
 * every emit path — append, in-place rewrite, seam rewrite, full paint, resize,
 * alt-screen frame — including one added later that forgets to pass its row.
 *
 * WHAT IT DOES NOT CATCH. It asserts placement geometry, not pixels: a graphic
 * placed at the right origin with the wrong `c`/`r` still passes, and
 * `image-render.test.ts` owns that. It drives Kitty direct placement, the only
 * protocol that moves the cursor; Unicode placeholders and SIXEL write in place
 * and cannot clamp. One width, no multiplexer passthrough.
 *
 * Eleven emit sites pass a screen row to the guard. Replacing that row with
 * `Number.MAX_SAFE_INTEGER`, one site at a time, turns this file red at six of
 * them plus the guard itself. At the other five the gestures below reach the
 * site with a placement whose origin is already reachable, so the row it passes
 * makes no difference to the bytes. The alternate-screen frame is structural:
 * a modal shorter than the picture truncates the block from the bottom, which
 * drops the placement row before the emitter sees it, and a modal that fits it
 * leaves the origin on screen. A regression confined to one of those five would
 * pass here.
 */
import { describe, expect, test } from "bun:test";
import { Image, ImageBudget } from "../src/components/image";
import { type Component, Container, CURSOR_MARKER, type Focusable, TUI } from "../src/index";
import { getKittyGraphics, setKittyGraphics } from "../src/kitty-graphics";
import {
	type CellDimensions,
	encodeImagePlacementRow,
	getCellDimensions,
	ImageProtocol,
	imagePlacementRowsAbove,
	setCellDimensions,
	TERMINAL,
} from "../src/terminal-capabilities";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

/** Cell box the suite pins, so a pixel size converts to cells by division. */
const CELL: CellDimensions = { widthPx: 10, heightPx: 10 };
/** 20 columns by 12 rows at {@link CELL}: taller than the short viewport below. */
const IMAGE_PIXELS = { widthPx: 200, heightPx: 120 };
const IMAGE_ROWS = IMAGE_PIXELS.heightPx / CELL.heightPx;

const PLACEMENT_START = "\x1b7\x1b[";
const KITTY_PLACEMENT = "\x1b_Ga=p";

/** Every direct placement in `stream`, as `{ at, rowsAbove }` in byte order. */
function placements(stream: string): { at: number; rowsAbove: number }[] {
	const found: { at: number; rowsAbove: number }[] = [];
	for (let at = stream.indexOf(PLACEMENT_START); at !== -1; at = stream.indexOf(PLACEMENT_START, at + 1)) {
		const rowsAbove = imagePlacementRowsAbove(stream.slice(at));
		if (rowsAbove === 0) continue;
		const tail = stream.slice(at + PLACEMENT_START.length).replace(/^\d+A/, "");
		if (!tail.startsWith("\x1b_G") && !tail.startsWith("\x1b]1337")) continue;
		found.push({ at, rowsAbove });
	}
	return found;
}

/**
 * Placements the terminal could not honour, each as a readable failure.
 *
 * The prefix of the stream is replayed into a second VT of the same size — the
 * same parser the product writes to — so the cursor row is the terminal's own
 * answer rather than a model of it.
 */
function unreachablePlacements(stream: string, columns: number, rows: number): string[] {
	const failures: string[] = [];
	for (const { at, rowsAbove } of placements(stream)) {
		const scratch = new VirtualTerminal(columns, rows, 500);
		scratch.write(stream.slice(0, at));
		const cursorRow = scratch.getCursor().row;
		if (rowsAbove > cursorRow) {
			failures.push(`placement at byte ${at} moves up ${rowsAbove} from screen row ${cursorRow}`);
		}
	}
	return failures;
}

class Block implements Component {
	constructor(private readonly lines: readonly string[]) {}
	invalidate(): void {}
	render(): string[] {
		return [...this.lines];
	}
}

/** A transcript child that rewrites itself, so a frame has a changed row. */
class LiveBlock implements Component {
	#text: string;
	constructor(text: string) {
		this.#text = text;
	}
	invalidate(): void {}
	set(text: string): void {
		this.#text = text;
	}
	getRenderStablePrefixRows(): number {
		return 0;
	}
	render(): string[] {
		return [this.#text];
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

/** Claims native scrollback, which is what makes its children history. */
class Transcript extends Container {
	prepareNativeScrollbackReplay(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

interface Session {
	term: RecordingTerminal;
	tui: TUI;
	transcript: Transcript;
	image: Image;
}

function newImage(tui: TUI, columns: number, key: string): Image {
	const budget = new ImageBudget(4, () => tui.requestRender());
	return new Image(
		BASE64_ONE_PIXEL_PNG,
		"image/png",
		{ fallbackColor: text => text },
		{ maxWidthCells: columns - 4, maxHeightCells: IMAGE_ROWS, budget, imageKey: key },
		IMAGE_PIXELS,
	);
}

/** Wraps a picture so an overlay can hold one, under mutable spacer rows. */
class ImageHolder implements Component {
	#above: readonly string[];
	constructor(
		private readonly image: Image,
		above: readonly string[] = [],
	) {
		this.#above = above;
	}
	set(above: readonly string[]): void {
		this.#above = above;
	}
	invalidate(): void {
		this.image.invalidate();
	}
	render(width: number): string[] {
		return [...this.#above, ...this.image.render(width)];
	}
}

function openSession(columns: number, rows: number): Session {
	const term = new RecordingTerminal(columns, rows, 5_000);
	const tui = new TUI(term, true);
	tui.setScrollbackRebuild(true);
	const transcript = new Transcript();
	tui.addChild(transcript);
	tui.addChild(new Composer());
	tui.setPinnedFooterChildCount(1);
	return { term, tui, transcript, image: newImage(tui, columns, "shot") };
}

function turn(index: number): Block {
	return new Block([`> turn ${index}: what changed?`, `  reply ${index}: done.`]);
}

describe("a direct-placement image is drawn at its own origin or not at all", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCells: CellDimensions = { widthPx: 10, heightPx: 20 };

	function useKittyDirectPlacement(): void {
		originalCells = { ...getCellDimensions() };
		setCellDimensions(CELL);
		(TERMINAL as unknown as { imageProtocol: ImageProtocol | null }).imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: false });
	}

	function restore(): void {
		setCellDimensions(originalCells);
		(TERMINAL as unknown as { imageProtocol: ImageProtocol | null }).imageProtocol = originalProtocol;
		setKittyGraphics(originalGraphics);
	}

	test("the placement row round-trips its origin offset and nothing else claims one", () => {
		for (const rowsAbove of [1, 2, 9, 11, 47, 120]) {
			const row = encodeImagePlacementRow(rowsAbove, "\x1b_Ga=p,i=7\x1b\\");
			expect(imagePlacementRowsAbove(row)).toBe(rowsAbove);
			expect(row.endsWith("\x1b8")).toBe(true);
		}
		// A single-row picture needs no move, so it is not a placement row at all.
		expect(encodeImagePlacementRow(0, "\x1b_Ga=p,i=7\x1b\\")).toBe("\x1b_Ga=p,i=7\x1b\\");
		for (const line of [
			"",
			"plain text",
			"\x1b[0m",
			"\x1b_Ga=p,i=7\x1b\\",
			"\x1b7\x1b[Aoops",
			"\x1b7\x1b[3Boops",
			"\x1b7no-csi",
			"\x1b8\x1b[3A\x1b_Ga=p\x1b\\",
		]) {
			expect(imagePlacementRowsAbove(line)).toBe(0);
		}
	});

	test("a viewport shorter than the picture receives no placement at all", async () => {
		useKittyDirectPlacement();
		try {
			const { term, tui, transcript, image } = openSession(100, 30);
			transcript.addChild(new Block(["  before the picture"]));
			transcript.addChild(image);
			transcript.addChild(new Block(["  after the picture"]));
			tui.start();
			await settleFrames(term, tui);

			// Tall enough: the origin is reachable, so the graphic is on the wire.
			expect(term.writes.join("")).toContain(KITTY_PLACEMENT);

			const before = term.writes.length;
			term.resize(100, 8);
			tui.requestRender();
			await settleFrames(term, tui);
			const afterResize = term.writes.slice(before).join("");

			// 8 rows cannot hold a 12-row block, so no screen row reaches the
			// origin. Pre-fix this carried a full-size picture stamped at row 1.
			// The whole-stream oracle belongs to the fixed-size session below:
			// this stream spans two viewport heights, and a replay can only be
			// judged against one.
			expect(afterResize).not.toContain(KITTY_PLACEMENT);
			expect(placements(afterResize)).toEqual([]);
			tui.stop();
		} finally {
			restore();
		}
	});

	test("a resize drag repaints the viewport without clamping a straddling picture", async () => {
		useKittyDirectPlacement();
		try {
			const columns = 100;
			const dragged = 26;
			const { term, tui, transcript, image } = openSession(columns, 30);
			for (let i = 0; i < 8; i++) transcript.addChild(turn(i));
			transcript.addChild(image);
			// Seventeen rows below the picture: at height 26 its last row is screen
			// row 8, four rows short of the origin it has to reach.
			for (let i = 8; i < 16; i++) transcript.addChild(turn(i));
			tui.start();
			await settleFrames(term, tui);

			// One resize, then a settle. The slice covers both the drag fast path's
			// viewport repaints and the authoritative paint behind them, and every
			// byte of it was written at the same height, so one replay judges all
			// of it. No wait is tuned here: the oracle reads the cursor the parser
			// arrives at, whichever frames the scheduler chose to emit.
			const before = term.writes.length;
			term.resize(columns, dragged);
			await settleFrames(term, tui);
			const afterResize = term.writes.slice(before).join("");
			// The drag repainted the viewport (a row below the picture is in it)
			// and withheld the graphic, whose origin is four rows out of reach.
			expect(afterResize).toContain("reply 8: done.");
			expect(afterResize).not.toContain(KITTY_PLACEMENT);
			expect(unreachablePlacements(afterResize, columns, dragged)).toEqual([]);
			tui.stop();
		} finally {
			restore();
		}
	});

	test("no placement in a whole session asks for a row the terminal cannot reach", async () => {
		useKittyDirectPlacement();
		try {
			const columns = 100;
			const rows = 24;
			const { term, tui, transcript, image } = openSession(columns, rows);
			tui.start();
			await settleFrames(term, tui);

			// Six turns of two rows, the picture, six more turns, one composer row:
			// 37 rows into a 24-row window, so the block's last row lands at screen
			// row 10 with its origin 11 rows further up — one row out of reach.
			for (let i = 0; i < 6; i++) {
				transcript.addChild(turn(i));
				tui.requestRender();
				await settleFrames(term, tui);
			}
			transcript.addChild(image);
			tui.requestRender();
			await settleFrames(term, tui);
			for (let i = 6; i < 12; i++) {
				transcript.addChild(turn(i));
				tui.requestRender();
				await settleFrames(term, tui);
			}

			// Forced repaint: the whole window is rewritten from screen row 0, so
			// the straddling block's placement row is reached at row 10.
			const beforeRewrite = term.writes.length;
			tui.requestRender(true);
			await settleFrames(term, tui);
			const rewrite = term.writes.slice(beforeRewrite).join("");
			// The rewrite did cover the block (a row below it is in the same
			// write) and withheld the graphic rather than clamping it to row 1.
			expect(rewrite).toContain("reply 11: done.");
			expect(rewrite).not.toContain(KITTY_PLACEMENT);

			// Then a destructive repaint that rebuilds native scrollback.
			tui.requestRender(true, { clearScrollback: true });
			await settleFrames(term, tui);

			const stream = term.writes.join("");
			// The scenario is only evidence if it drew the picture at all.
			expect(stream).toContain(KITTY_PLACEMENT);
			expect(placements(stream).length).toBeGreaterThan(0);
			expect(unreachablePlacements(stream, columns, rows)).toEqual([]);
			tui.stop();
		} finally {
			restore();
		}
	});

	// One picture, driven through every gesture that makes the engine choose a
	// different emitter. `depth` puts rows above the picture, `tail` puts rows
	// below it, and together they decide where the block sits relative to the
	// window — which is what decides whether an emitter can reach its origin at
	// all. The heights bracket a viewport taller and shorter than the block; a
	// short tail keeps the block inside the window, a long one pushes it out.
	for (const height of [24, 10]) {
		for (const depth of [0, 3]) {
			for (const tail of [1, 8]) {
				test(`every emitter keeps the origin reachable at height ${height}, depth ${depth}, tail ${tail}`, async () => {
					useKittyDirectPlacement();
					try {
						const columns = 100;
						const { term, tui, transcript, image } = openSession(columns, height);
						const live = new LiveBlock("  still arriving");
						const above = new LiveBlock("  header");
						for (let i = 0; i < depth; i++) transcript.addChild(turn(i));
						transcript.addChild(above);
						transcript.addChild(image);
						tui.start();
						await settleFrames(term, tui);

						// Seam rewrite: several children land between two frames, so the
						// chunk written into history starts mid-frame.
						for (let i = depth; i < depth + tail; i++) transcript.addChild(turn(i));
						tui.requestRender();
						await settleFrames(term, tui);

						// Scroll append one row at a time, each its own frame, so the
						// append emitter runs with the block still on screen.
						for (let i = 0; i < 3; i++) {
							transcript.addChild(new Block([`  appended ${i}`]));
							tui.requestRender();
							await settleFrames(term, tui);
						}
						// One frame that scrolls by more rows than a single append, so the
						// re-written bottom slice is wide enough to cover a block.
						transcript.addChild(new Block(Array.from({ length: 6 }, (_, row) => `  burst ${row}`)));
						tui.requestRender();
						await settleFrames(term, tui);

						// A changed row inside the window after a shift.
						transcript.addChild(live);
						tui.requestRender();
						await settleFrames(term, tui);
						live.set("  still arriving, longer now");
						tui.requestRender();
						await settleFrames(term, tui);

						// A component-scoped render of the picture itself, so the segment
						// rewrite addresses the block rather than a neighbour.
						tui.requestComponentRender(image);
						await settleFrames(term, tui);

						// Component-scoped render: the segment rewrite, which addresses a
						// span of the window rather than the whole of it. Driven from a
						// child above the picture as well as one below it, so the span
						// reaches the block from either side.
						live.set("  finished");
						tui.requestComponentRender(live);
						await settleFrames(term, tui);
						above.set("  header, rewritten");
						tui.requestComponentRender(above);
						await settleFrames(term, tui);

						// Forced in-place repaint, then a destructive one.
						tui.requestRender(true);
						await settleFrames(term, tui);
						tui.requestRender(true, { clearScrollback: true });
						await settleFrames(term, tui);

						// A picture inside a fullscreen overlay, which paints on the
						// alternate screen through a different emitter entirely. The
						// spacer pushes the block down so a short viewport clips its top,
						// and changing the spacer between frames makes the second paint a
						// diff against the first rather than another full one.
						const holder = new ImageHolder(newImage(tui, columns, "overlay"), [
							"  overlay",
							"  spacer",
							"  rows",
						]);
						const overlay = tui.showOverlay(holder, { fullscreen: true });
						await settleFrames(term, tui);
						holder.set(["  overlay, rewritten", "  spacer", "  rows", "  one more"]);
						tui.requestRender();
						await settleFrames(term, tui);
						holder.set(["  overlay"]);
						tui.requestRender();
						await settleFrames(term, tui);
						overlay.hide();
						await settleFrames(term, tui);

						// A second picture arriving once the window is already full: its
						// placement row reaches the screen through the append emitter,
						// which addresses the bottom row rather than the block's own.
						transcript.addChild(newImage(tui, columns, "late"));
						tui.requestRender();
						await settleFrames(term, tui);
						transcript.addChild(new Block(["  after the late picture"]));
						tui.requestRender();
						await settleFrames(term, tui);

						expect(unreachablePlacements(term.writes.join(""), columns, height)).toEqual([]);
						tui.stop();
					} finally {
						restore();
					}
				});
			}
		}
	}
});
