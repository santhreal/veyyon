import { describe, expect, test } from "bun:test";
import {
	colorDistance,
	OSC11_RESET_BACKGROUND_SEQUENCE,
	osc11SetBackgroundSequence,
	oscChannelTo8Bit,
	PAINT_GROUND_AUTO_TOLERANCE,
	parseHexColor,
	planPaintGround,
	resolvePaintGround,
} from "../src/paint-ground";

describe("parseHexColor", () => {
	test("parses #RRGGBB into channels", () => {
		expect(parseHexColor("#000000")).toEqual({ r: 0, g: 0, b: 0 });
		expect(parseHexColor("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
		expect(parseHexColor("#F0862E")).toEqual({ r: 240, g: 134, b: 46 });
	});

	test("fails closed on anything that is not #RRGGBB", () => {
		expect(parseHexColor("000000")).toBeNull();
		expect(parseHexColor("#fff")).toBeNull();
		expect(parseHexColor("#00000000")).toBeNull();
		expect(parseHexColor("#GGGGGG")).toBeNull();
		expect(parseHexColor("")).toBeNull();
		expect(parseHexColor("rgb:00/00/00")).toBeNull();
	});
});

describe("oscChannelTo8Bit", () => {
	test("passes 2-digit channels through", () => {
		expect(oscChannelTo8Bit("00")).toBe(0);
		expect(oscChannelTo8Bit("ff")).toBe(255);
		expect(oscChannelTo8Bit("1e")).toBe(30);
	});

	test("scales 4-digit channels by 16-bit maximum", () => {
		expect(oscChannelTo8Bit("ffff")).toBe(255);
		expect(oscChannelTo8Bit("0000")).toBe(0);
		// 0x1e1e / 0xffff * 255 = 30.0 — the doubled-byte convention round-trips.
		expect(oscChannelTo8Bit("1e1e")).toBe(30);
		expect(oscChannelTo8Bit("8080")).toBe(128);
	});

	test("scales 1-digit channels by 4-bit maximum", () => {
		expect(oscChannelTo8Bit("f")).toBe(255);
		expect(oscChannelTo8Bit("8")).toBe(136);
		expect(oscChannelTo8Bit("0")).toBe(0);
	});

	test("returns 0 on non-hex input", () => {
		expect(oscChannelTo8Bit("zz")).toBe(0);
		expect(oscChannelTo8Bit("")).toBe(0);
	});
});

describe("colorDistance", () => {
	test("identical colors are 0 apart", () => {
		expect(colorDistance("#000000", "#000000")).toBe(0);
		expect(colorDistance("#C6CBD4", "#c6cbd4")).toBe(0);
	});

	test("black to white is the diagonal", () => {
		expect(colorDistance("#000000", "#ffffff")).toBeCloseTo(Math.sqrt(3 * 255 ** 2), 5);
	});

	test("Dracula ground vs black exceeds the auto tolerance", () => {
		expect(colorDistance("#000000", "#282A36")).toBeGreaterThan(PAINT_GROUND_AUTO_TOLERANCE);
	});

	test("near-black variation sits inside the auto tolerance", () => {
		expect(colorDistance("#000000", "#0E0E10")).toBeLessThanOrEqual(PAINT_GROUND_AUTO_TOLERANCE);
	});

	test("unparsable input yields Infinity", () => {
		expect(colorDistance("#000000", "nope")).toBe(Number.POSITIVE_INFINITY);
		expect(colorDistance("nope", "#000000")).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("resolvePaintGround", () => {
	test("always paints regardless of terminal report", () => {
		expect(resolvePaintGround("always", "#000000", undefined)).toBe(true);
		expect(resolvePaintGround("always", "#000000", "#FFFFFF")).toBe(true);
	});

	test("never inherits regardless of terminal report", () => {
		expect(resolvePaintGround("never", "#000000", "#000000")).toBe(false);
		expect(resolvePaintGround("never", "#000000", undefined)).toBe(false);
	});

	test("auto with no OSC 11 report inherits", () => {
		expect(resolvePaintGround("auto", "#000000", undefined)).toBe(false);
	});

	test("auto paints on an exact match and near-match", () => {
		expect(resolvePaintGround("auto", "#000000", "#000000")).toBe(true);
		expect(resolvePaintGround("auto", "#000000", "#0E0E10")).toBe(true);
		expect(resolvePaintGround("auto", "#FFFFFF", "#FDFDFD")).toBe(true);
	});

	test("auto refuses when the seam would be visible", () => {
		expect(resolvePaintGround("auto", "#000000", "#282A36")).toBe(false); // Dracula
		expect(resolvePaintGround("auto", "#000000", "#FFFFFF")).toBe(false);
		expect(resolvePaintGround("auto", "#FFFFFF", "#000000")).toBe(false);
	});

	test("auto tolerance boundary is inclusive", () => {
		// Distance exactly PAINT_GROUND_AUTO_TOLERANCE along one axis.
		const boundary = `#${PAINT_GROUND_AUTO_TOLERANCE.toString(16).padStart(2, "0")}0000`;
		expect(colorDistance("#000000", boundary)).toBe(PAINT_GROUND_AUTO_TOLERANCE);
		expect(resolvePaintGround("auto", "#000000", boundary)).toBe(true);
		const beyond = `#${(PAINT_GROUND_AUTO_TOLERANCE + 1).toString(16).padStart(2, "0")}0000`;
		expect(resolvePaintGround("auto", "#000000", beyond)).toBe(false);
	});
});

describe("planPaintGround", () => {
	// The consumer-facing decision: what the interactive-mode wiring does with a
	// theme's ground, the setting, and the terminal background. It exists so the
	// "theme declares no ground" branch — the reason the whole setting was dead
	// until it was wired — is tested without a TUI harness. It must compose
	// resolvePaintGround, never re-derive the auto-seam rule.

	describe("a theme with a declared ground", () => {
		test("paints that exact color when the policy says to", () => {
			// always → the ground is what gets painted, byte for byte.
			expect(planPaintGround("always", "#282A36", "#FFFFFF")).toEqual({
				paint: "#282A36",
				unhonoredAlways: false,
			});
			// auto on a near-match paints the THEME ground, not the terminal's color.
			expect(planPaintGround("auto", "#000000", "#0E0E10")).toEqual({
				paint: "#000000",
				unhonoredAlways: false,
			});
		});

		test("inherits (paint null) when the policy declines, never flagging always", () => {
			expect(planPaintGround("never", "#282A36", "#282A36")).toEqual({ paint: null, unhonoredAlways: false });
			// auto with a visible seam declines: a real ground exists, so this is a
			// policy choice, not an unhonored request.
			expect(planPaintGround("auto", "#000000", "#282A36")).toEqual({ paint: null, unhonoredAlways: false });
			expect(planPaintGround("auto", "#000000", undefined)).toEqual({ paint: null, unhonoredAlways: false });
		});

		test("decides identically to resolvePaintGround for every policy", () => {
			// Locks the composition: plan.paint is non-null exactly when the shared
			// rule says paint, so the auto-seam logic can never fork.
			for (const setting of ["auto", "always", "never"] as const) {
				for (const term of ["#000000", "#282A36", undefined]) {
					const painted = planPaintGround(setting, "#000000", term).paint !== null;
					expect(painted).toBe(resolvePaintGround(setting, "#000000", term));
				}
			}
		});
	});

	describe("a theme with no declared ground", () => {
		test("never paints, because painting would invent a color the theme never chose", () => {
			expect(planPaintGround("auto", undefined, "#000000").paint).toBeNull();
			expect(planPaintGround("never", undefined, "#000000").paint).toBeNull();
			expect(planPaintGround("always", undefined, "#000000").paint).toBeNull();
		});

		test("flags only always as unhonored, so the user hears why nothing painted", () => {
			// always is the one policy the user explicitly asked to paint; auto/never
			// inheriting on a groundless theme is expected and stays quiet (Law 10:
			// surface the surprising case, not the ordinary one).
			expect(planPaintGround("always", undefined, "#000000").unhonoredAlways).toBe(true);
			expect(planPaintGround("auto", undefined, "#000000").unhonoredAlways).toBe(false);
			expect(planPaintGround("never", undefined, "#000000").unhonoredAlways).toBe(false);
		});
	});
});

describe("osc11SetBackgroundSequence", () => {
	test("formats the BEL-terminated OSC 11 set sequence", () => {
		expect(osc11SetBackgroundSequence("#000000")).toBe("\x1b]11;rgb:00/00/00\x07");
		expect(osc11SetBackgroundSequence("#FFFFFF")).toBe("\x1b]11;rgb:ff/ff/ff\x07");
		expect(osc11SetBackgroundSequence("#F0862E")).toBe("\x1b]11;rgb:f0/86/2e\x07");
	});

	test("returns null for unparsable input", () => {
		expect(osc11SetBackgroundSequence("black")).toBeNull();
		expect(osc11SetBackgroundSequence("#fff")).toBeNull();
	});

	test("reset sequence is OSC 111", () => {
		expect(OSC11_RESET_BACKGROUND_SEQUENCE).toBe("\x1b]111\x07");
	});
});
