/**
 * WHY. A card is only a surface if it differs from the page behind it, and the direction that
 * difference points is not fixed: on a dark terminal a surface is lit toward white, and on a light
 * terminal the same lift toward white produces the page again and the card disappears. The module
 * decides with BT.601 luminance so it cannot disagree with the theme about which kind of terminal
 * it is on. No test named it, so nothing reported a polarity that had been inverted, a threshold
 * that had drifted, or a weighting quietly replaced by a channel average — each of which looks
 * correct in the half of the world the author was looking at.
 *
 * The other pinned property is band precedence. A card is three plates, and the header and footer
 * trays are ranges that may overlap; the module resolves an overlap to the LAST band by walking its
 * list backwards. Written forwards it still produces a plausible card, with the wrong tray on top.
 *
 * The class this closes: polarity and threshold errors in the lift direction, a luminance formula
 * replaced by something that agrees with it on grey, band precedence and exclusivity, a lift that
 * escapes 0-1, and a fill that overwrites a background the component chose for itself.
 *
 * What it does not catch: whether the chosen elevations look right to a person, and the column
 * mechanics of the pass underneath, which that module's own suite pins.
 */
import { describe, expect, it } from "bun:test";
import { fillSurface, liftHex, surfaceColorAt, surfaceRowColor } from "../src/paint-surface";

const CSI = "\x1b[";
const RESET_BG = `${CSI}49m`;

describe("liftHex", () => {
	it("lifts toward white on a dark ground and toward black on a light one", () => {
		expect(liftHex("#000000", 0.1)).toBe("#1a1a1a");
		expect(liftHex("#ffffff", 0.1)).toBe("#e6e6e6");
	});

	it("decides the direction at the BT.601 midpoint, not at a channel midpoint", () => {
		// #808080 is luminance 0.502 and counts as light; one step darker counts as dark. A
		// threshold that drifted either way moves one of these to the wrong side.
		expect(liftHex("#808080", 0.1)).toBe("#737373");
		expect(liftHex("#7f7f7f", 0.1)).toBe("#8c8c8c");
	});

	it("weights the channels, so a green ground and a blue ground lift opposite ways", () => {
		// Same channel magnitude, opposite luminance: an unweighted average calls both identical
		// and sends them the same direction.
		expect(liftHex("#00ff00", 0.1)).toBe("#00e600");
		expect(liftHex("#0000ff", 0.1)).toBe("#1a1aff");
	});

	it("returns a ground it cannot parse unchanged instead of inventing a surface", () => {
		expect(liftHex("not-a-colour", 0.1)).toBe("not-a-colour");
	});

	it("holds the amount inside 0-1 so an overdriven treatment cannot exceed the ends", () => {
		expect(liftHex("#000000", 5)).toBe("#ffffff");
		expect(liftHex("#000000", -5)).toBe("#000000");
	});
});

describe("surfaceColorAt", () => {
	it("is brighter at the top than at the foot, so the plate reads as lit from above", () => {
		const ground = "#000000";

		expect(surfaceColorAt({ ground }, 0)).toBe("#1a1a1a");
		expect(surfaceColorAt({ ground }, 1)).toBe("#0e0e0e");
	});

	it("keeps the foot off the page rather than letting it sink back into the ground", () => {
		expect(surfaceColorAt({ ground: "#000000" }, 1)).not.toBe("#000000");
	});

	it("interpolates between the two elevations across the height", () => {
		expect(surfaceColorAt({ ground: "#000000" }, 0.5)).toBe("#141414");
	});

	it("honors the documented defaults for both elevations", () => {
		const ground = "#000000";

		expect(surfaceColorAt({ ground }, 0)).toBe(surfaceColorAt({ ground, lift: 0.1 }, 0));
		expect(surfaceColorAt({ ground }, 1)).toBe(surfaceColorAt({ ground, bottomLift: 0.055 }, 1));
	});

	it("clamps a height outside the block to the nearest end", () => {
		const ground = "#000000";

		expect(surfaceColorAt({ ground }, -3)).toBe(surfaceColorAt({ ground }, 0));
		expect(surfaceColorAt({ ground }, 9)).toBe(surfaceColorAt({ ground }, 1));
	});
});

describe("surfaceRowColor", () => {
	const spec = {
		ground: "#000000",
		bands: [
			{ start: 0, end: 3, lift: 0.4 },
			{ start: 2, end: 4, lift: 0.8 },
		],
	};

	it("gives a banded row its band's flat elevation instead of the gradient", () => {
		expect(surfaceRowColor(spec, 0, 10)).toBe("#666666");
	});

	it("resolves an overlap to the later band", () => {
		expect(surfaceRowColor(spec, 2, 10)).toBe("#cccccc");
	});

	it("treats a band's end as exclusive and returns the gradient past it", () => {
		expect(surfaceRowColor(spec, 3, 10)).toBe("#cccccc");
		expect(surfaceRowColor(spec, 4, 10)).toBe("#151515");
	});

	it("returns the top elevation rather than dividing by zero on an empty block", () => {
		expect(surfaceRowColor({ ground: "#000000" }, 5, 0)).toBe(surfaceColorAt({ ground: "#000000" }, 0));
	});
});

describe("fillSurface", () => {
	it("returns the rows untouched, in a new array, when the treatment has no strength", () => {
		const lines = ["ab"];

		const filled = fillSurface(lines, 2, { ground: "#000000" }, 0);

		expect(filled).toEqual(["ab"]);
		expect(filled).not.toBe(lines);
	});

	it("runs the gradient from the top row to the foot and closes each row", () => {
		const filled = fillSurface(["ab", "cd"], 2, { ground: "#000000" });

		expect(filled).toEqual([`${CSI}48;2;26;26;26mab${RESET_BG}`, `${CSI}48;2;14;14;14mcd${RESET_BG}`]);
	});

	it("puts a single row at the top elevation rather than at the foot", () => {
		expect(fillSurface(["ab"], 2, { ground: "#000000" })).toEqual([`${CSI}48;2;26;26;26mab${RESET_BG}`]);
	});

	it("leaves a background the component chose for itself alone", () => {
		// The surface is what the card is made of, not a wash over everything on it: a chip or a
		// selection that set its own background keeps it.
		const filled = fillSurface([`${CSI}48;2;9;9;9mab`], 2, { ground: "#000000" });

		expect(filled).toEqual([`${CSI}48;2;9;9;9mab${RESET_BG}`]);
	});

	it("fills only the columns the surface occupies, leaving the page either side", () => {
		const filled = fillSurface(["abcd"], 4, { ground: "#000000", columns: { start: 1, end: 3 } });

		expect(filled).toEqual([`a${CSI}48;2;26;26;26mbc${RESET_BG}d`]);
	});

	it("returns an empty block unchanged", () => {
		expect(fillSurface([], 2, { ground: "#000000" })).toEqual([]);
	});
});
