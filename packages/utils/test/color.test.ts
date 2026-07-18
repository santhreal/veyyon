import { describe, expect, it } from "bun:test";
import {
	adjustHsv,
	colorLuma,
	hexToHsv,
	hexToRgb,
	hslToHex,
	hsvToHex,
	hsvToRgb,
	relativeLuminance,
	rgbToHex,
	rgbToHsv,
	shiftHue,
} from "@veyyon/utils/color";

describe("relativeLuminance (WCAG, linearized sRGB)", () => {
	it("hits the extremes", () => {
		expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 5);
	});

	it("linearizes — mid-gray is WCAG-dark (~0.21), not 0.5", () => {
		// #808080 is perceptually mid (luma ~0.5) but WCAG-dark once linearized.
		expect(relativeLuminance("#808080") ?? 1).toBeLessThan(0.25);
		expect(colorLuma("#808080") ?? 0).toBeGreaterThan(0.45);
	});

	it("accepts #rgb shorthand and palette indices", () => {
		expect(relativeLuminance("#fff")).toBe(relativeLuminance("#ffffff"));
		expect(relativeLuminance(15)).toBeGreaterThan(0.9); // white
		expect(relativeLuminance(0)).toBeCloseTo(0, 5); // black
	});

	it("returns undefined for malformed / var-ref input", () => {
		expect(relativeLuminance("primary")).toBeUndefined();
		expect(relativeLuminance("#ff")).toBeUndefined();
		expect(relativeLuminance(256)).toBeUndefined();
	});
});

describe("colorLuma (perceptual classification)", () => {
	it("parses hex, shorthand, and palette indices", () => {
		expect(colorLuma("#000000")).toBeCloseTo(0, 5);
		expect(colorLuma("#ffffff")).toBeCloseTo(1, 5);
		expect(colorLuma("#fff")).toBe(colorLuma("#ffffff"));
		expect(colorLuma(15)).toBeGreaterThan(0.9);
	});

	it("returns undefined for malformed input", () => {
		expect(colorLuma("nope")).toBeUndefined();
		expect(colorLuma(-1)).toBeUndefined();
	});
});

describe("hex/RGB conversion", () => {
	it("parses #RRGGBB, #RGB shorthand, and bare hex", () => {
		expect(hexToRgb("#4ade80")).toEqual({ r: 0x4a, g: 0xde, b: 0x80 });
		expect(hexToRgb("#fa3")).toEqual({ r: 0xff, g: 0xaa, b: 0x33 });
		expect(hexToRgb("4ade80")).toEqual({ r: 0x4a, g: 0xde, b: 0x80 });
	});

	it("rgbToHex clamps and rounds out-of-range channels", () => {
		expect(rgbToHex({ r: 74, g: 222, b: 128 })).toBe("#4ade80");
		expect(rgbToHex({ r: -5, g: 300, b: 127.6 })).toBe("#00ff80");
	});
});

describe("HSV conversion", () => {
	it("maps primaries to their hue angles", () => {
		expect(rgbToHsv({ r: 255, g: 0, b: 0 })).toEqual({ h: 0, s: 1, v: 1 });
		expect(rgbToHsv({ r: 0, g: 255, b: 0 })).toEqual({ h: 120, s: 1, v: 1 });
		expect(rgbToHsv({ r: 0, g: 0, b: 255 })).toEqual({ h: 240, s: 1, v: 1 });
		expect(rgbToHsv({ r: 0, g: 0, b: 0 })).toEqual({ h: 0, s: 0, v: 0 });
	});

	it("hsvToRgb covers every 60-degree sextant", () => {
		expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
		expect(hsvToRgb({ h: 60, s: 1, v: 1 })).toEqual({ r: 255, g: 255, b: 0 });
		expect(hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 0 });
		expect(hsvToRgb({ h: 180, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 255 });
		expect(hsvToRgb({ h: 240, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
		expect(hsvToRgb({ h: 300, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 255 });
	});

	it("normalizes out-of-range hues, including negatives", () => {
		expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual(hsvToRgb({ h: 0, s: 1, v: 1 }));
		expect(hsvToRgb({ h: -120, s: 1, v: 1 })).toEqual(hsvToRgb({ h: 240, s: 1, v: 1 }));
	});

	it("round-trips hex -> HSV -> hex exactly for representable colors", () => {
		for (const hex of ["#4ade80", "#ff0000", "#00ff88", "#123456", "#c0ffee"]) {
			expect(hsvToHex(hexToHsv(hex))).toBe(hex);
		}
	});
});

describe("hue shifting and adjustment", () => {
	it("shiftHue rotates around the wheel and wraps negatives", () => {
		expect(shiftHue("#ff0000", 120)).toBe("#00ff00");
		expect(shiftHue("#ff0000", -120)).toBe("#0000ff");
		expect(shiftHue("#4ade80", 360)).toBe("#4ade80");
	});

	it("adjustHsv shifts hue additively and scales s/v with clamping", () => {
		expect(adjustHsv("#ff0000", { h: 120 })).toBe("#00ff00");
		expect(adjustHsv("#ff0000", { s: 0 })).toBe("#ffffff");
		expect(adjustHsv("#ff0000", { v: 0.5 })).toBe("#800000");
		expect(adjustHsv("#ff0000", { s: 99, v: 99 })).toBe("#ff0000"); // clamped to 1
		expect(adjustHsv("#00ff00", { h: -120 })).toBe("#ff0000"); // negative wrap
	});
});

describe("256-color palette parsing", () => {
	it("maps color-cube indices to their step values", () => {
		// index 196 = 16 + 36*5 = pure red column of the cube
		expect(colorLuma(196)).toBeCloseTo((0.2126 * 255) / 255, 5);
		// index 16 is cube black, index 231 is cube white
		expect(colorLuma(16)).toBeCloseTo(0, 5);
		expect(colorLuma(231)).toBeCloseTo(1, 5);
	});

	it("maps grayscale-ramp indices linearly from 8 to 238", () => {
		expect(colorLuma(232)).toBeCloseTo(8 / 255, 5);
		expect(colorLuma(255)).toBeCloseTo(238 / 255, 5);
	});
});

describe("hslToHex", () => {
	it("maps primary hues at full saturation/half lightness", () => {
		expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
		expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
		expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
	});

	it("collapses to grayscale at zero saturation", () => {
		expect(hslToHex(0, 0, 0)).toBe("#000000");
		expect(hslToHex(210, 0, 1)).toBe("#ffffff");
	});
});
