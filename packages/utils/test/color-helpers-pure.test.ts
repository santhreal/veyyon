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
	it("parses 6-digit hex", () => {
		expect(hexToRgb("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
	});
	it("parses 6-digit hex without #", () => {
		expect(hexToRgb("00ff00")).toEqual({ r: 0, g: 255, b: 0 });
	});
	it("parses 3-digit hex", () => {
		expect(hexToRgb("#f00")).toEqual({ r: 255, g: 0, b: 0 });
	});
	it("parses 3-digit hex without #", () => {
		expect(hexToRgb("0fc")).toEqual({ r: 0, g: 255, b: 204 });
	});
	it("parses black", () => {
		expect(hexToRgb("#000000")).toEqual({ r: 0, g: 0, b: 0 });
	});
	it("parses white", () => {
		expect(hexToRgb("#ffffff")).toEqual({ r: 255, g: 255, b: 255 });
	});
});

describe("rgbToHex", () => {
	it("converts RGB to hex", () => {
		expect(rgbToHex({ r: 255, g: 0, b: 0 })).toBe("#ff0000");
	});
	it("converts black", () => {
		expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
	});
	it("converts white", () => {
		expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe("#ffffff");
	});
	it("clamps values above 255", () => {
		expect(rgbToHex({ r: 300, g: 0, b: 0 })).toBe("#ff0000");
	});
	it("clamps values below 0", () => {
		expect(rgbToHex({ r: -10, g: 0, b: 0 })).toBe("#000000");
	});
	it("pads single-digit hex", () => {
		expect(rgbToHex({ r: 15, g: 15, b: 15 })).toBe("#0f0f0f");
	});
});

describe("rgbToHsv", () => {
	it("converts red", () => {
		const hsv = rgbToHsv({ r: 255, g: 0, b: 0 });
		expect(hsv.h).toBeCloseTo(0, 1);
		expect(hsv.s).toBeCloseTo(1, 5);
		expect(hsv.v).toBeCloseTo(1, 5);
	});
	it("converts green", () => {
		const hsv = rgbToHsv({ r: 0, g: 255, b: 0 });
		expect(hsv.h).toBeCloseTo(120, 1);
		expect(hsv.s).toBeCloseTo(1, 5);
		expect(hsv.v).toBeCloseTo(1, 5);
	});
	it("converts blue", () => {
		const hsv = rgbToHsv({ r: 0, g: 0, b: 255 });
		expect(hsv.h).toBeCloseTo(240, 1);
		expect(hsv.s).toBeCloseTo(1, 5);
		expect(hsv.v).toBeCloseTo(1, 5);
	});
	it("converts black (all zeros)", () => {
		const hsv = rgbToHsv({ r: 0, g: 0, b: 0 });
		expect(hsv.h).toBe(0);
		expect(hsv.s).toBe(0);
		expect(hsv.v).toBe(0);
	});
	it("converts white (no saturation)", () => {
		const hsv = rgbToHsv({ r: 255, g: 255, b: 255 });
		expect(hsv.s).toBe(0);
		expect(hsv.v).toBeCloseTo(1, 5);
	});
});

