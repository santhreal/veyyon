/**
 * WHY: `liftHex` is the one place a colour is moved OFF the ground it will be seen
 * on, and every surface treatment in the product is written through it — the
 * specular sweep that crosses a card, the transcript note's plate, and any band
 * within one. "Lift" cannot mean "toward white": on a light terminal that is the
 * direction of invisibility, and a highlight that brightens a near-white ground
 * disappears exactly where it is supposed to read. So the direction is chosen from
 * the ground's own luminance, at the same BT.601 boundary the terminal uses for
 * an OSC 11 answer, and a card must not disagree with the theme about which kind
 * of terminal it is on.
 *
 * This suite carried over from the card-material suite it used to live in, which
 * was deleted with the card fill it was written for. The primitive stayed, so the
 * claim stays, and it belongs on the package that owns the primitive.
 *
 * NOT covered here: how large a lift should be (taste, judged in an image), and
 * the blend's own arithmetic beyond direction and the fixed points.
 */
import { describe, expect, test } from "bun:test";
import { liftHex, parseHexColor } from "../src/index";

/** BT.601 luminance, the same weighting the direction choice is made on. */
function luminance(hex: string): number {
	const rgb = parseHexColor(hex);
	if (rgb === null) throw new Error(`not a colour: ${hex}`);
	return (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
}

describe("a lift moves off the ground it sits on", () => {
	test("brightens a dark ground and darkens a light one, at the terminal's own boundary", () => {
		// #767676 sits just under half, #808080 just over: the two sides of the
		// boundary `#handleOsc11Response` classifies a terminal by.
		expect(luminance(liftHex("#767676", 0.2))).toBeGreaterThan(luminance("#767676"));
		expect(luminance(liftHex("#808080", 0.2))).toBeLessThan(luminance("#808080"));
	});

	test("is monotone in amount on either side of the boundary", () => {
		// A lift that is not monotone gives a gradient that reverses mid-ramp, which
		// reads as a seam rather than as elevation.
		for (const ground of ["#1e2127", "#000000", "#f7f7f8", "#ffffff"]) {
			const away = (amount: number): number => Math.abs(luminance(liftHex(ground, amount)) - luminance(ground));
			let previous = -1;
			for (const amount of [0, 0.05, 0.1, 0.2, 0.4, 0.8, 1]) {
				const distance = away(amount);
				expect(distance, `${ground} at ${amount} moved no further than at the step below`).toBeGreaterThanOrEqual(
					previous - 1e-9,
				);
				previous = distance;
			}
		}
	});

	test("moves nothing at zero, at either end of the range", () => {
		expect(liftHex("#1e2127", 0)).toBe("#1e2127");
		expect(liftHex("#f7f7f8", 0)).toBe("#f7f7f8");
	});
});
