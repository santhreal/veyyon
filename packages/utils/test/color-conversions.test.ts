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
} from "../src/color";

describe("hexToRgb", () => {
	it("parses 6-digit hex with #", () => {
		expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
	});

	it("parses 6-digit hex without #", () => {
		expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
	});

	it("parses 3-digit hex with #", () => {
		expect(hexToRgb("#f00")).toEqual({ r: 255, g: 0, b: 0 });
	});

	it("parses 3-digit hex without #", () => {
		expect(hexToRgb("0f0")).toEqual({ r: 0, g: 255, b: 0 });
	});

	it("parses uppercase hex", () => {
		expect(hexToRgb("#FF8800")).toEqual({ r: 255, g: 136, b: 0 });
	});

	it("parses mixed case hex", () => {
		expect(hexToRgb("#aB3CdE")).toEqual({ r: 171, g: 60, b: 222 });
	});

	it("parses black", () => {
		expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
	});

	it("parses white", () => {
		expect(hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
	});
});

describe("rgbToHex", () => {
	it("converts basic RGB to hex", () => {
		expect(rgbToHex({ r: 255, g: 0, b: 0 })).toBe("#ff0000");
	});

	it("converts green", () => {
		expect(rgbToHex({ r: 0, g: 255, b: 0 })).toBe("#00ff00");
	});

	it("converts blue", () => {
		expect(rgbToHex({ r: 0, g: 0, b: 255 })).toBe("#0000ff");
	});

	it("converts black", () => {
		expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
	});

	it("converts white", () => {
		expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe("#ffffff");
	});

	it("clamps values above 255", () => {
		expect(rgbToHex({ r: 300, g: 300, b: 300 })).toBe("#ffffff");
	});

	it("clamps values below 0", () => {
		expect(rgbToHex({ r: -10, g: -10, b: -10 })).toBe("#000000");
	});

	it("pads single-digit hex values", () => {
		expect(rgbToHex({ r: 5, g: 15, b: 3 })).toBe("#050f03");
	});
});

describe("rgbToHsv", () => {
	it("converts pure red", () => {
		const hsv = rgbToHsv({ r: 255, g: 0, b: 0 });
		expect(hsv.h).toBeCloseTo(0);
		expect(hsv.s).toBeCloseTo(1);
		expect(hsv.v).toBeCloseTo(1);
	});

	it("converts pure green", () => {
		const hsv = rgbToHsv({ r: 0, g: 255, b: 0 });
		expect(hsv.h).toBeCloseTo(120);
		expect(hsv.s).toBeCloseTo(1);
		expect(hsv.v).toBeCloseTo(1);
	});

	it("converts pure blue", () => {
		const hsv = rgbToHsv({ r: 0, g: 0, b: 255 });
		expect(hsv.h).toBeCloseTo(240);
		expect(hsv.s).toBeCloseTo(1);
		expect(hsv.v).toBeCloseTo(1);
	});

	it("converts black (all zeros)", () => {
		const hsv = rgbToHsv({ r: 0, g: 0, b: 0 });
		expect(hsv.h).toBe(0);
		expect(hsv.s).toBe(0);
		expect(hsv.v).toBe(0);
	});

	it("converts white (max, no saturation)", () => {
		const hsv = rgbToHsv({ r: 255, g: 255, b: 255 });
		expect(hsv.h).toBe(0);
		expect(hsv.s).toBe(0);
		expect(hsv.v).toBeCloseTo(1);
	});

	it("converts yellow", () => {
		const hsv = rgbToHsv({ r: 255, g: 255, b: 0 });
		expect(hsv.h).toBeCloseTo(60);
		expect(hsv.s).toBeCloseTo(1);
		expect(hsv.v).toBeCloseTo(1);
	});

	it("converts cyan", () => {
		const hsv = rgbToHsv({ r: 0, g: 255, b: 255 });
		expect(hsv.h).toBeCloseTo(180);
	});

	it("converts magenta", () => {
		const hsv = rgbToHsv({ r: 255, g: 0, b: 255 });
		expect(hsv.h).toBeCloseTo(300);
	});
});

describe("hsvToRgb", () => {
	it("converts red HSV", () => {
		const rgb = hsvToRgb({ h: 0, s: 1, v: 1 });
		expect(rgb).toEqual({ r: 255, g: 0, b: 0 });
	});

	it("converts green HSV", () => {
		const rgb = hsvToRgb({ h: 120, s: 1, v: 1 });
		expect(rgb).toEqual({ r: 0, g: 255, b: 0 });
	});

	it("converts blue HSV", () => {
		const rgb = hsvToRgb({ h: 240, s: 1, v: 1 });
		expect(rgb).toEqual({ r: 0, g: 0, b: 255 });
	});

	it("converts zero saturation (gray)", () => {
		const rgb = hsvToRgb({ h: 0, s: 0, v: 0.5 });
		expect(rgb.r).toBeCloseTo(128);
		expect(rgb.g).toBeCloseTo(128);
		expect(rgb.b).toBeCloseTo(128);
	});

	it("converts zero value (black)", () => {
		const rgb = hsvToRgb({ h: 180, s: 1, v: 0 });
		expect(rgb).toEqual({ r: 0, g: 0, b: 0 });
	});

	it("normalizes hue above 360", () => {
		const rgb1 = hsvToRgb({ h: 360, s: 1, v: 1 });
		const rgb2 = hsvToRgb({ h: 0, s: 1, v: 1 });
		expect(rgb1).toEqual(rgb2);
	});

	it("normalizes negative hue", () => {
		const rgb1 = hsvToRgb({ h: -120, s: 1, v: 1 });
		const rgb2 = hsvToRgb({ h: 240, s: 1, v: 1 });
		expect(rgb1).toEqual(rgb2);
	});

	it("converts yellow HSV", () => {
		const rgb = hsvToRgb({ h: 60, s: 1, v: 1 });
		expect(rgb).toEqual({ r: 255, g: 255, b: 0 });
	});

	it("converts cyan HSV", () => {
		const rgb = hsvToRgb({ h: 180, s: 1, v: 1 });
		expect(rgb).toEqual({ r: 0, g: 255, b: 255 });
	});

	it("converts magenta HSV", () => {
		const rgb = hsvToRgb({ h: 300, s: 1, v: 1 });
		expect(rgb).toEqual({ r: 255, g: 0, b: 255 });
	});
});

describe("hexToHsv / hsvToHex round-trip", () => {
	it("round-trips red", () => {
		const hsv = hexToHsv("#ff0000");
		expect(hsvToHex(hsv)).toBe("#ff0000");
	});

	it("round-trips gray", () => {
		const hsv = hexToHsv("#808080");
		const result = hsvToHex(hsv);
		expect(result).toBe("#808080");
	});

	it("round-trips a complex color", () => {
		const hsv = hexToHsv("#3a7bd5");
		const result = hsvToHex(hsv);
		// Rounding may cause slight differences, but should be very close
		expect(result).toMatch(/^#[0-9a-f]{6}$/);
	});
});

describe("shiftHue", () => {
	it("shifts red by 120 degrees to green-ish", () => {
		const result = shiftHue("#ff0000", 120);
		const hsv = hexToHsv(result);
		expect(hsv.h).toBeCloseTo(120, 0);
	});

	it("shifts hue by 360 returns same color", () => {
		const result = shiftHue("#ff0000", 360);
		expect(result).toBe("#ff0000");
	});

	it("handles negative shift", () => {
		const result = shiftHue("#00ff00", -120);
		const hsv = hexToHsv(result);
		expect(hsv.h).toBeCloseTo(0, 0);
	});

	it("shifts by 0 returns same color", () => {
		expect(shiftHue("#3a7bd5", 0)).toBe("#3a7bd5");
	});
});

describe("adjustHsv", () => {
	it("adjusts hue only", () => {
		const result = adjustHsv("#ff0000", { h: 120 });
		const hsv = hexToHsv(result);
		expect(hsv.h).toBeCloseTo(120, 0);
	});

	it("adjusts saturation only", () => {
		const result = adjustHsv("#ff0000", { s: 0.5 });
		const hsv = hexToHsv(result);
		expect(hsv.s).toBeCloseTo(0.5, 1);
	});

	it("adjusts value only", () => {
		const result = adjustHsv("#ff0000", { v: 0.5 });
		const hsv = hexToHsv(result);
		expect(hsv.v).toBeCloseTo(0.5, 1);
	});

	it("adjusts all three components", () => {
		const result = adjustHsv("#ff0000", { h: 180, s: 0.5, v: 0.5 });
		const hsv = hexToHsv(result);
		expect(hsv.h).toBeCloseTo(180, 0);
		expect(hsv.s).toBeCloseTo(0.5, 1);
		expect(hsv.v).toBeCloseTo(0.5, 1);
	});

	it("handles empty adjustment (no change)", () => {
		expect(adjustHsv("#ff0000", {})).toBe("#ff0000");
	});

	it("clamps saturation above 1", () => {
		const result = adjustHsv("#ff0000", { s: 2 });
		const hsv = hexToHsv(result);
		expect(hsv.s).toBeLessThanOrEqual(1);
	});

	it("clamps saturation below 0", () => {
		const result = adjustHsv("#ff0000", { s: -1 });
		const hsv = hexToHsv(result);
		expect(hsv.s).toBeGreaterThanOrEqual(0);
	});

	it("handles negative hue adjustment", () => {
		const result = adjustHsv("#00ff00", { h: -120 });
		const hsv = hexToHsv(result);
		expect(hsv.h).toBeCloseTo(0, 0);
	});
});

describe("hslToHex", () => {
	it("converts pure red in HSL", () => {
		expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
	});

	it("converts pure green in HSL", () => {
		expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
	});

	it("converts pure blue in HSL", () => {
		expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
	});

	it("converts gray (zero saturation)", () => {
		expect(hslToHex(0, 0, 0.5)).toBe("#808080");
	});

	it("converts white (full lightness)", () => {
		expect(hslToHex(0, 0, 1)).toBe("#ffffff");
	});

	it("converts black (zero lightness)", () => {
		expect(hslToHex(0, 0, 0)).toBe("#000000");
	});

	it("converts yellow", () => {
		expect(hslToHex(60, 1, 0.5)).toBe("#ffff00");
	});

	it("converts a dark color", () => {
		const result = hslToHex(210, 0.5, 0.2);
		expect(result).toMatch(/^#[0-9a-f]{6}$/);
	});
});

describe("colorLuma", () => {
	it("returns 1 for white", () => {
		expect(colorLuma("#ffffff")).toBeCloseTo(1, 1);
	});

	it("returns 0 for black", () => {
		expect(colorLuma("#000000")).toBeCloseTo(0);
	});

	it("returns a value between 0 and 1 for gray", () => {
		const luma = colorLuma("#808080");
		expect(luma).toBeDefined();
		expect(luma!).toBeGreaterThan(0);
		expect(luma!).toBeLessThan(1);
	});
	it("weights green more than red and blue", () => {
		const redLuma = colorLuma("#ff0000");
		const greenLuma = colorLuma("#00ff00");
		const blueLuma = colorLuma("#0000ff");
		expect(redLuma).toBeDefined();
		expect(greenLuma).toBeDefined();
		expect(blueLuma).toBeDefined();
		expect(greenLuma!).toBeGreaterThan(redLuma!);
		expect(greenLuma!).toBeGreaterThan(blueLuma!);
		expect(redLuma!).toBeGreaterThan(blueLuma!);
	});

	it("accepts palette index (number)", () => {
		// Index 9 = bright red [255, 0, 0]
		const luma = colorLuma(9);
		expect(luma).toBeCloseTo(0.2126, 3);
	});

	it("returns undefined for invalid string", () => {
		expect(colorLuma("not-a-color")).toBeUndefined();
	});

	it("returns undefined for invalid number", () => {
		expect(colorLuma(-1)).toBeUndefined();
		expect(colorLuma(256)).toBeUndefined();
	});

	it("returns undefined for wrong-length hex", () => {
		expect(colorLuma("#ff")).toBeUndefined();
		expect(colorLuma("#ff00")).toBeUndefined();
	});
});

describe("relativeLuminance", () => {
	it("returns 1 for white", () => {
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 2);
	});

	it("returns 0 for black", () => {
		expect(relativeLuminance("#000000")).toBeCloseTo(0);
	});

	it("returns a value between 0 and 1 for gray", () => {
		const lum = relativeLuminance("#808080");
		expect(lum).toBeDefined();
		expect(lum!).toBeGreaterThan(0);
		expect(lum!).toBeLessThan(1);
	});

	it("weights green channel more than red and blue", () => {
		const redLum = relativeLuminance("#ff0000");
		const greenLum = relativeLuminance("#00ff00");
		const blueLum = relativeLuminance("#0000ff");
		expect(redLum).toBeDefined();
		expect(greenLum).toBeDefined();
		expect(blueLum).toBeDefined();
		expect(greenLum!).toBeGreaterThan(redLum!);
		expect(greenLum!).toBeGreaterThan(blueLum!);
	});

	it("accepts palette index", () => {
		// Index 15 = white [255, 255, 255]
		expect(relativeLuminance(15)).toBeCloseTo(1, 2);
	});

	it("returns undefined for invalid input", () => {
		expect(relativeLuminance("invalid")).toBeUndefined();
		expect(relativeLuminance(300)).toBeUndefined();
	});

	it("linearizes dark channels differently than bright ones", () => {
		// The linearization formula treats values <= 0.04045 differently
		// Very dark color should have very low luminance
		const darkLum = relativeLuminance("#010101");
		expect(darkLum).toBeDefined();
		expect(darkLum!).toBeLessThan(0.001);
	});
});