describe("hsvToRgb", () => {
	it("converts red (h=0)", () => {
		expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
	});
	it("converts green (h=120)", () => {
		expect(hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 0 });
	});
	it("converts blue (h=240)", () => {
		expect(hsvToRgb({ h: 240, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
	});
	it("converts white (s=0)", () => {
		expect(hsvToRgb({ h: 0, s: 0, v: 1 })).toEqual({ r: 255, g: 255, b: 255 });
	});
	it("converts black (v=0)", () => {
		expect(hsvToRgb({ h: 0, s: 1, v: 0 })).toEqual({ r: 0, g: 0, b: 0 });
	});
	it("normalizes hue above 360", () => {
		expect(hsvToRgb({ h: 720, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
	});
	it("normalizes negative hue", () => {
		// -120 mod 360 = 240, which is blue
		expect(hsvToRgb({ h: -120, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
	});
});

describe("hexToHsv / hsvToHex round-trip", () => {
	it("round-trips red", () => {
		expect(hsvToHex(hexToHsv("#ff0000"))).toBe("#ff0000");
	});
	it("round-trips a complex color", () => {
		const hex = "#3a7bd5";
		const result = hsvToHex(hexToHsv(hex));
		expect(result).toBe(hex);
	});
});

describe("shiftHue", () => {
	it("shifts red by 120 degrees to green", () => {
		const result = shiftHue("#ff0000", 120);
		const hsv = hexToHsv(result);
		expect(hsv.h).toBeCloseTo(120, 1);
	});
	it("shifts hue by 360 returns same color", () => {
		expect(shiftHue("#ff0000", 360)).toBe("#ff0000");
	});
	it("handles negative shift", () => {
		const result = shiftHue("#00ff00", -120);
		const hsv = hexToHsv(result);
		expect(hsv.h).toBeCloseTo(0, 1);
	});
});

describe("adjustHsv", () => {
	it("adjusts hue", () => {
		const result = adjustHsv("#ff0000", { h: 120 });
		expect(result).toBe("#00ff00");
	});
	it("adjusts saturation", () => {
		const result = adjustHsv("#ff0000", { s: 0.5 });
		const hsv = hexToHsv(result);
		expect(hsv.s).toBeCloseTo(0.5, 1);
	});
	it("adjusts value", () => {
		const result = adjustHsv("#ff0000", { v: 0.5 });
		const hsv = hexToHsv(result);
		expect(hsv.v).toBeCloseTo(0.5, 1);
	});
	it("adjusts all three", () => {
		const result = adjustHsv("#ff0000", { h: 180, s: 0.5, v: 0.8 });
		const hsv = hexToHsv(result);
		expect(hsv.h).toBeCloseTo(180, 1);
		expect(hsv.s).toBeCloseTo(0.5, 5);
		expect(hsv.v).toBeCloseTo(0.8, 5);
	});
	it("no adjustments returns same color", () => {
		expect(adjustHsv("#ff0000", {})).toBe("#ff0000");
	});
	it("clamps saturation to 1", () => {
		const result = adjustHsv("#ff0000", { s: 2.0 });
		const hsv = hexToHsv(result);
		expect(hsv.s).toBeLessThanOrEqual(1.0);
	});
});

describe("hslToHex", () => {
	it("converts red (h=0, s=1, l=0.5)", () => {
		expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
	});
	it("converts green (h=120, s=1, l=0.5)", () => {
		expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
	});
	it("converts blue (h=240, s=1, l=0.5)", () => {
		expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
	});
	it("converts white (s=0, l=1)", () => {
		expect(hslToHex(0, 0, 1)).toBe("#ffffff");
	});
	it("converts black (l=0)", () => {
		expect(hslToHex(0, 1, 0)).toBe("#000000");
	});
	it("converts gray (s=0, l=0.5)", () => {
		expect(hslToHex(0, 0, 0.5)).toBe("#808080");
	});
});

describe("colorLuma", () => {
	it("returns 1.0 for white", () => {
		expect(colorLuma("#ffffff")).toBeCloseTo(1.0, 5);
	});
	it("returns 0 for black", () => {
		expect(colorLuma("#000000")).toBeCloseTo(0, 5);
	});
	it("returns value for red", () => {
		const luma = colorLuma("#ff0000");
		expect(luma).not.toBeUndefined();
		expect(luma!).toBeCloseTo(0.2126, 4);
	});
	it("returns undefined for invalid string", () => {
		expect(colorLuma("not-a-color")).toBeUndefined();
	});
	it("accepts palette index (number)", () => {
		expect(colorLuma(15)).not.toBeUndefined();
	});
	it("returns undefined for out-of-range index", () => {
		expect(colorLuma(256)).toBeUndefined();
		expect(colorLuma(-1)).toBeUndefined();
	});
});

describe("relativeLuminance", () => {
	it("returns 1.0 for white", () => {
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1.0, 5);
	});
	it("returns 0 for black", () => {
		expect(relativeLuminance("#000000")).toBeCloseTo(0, 5);
	});
	it("returns value for a color", () => {
		const lum = relativeLuminance("#ff0000");
		expect(lum).not.toBeUndefined();
		expect(lum!).toBeGreaterThan(0);
		expect(lum!).toBeLessThan(1);
	});
	it("returns undefined for invalid string", () => {
		expect(relativeLuminance("invalid")).toBeUndefined();
	});
	it("accepts palette index", () => {
		expect(relativeLuminance(0)).toBeCloseTo(0, 5);
	});
});
