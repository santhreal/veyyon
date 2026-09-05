/**
 * WHY: an inline picture rendered whole, and later — after more transcript had
 * pushed its first rows into native scrollback and something forced the
 * viewport to repaint (an overlay opening or closing, a resize, a tool
 * finalizing) — only its top part showed, sitting over shredded text. The
 * direct Kitty placement is the block's LAST row and climbs `CUU rows-1` to
 * the origin; with the origin above the viewport the climb clamps at row 0,
 * the whole picture lands `hidden` rows too low, and the rows under it are
 * rewritten over its tail. WezTerm attaches image pixels to cells, so every
 * rewritten row erased its band; kitty proper draws the misplaced picture
 * over the text. Which frame it struck depended on where the viewport
 * boundary fell inside the block, which read as "flaky".
 *
 * The class this closes: every in-viewport rewrite of a direct-placement
 * line whose block starts above the viewport, on every emitter (forced window
 * rewrite, viewport-only full paint, alt-screen frame, resize viewport,
 * scroll-append tail, component-scoped rewrite). All of them route through
 * one row-aware line writer, so the suite drives the forced rewrite and pins
 * the bytes that writer produces.
 *
 * Not caught: a terminal that ignores the `x,y,w,h` source rectangle, and the
 * Unicode-placeholder path, which has no climb to clamp.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { TUI } from "@veyyon/tui";
import { Image } from "@veyyon/tui/components/image";
import { Text } from "@veyyon/tui/components/text";
import { getKittyGraphics, setKittyGraphics } from "@veyyon/tui/kitty-graphics";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	setCellDimensions,
	TERMINAL,
} from "@veyyon/tui/terminal-capabilities";
import { settleFrames } from "./helpers/settle-frames";
import { VirtualTerminal } from "./virtual-terminal";

type MutableTerminalInfo = { id: string; imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

const BASE64_ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

const HEIGHT = 12;
/** 40x80 px at a 10x10 cell: 4 columns by 8 rows. */
const IMAGE_ROWS = 8;
const IMAGE_HEIGHT_PX = 80;
const LEAD_ROWS = 3;
const ORIGINAL_TMUX = Bun.env.TMUX;

/** Tail rows that leave `hidden` rows of the picture above a `HEIGHT`-row viewport. */
function tailRowsHiding(hidden: number): number {
	return HEIGHT + hidden - IMAGE_ROWS;
}

