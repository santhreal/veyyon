/**
 * The proof images have to show what the render actually did.
 *
 * Every assertion here DECODES the produced PNG and reads pixels back, because the
 * only thing that matters about this tool is what ends up in the picture. A test that
 * checked the intermediate grid would pass while the drawing step painted the wrong
 * rectangle, and the whole reason to rasterize is to be believed about the picture.
 *
 * The two claims worth the most:
 *
 *  - A cell with an EXPLICIT background paints identically on both grounds, and a
 *    cell that leaves the background to the terminal does not. That pair is the
 *    reason both grounds are rendered: it is exactly how "this fill is invisible on
 *    black and a slab on grey" becomes visible instead of arguable.
 *  - A fill covers the WHOLE cell, padding included, so a one-column gap in a fill
 *    reads as a stripe of ground rather than being swallowed by the spacing.
 */
import { describe, expect, it } from "bun:test";
import { inflateSync } from "node:zlib";
import { ansiToGrid, type Cell } from "./ansi-grid";
import { BLACK_GROUND, GREY_GROUND, GROUNDS, proofsForLines, rasterizeGrid, resolveCellColors } from "./ansi-raster";
import { GLYPH_HEIGHT, GLYPH_WIDTH } from "./glyphs";

/** A decoded image, with a pixel reader. Filter 0 and colour type 2 only, which is
 * all the encoder emits. */
interface Decoded {
	width: number;
	height: number;
	at(x: number, y: number): [number, number, number];
}

function decode(png: Uint8Array): Decoded {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	let offset = 8;
	let width = 0;
	let height = 0;
	const idat: Uint8Array[] = [];
	while (offset < png.length) {
		const length = view.getUint32(offset);
		const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
		const data = png.subarray(offset + 8, offset + 8 + length);
		if (type === "IHDR") {
			width = view.getUint32(offset + 8);
			height = view.getUint32(offset + 12);
		}
		if (type === "IDAT") idat.push(data);
		offset += 12 + length;
	}
	const raw = new Uint8Array(inflateSync(Buffer.concat(idat.map(part => Buffer.from(part)))));
	const stride = width * 3;
	return {
		width,
		height,
		at(x, y) {
			const base = y * (stride + 1) + 1 + x * 3;
			return [raw[base], raw[base + 1], raw[base + 2]];
		},
	};
}

/** Rasterize one line and decode it, at a scale that keeps the arithmetic easy. */
function render(line: string, width: number, ground = GREY_GROUND, scale = 1) {
	const result = rasterizeGrid(ansiToGrid([line], width), ground, {
		scale,
		margin: 2,
		cellPaddingX: 1,
		cellPaddingY: 2,
	});
	return { ...result, image: decode(result.png) };
}

const CELL_W = GLYPH_WIDTH + 1;
const CELL_H = GLYPH_HEIGHT + 2;

function blank(overrides: Partial<Cell> = {}): Cell {
	return {
		char: " ",
		fg: undefined,
		bg: undefined,
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		reverse: false,
		continuation: false,
		...overrides,
	};
}

describe("image geometry", () => {
	it("sizes the image from the cell metrics, margins included", () => {
		const { image } = render("ab", 4);

		expect(image.width).toBe(4 * CELL_W + 4);
		expect(image.height).toBe(1 * CELL_H + 4);
	});

	it("scales every dimension", () => {
		const { image } = render("ab", 4, GREY_GROUND, 3);

		expect(image.width).toBe(4 * CELL_W * 3 + 4);
	});

	/** The margin is ground, which is what makes an edge-to-edge fill visibly reach
	 * the edge instead of merely being the last thing in the file. */
	it("surrounds the render with ground", () => {
		const { image } = render("\x1b[48;2;40;44;52mfill", 4);

		expect(image.at(0, 0)).toEqual([...GREY_GROUND.background]);
		expect(image.at(image.width - 1, image.height - 1)).toEqual([...GREY_GROUND.background]);
	});
});

