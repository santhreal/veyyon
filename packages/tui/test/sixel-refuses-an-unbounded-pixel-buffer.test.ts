/**
 * The SIXEL encoder gets a PIXEL bound, because the cell bound is not one.
 *
 * `calculateImageFit` clamps an image to `MAX_IMAGE_FIT_CELLS` (4096) terminal cells, and its own
 * comment explains that as the OOM defence: a hostile header claiming billions of pixels would
 * otherwise ask the renderer for billions of rows. That bound is in CELLS. The SIXEL path then
 * multiplies cells by the cell's pixel size and hands the product to the native encoder, which
 * resizes the image to exactly those dimensions and converts the result to RGBA. At the cell
 * ceiling with an ordinary 10x20 cell that is 40960x81920 pixels, a 13 GB buffer, inside Rust.
 *
 * A Rust allocation failure ABORTS the process. It is not an exception, the surrounding
 * `try/catch` cannot see it, and the session dies with no diagnostic. The bound therefore has to
 * be checked in JavaScript BEFORE the call, which is what this suite pins.
 *
 * Both the source and the target are checked, because they fail at different points: the target
 * blows up in the resize, and a small file whose header claims gigapixels blows up in `decode()`,
 * before any resize can shrink it. Neither ceiling is reachable by a real image, so a legitimate
 * render must be unaffected, and the positive cases here are as load-bearing as the refusals.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	type CellDimensions,
	getCellDimensions,
	ImageProtocol,
	renderImage,
	setCellDimensions,
	TERMINAL,
} from "@veyyon/tui/terminal-capabilities";

type MutableTerminalInfo = { imageProtocol: ImageProtocol | null };
const terminal = TERMINAL as unknown as MutableTerminalInfo;

/** A real one-pixel PNG, so the encoder has something decodable when the guard lets a call through. */
const ONE_PIXEL_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNgAAAAAgABSK+kcQAAAABJRU5ErkJggg==";

describe("SIXEL rendering refuses a pixel buffer it cannot allocate", () => {
	const originalProtocol = TERMINAL.imageProtocol;
	let originalCellDims: CellDimensions;

	beforeEach(() => {
		originalCellDims = { ...getCellDimensions() };
		terminal.imageProtocol = ImageProtocol.Sixel;
	});

	afterEach(() => {
		setCellDimensions(originalCellDims);
		terminal.imageProtocol = originalProtocol;
	});

	/**
	 * The case the cell ceiling lets through: a fit at the cell cap, on a normal cell.
	 *
	 * 4096 cells is the clamp `calculateImageFit` applies, so this is the LARGEST request the
	 * existing guard permits, and on a 10x20 cell it is 40960x81920 pixels. Asking for it must
	 * produce no render rather than a multi-gigabyte allocation.
	 */
	it("refuses a target at the cell ceiling on an ordinary cell", () => {
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		const huge = renderImage(ONE_PIXEL_PNG, { widthPx: 1_000_000, heightPx: 1_000_000 }, {});
		expect(huge).toBeNull();
	});

	/**
	 * A source whose header claims gigapixels, at a target small enough to pass the target check.
	 *
	 * This is the decompression-bomb shape and the reason the source is checked separately: the
	 * native decodes before it resizes, so a tiny file claiming 100000x100000 allocates on the way
	 * in no matter how small the output was going to be.
	 */
	it("refuses a source whose declared dimensions are gigapixels", () => {
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		const bomb = renderImage(
			ONE_PIXEL_PNG,
			{ widthPx: 100_000, heightPx: 100_000 },
			{ maxWidthCells: 20, maxHeightCells: 10 },
		);
		expect(bomb).toBeNull();
	});

	/**
	 * An extreme aspect ratio, which defeats a bound written on either axis alone.
	 *
	 * A 1x4000000000 image has an unremarkable width, so a per-axis check passes it and the area
	 * is still astronomical. The guard is on the PRODUCT for exactly this.
	 */
	it("refuses an extreme aspect ratio whose area is still astronomical", () => {
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		expect(renderImage(ONE_PIXEL_PNG, { widthPx: 1, heightPx: 4_000_000_000 }, {})).toBeNull();
	});

	/**
	 * The positive twin, and it is what makes the refusals mean anything.
	 *
	 * A guard that returned null for every SIXEL render would satisfy all three cases above while
	 * removing the feature. An ordinary image fit to a normal viewport must still produce a
	 * sequence, with the row count the fit computed.
	 */
	it("still renders an ordinary image", () => {
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		const rendered = renderImage(ONE_PIXEL_PNG, { widthPx: 200, heightPx: 100 }, { maxWidthCells: 40 });
		expect(rendered).not.toBeNull();
		expect(rendered?.sequence).toBeTypeOf("string");
		expect(rendered?.sequence?.length).toBeGreaterThan(0);
		expect(rendered?.rows).toBeGreaterThan(0);
	});

	/**
	 * And a large but plausible image is still drawn, so the ceiling is not sitting on real usage.
	 *
	 * A 4K photograph is about 8.3 megapixels, half the ceiling, and it renders. If a future change
	 * lowered the bound into the range terminals actually use, this is the test that would say so.
	 */
	it("still renders a 4K-sized source", () => {
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		const rendered = renderImage(ONE_PIXEL_PNG, { widthPx: 3840, heightPx: 2160 }, { maxWidthCells: 80 });
		expect(rendered).not.toBeNull();
		expect(rendered?.sequence?.length).toBeGreaterThan(0);
	});
});