describe("an image whose top scrolled away repaints only its visible rows", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	const originalTerminalId = terminal.id;
	const originalGraphics = { ...getKittyGraphics() };
	let originalCellDims: CellDimensions;
	let monotonicNow = 0;
	beforeEach(() => {
		delete Bun.env.TMUX;
		originalCellDims = { ...getCellDimensions() };
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		terminal.imageProtocol = ImageProtocol.Kitty;
		terminal.id = "xterm";
		setKittyGraphics({ unicodePlaceholders: false });
		monotonicNow = 0;
		vi.spyOn(performance, "now").mockImplementation(() => {
			monotonicNow += 40;
			return monotonicNow;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		if (ORIGINAL_TMUX === undefined) delete Bun.env.TMUX;
		else Bun.env.TMUX = ORIGINAL_TMUX;
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
		terminal.id = originalTerminalId;
		setKittyGraphics(originalGraphics);
	});

	/**
	 * A transcript of `LEAD_ROWS` text rows, the picture, then `tailRows` more
	 * text rows, painted once; returns what a forced viewport rewrite writes.
	 */
	async function forcedRewriteAfter(tailRows: number): Promise<{ id: number; rewrite: string }> {
		const term = new VirtualTerminal(40, HEIGHT);
		const writes: string[] = [];
		const realWrite = term.write.bind(term);
		vi.spyOn(term, "write").mockImplementation((data: string) => {
			writes.push(data);
			realWrite(data);
		});
		const tui = new TUI(term);
		const id = tui.imageBudget.acquireId("straddle");
		for (let i = 0; i < LEAD_ROWS; i++) tui.addChild(new Text(`lead ${i}`, 0, 0));
		tui.addChild(
			new Image(
				BASE64_ONE_PIXEL_PNG,
				"image/png",
				{ fallbackColor: t => t },
				{ maxWidthCells: 4, maxHeightCells: IMAGE_ROWS, budget: tui.imageBudget, imageKey: "straddle" },
				{ widthPx: 40, heightPx: IMAGE_HEIGHT_PX },
			),
		);
		for (let i = 0; i < tailRows; i++) tui.addChild(new Text(`tail ${i}`, 0, 0));
		try {
			tui.start();
			await settleFrames(term, tui);
			writes.length = 0;
			tui.requestRender(true);
			await settleFrames(term, tui);
			return { id, rewrite: writes.join("") };
		} finally {
			tui.stop();
		}
	}

	it("clips the placement to the rows below the viewport top and climbs no further than row 0", async () => {
		// 3 lead + 8 image + 6 tail = 17 rows in a 12-row viewport: the viewport
		// starts at frame row 5, two image rows are in scrollback, and the
		// placement row sits at screen row 5.
		const hidden = 2;
		const { id, rewrite } = await forcedRewriteAfter(tailRowsHiding(hidden));
		const placements = rewrite.match(/\x1b_Ga=p[^\x1b]*\x1b\\/g) ?? [];
		expect(placements).toHaveLength(1);
		const placement = placements[0]!;
		// THE CONTRACT: the visible six rows, sourced from the picture's bottom
		// 60 of 80 pixels, under a placement id of their own.
		expect(placement).toContain(`i=${id}`);
		expect(placement).toContain(`p=${id + hidden}`);
		expect(placement).toContain(`r=${IMAGE_ROWS - hidden}`);
		expect(placement).toContain("y=20");
		expect(placement).toContain(`h=${IMAGE_HEIGHT_PX - 20}`);
		expect(placement).toContain("x=0,y=20,w=40,h=60");
		// The climb reaches the viewport top and never the origin's row count.
		expect(rewrite).toContain(`\x1b7\x1b[${IMAGE_ROWS - 1 - hidden}A\x1b_G`);
		expect(rewrite).not.toContain(`\x1b[${IMAGE_ROWS - 1}A`);
	});

	it("keeps the original placement when the picture's first row is the viewport top", async () => {
		// hidden = 0: the origin sits at screen row 0, so the climb lands there
		// and nothing needs clipping. The boundary an off-by-one would cross.
		const { id, rewrite } = await forcedRewriteAfter(tailRowsHiding(0));
		const placements = rewrite.match(/\x1b_Ga=p[^\x1b]*\x1b\\/g) ?? [];
		expect(placements).toHaveLength(1);
		const placement = placements[0]!;
		expect(placement).toContain(`p=${id},`);
		expect(placement).toContain(`r=${IMAGE_ROWS}`);
		expect(placement).not.toContain("y=");
		expect(rewrite).toContain(`\x1b7\x1b[${IMAGE_ROWS - 1}A\x1b_G`);
	});

	it("shows the last row alone when every other row of the block is above the viewport", async () => {
		const hidden = IMAGE_ROWS - 1;
		const { id, rewrite } = await forcedRewriteAfter(tailRowsHiding(hidden));
		const placements = rewrite.match(/\x1b_Ga=p[^\x1b]*\x1b\\/g) ?? [];
		expect(placements).toHaveLength(1);
		const placement = placements[0]!;
		expect(placement).toContain(`p=${id + hidden}`);
		expect(placement).toContain("r=1");
		expect(placement).toContain("x=0,y=70,w=40,h=10");
		// One visible row: no climb, no cursor save.
		expect(rewrite).not.toContain("\x1b7\x1b[");
	});
});