describe("backgrounds", () => {
	/** A fill must cover the padding too. If it stopped at the glyph box, every
	 * filled row would be striped with ground and a real gap would be unreadable. */
	it("paints a filled cell across its full width, padding included", () => {
		const { image } = render("\x1b[48;2;40;44;52mab", 4);

		// Row 7 of the cell is inter-line padding, below every glyph, so any pixel
		// there that is not the fill is a gap in the fill rather than ink.
		for (let x = 2; x < 2 + CELL_W * 2; x++) {
			expect(image.at(x, 2 + GLYPH_HEIGHT), `x=${x}`).toEqual([40, 44, 52]);
		}
	});

	/** Where the fill stops, ground begins, in the very next column. */
	it("shows ground in the columns a fill did not reach", () => {
		const { image } = render("\x1b[48;2;40;44;52mab\x1b[0m", 4);

		expect(image.at(2 + CELL_W * 2, 2 + 4)).toEqual([...GREY_GROUND.background]);
	});

	/**
	 * The reason both grounds exist. An explicit fill is the same pixels on both, so
	 * the DIFFERENCE between the two images is exactly the region whose appearance
	 * depends on the user's terminal.
	 */
	it("renders an explicit fill identically on both grounds, and a default one differently", () => {
		const explicitGrey = render("\x1b[48;2;40;44;52m  ", 2, GREY_GROUND).image.at(3, 6);
		const explicitBlack = render("\x1b[48;2;40;44;52m  ", 2, BLACK_GROUND).image.at(3, 6);
		expect(explicitGrey).toEqual(explicitBlack);

		const defaultGrey = render("  ", 2, GREY_GROUND).image.at(3, 6);
		const defaultBlack = render("  ", 2, BLACK_GROUND).image.at(3, 6);
		expect(defaultGrey).not.toEqual(defaultBlack);
	});

	it("offers both grounds, grey first", () => {
		expect(GROUNDS.map(g => g.name)).toEqual(["grey", "black"]);
	});
});

describe("resolved cell colours", () => {
	it("uses the ground's defaults when the cell names no colour", () => {
		const { fg, bg } = resolveCellColors(blank(), GREY_GROUND);

		expect(bg).toEqual(GREY_GROUND.background);
		expect(fg).toEqual(GREY_GROUND.foreground);
	});

	/** Reverse video has to swap the RESOLVED colours, so a reversed cell with no
	 * colours of its own paints the ground's foreground as its background. That is
	 * how a selected row or an inverted badge reads in a proof. */
	it("swaps foreground and background for reverse video", () => {
		const { fg, bg } = resolveCellColors(blank({ reverse: true }), GREY_GROUND);

		expect(bg).toEqual(GREY_GROUND.foreground);
		expect(fg).toEqual(GREY_GROUND.background);
	});

	/** Dim moves the foreground TOWARD the background, so it must depend on the
	 * ground: dim text is a different colour on grey than on black, which is one of
	 * the contrast questions a proof is asked to settle. */
	it("moves a dim foreground toward the background it sits on", () => {
		const onGrey = resolveCellColors(blank({ fg: [255, 255, 255], dim: true }), GREY_GROUND).fg;
		const onBlack = resolveCellColors(blank({ fg: [255, 255, 255], dim: true }), BLACK_GROUND).fg;

		expect(onGrey[0]).toBeGreaterThan(onBlack[0]);
		expect(onGrey[0]).toBeLessThan(255);
	});

	it("pushes a bold foreground away from the ground, without overflowing", () => {
		expect(resolveCellColors(blank({ fg: [100, 100, 100], bold: true }), GREY_GROUND).fg[0]).toBeGreaterThan(100);
		expect(resolveCellColors(blank({ fg: [250, 250, 250], bold: true }), GREY_GROUND).fg[0]).toBe(255);
	});
});

describe("glyphs", () => {
	/** Ink lands where the font says. `T` fills its whole top row, so the top-left
	 * pixel of the glyph box is ink and the row below its bar is not. */
	it("draws a glyph's ink in the cell's own box", () => {
		const { image } = render("T", 1);
		const originX = 2;
		const originY = 2;

		expect(image.at(originX, originY)).toEqual([...GREY_GROUND.foreground]);
		expect(image.at(originX, originY + 1)).toEqual([...GREY_GROUND.background]);
	});

	/**
	 * An unmapped character is reported, never quietly boxed. A proof speckled with
	 * unexplained boxes reads as a bug in the component being proved, which is the
	 * most expensive way for this tool to be wrong.
	 */
	it("reports every character it had no glyph for", () => {
		const result = render(" ok", 6);

		expect(result.unmapped).toEqual([""]);
	});

	it("reports nothing for text it can fully draw", () => {
		expect(render("ok 12 ─┐", 8).unmapped).toEqual([]);
	});

	/**
	 * Every glyph the agent roster's status column can print has a bitmap.
	 *
	 * The roster proof exists to show WHICH agents are running, and the status
	 * glyph is the only cell that says so. `⟳` was unmapped, so every running row
	 * on the Agent Control Center proof drew a hollow box: the tool reported it,
	 * but a reported gap in exactly the column under test is still a proof that
	 * cannot answer its own question. Adding a fifth status to the card without a
	 * glyph here fails this rather than surfacing as boxes in the next image.
	 */
	it("has a glyph for every agent status mark the roster can draw", () => {
		// The symbols behind `status.running` / `enabled` / `shadowed` / `aborted`
		// in the theme's symbol table. Spelled out rather than imported: the demo
		// scripts do not depend on the coding agent, and this is a four-character
		// contract that a wrong assertion would state wrongly out loud.
		for (const mark of ["⟳", "▪", "▫", "∎"]) {
			expect(render(mark, 1).unmapped).toEqual([]);
		}
	});

	/**
	 * And every glyph a checkbox row can print.
	 *
	 * Same failure, different surface. The setup wizard's theme step turns its two
	 * modifiers into toggles, and a proof of a toggle is a proof of one glyph:
	 * filled means on, outline means off. Both were unmapped, so the first proof
	 * of that change drew a hollow box in each state and showed nothing at all.
	 */
	it("has a glyph for both checkbox states", () => {
		// `checkbox.checked` / `checkbox.unchecked` in the unicode symbol table.
		// The ASCII preset draws `[x]` and `[ ]`, which are plain characters.
		for (const mark of ["■", "□"]) {
			expect(render(mark, 1).unmapped).toEqual([]);
		}
	});

	/**
	 * The two states must not raster to the SAME pixels, or the proof lies.
	 *
	 * Aliasing one checkbox to the other would satisfy the coverage test above
	 * and produce an image where on and off are indistinguishable, which is worse
	 * than the hollow boxes: a reported gap is at least reported.
	 */
	it("draws the checked and unchecked boxes differently", () => {
		const checked = render("■", 1).image;
		const unchecked = render("□", 1).image;

		let differing = 0;
		for (let y = 0; y < checked.height; y++) {
			for (let x = 0; x < checked.width; x++) {
				if (String(checked.at(x, y)) !== String(unchecked.at(x, y))) differing += 1;
			}
		}

		expect(differing).toBeGreaterThan(0);
	});

	/** A double-width grapheme must draw ONE glyph. Drawing it in the continuation
	 * cell as well would double every wide character and make a CJK proof unreadable. */
	it("draws a wide grapheme once, and fills its continuation cell", () => {
		const { image, unmapped } = render("\x1b[48;2;40;44;52m漢", 3);

		// Reported once, not twice, and the second cell carries the fill.
		expect(unmapped).toEqual(["漢"]);
		expect(image.at(2 + CELL_W, 2 + 4)).toEqual([40, 44, 52]);
	});
});

describe("proofsForLines", () => {
	it("produces one decodable image per ground, at the same size", () => {
		const proofs = proofsForLines(["hello", "world"], 10, { scale: 1 });

		expect(proofs).toHaveLength(2);
		for (const proof of proofs) {
			const image = decode(proof.png);
			expect(image.width).toBe(proof.width);
			expect(image.height).toBe(proof.height);
		}
		expect(proofs[0].width).toBe(proofs[1].width);
	});

	/**
	 * The width is the render's column count, not the longest line, so a component
	 * that ends its lines early keeps the empty right edge that shows it did. Cropping
	 * to the text would delete the evidence.
	 */
	it("keeps the full requested width even when every line is shorter", () => {
		const narrow = proofsForLines(["ab"], 2, { scale: 1 })[0];
		const wide = proofsForLines(["ab"], 40, { scale: 1 })[0];

		expect(wide.width).toBeGreaterThan(narrow.width);
	});
});
