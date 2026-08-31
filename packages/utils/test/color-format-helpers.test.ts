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
import {
	formatAge,
	formatBytes,
	formatClock,
	formatCount,
	formatDuration,
	formatMoreLines,
	formatNumber,
	formatPercent,
	pluralize,
	truncate,
} from "../src/format";

describe("hexToRgb", () => {
	it("parses 6-digit hex", () => {
		expect(hexToRgb("#ff8800")).toEqual({ r: 255, g: 136, b: 0 });
	});

	it("parses hex without #", () => {
		expect(hexToRgb("ff8800")).toEqual({ r: 255, g: 136, b: 0 });
	});

	it("parses 3-digit hex", () => {
		expect(hexToRgb("#f80")).toEqual({ r: 255, g: 136, b: 0 });
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
		expect(rgbToHex({ r: 255, g: 136, b: 0 })).toBe("#ff8800");
	});

	it("converts black", () => {
		expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
	});

	it("converts white", () => {
		expect(rgbToHex({ r: 255, g: 255, b: 255 })).toBe("#ffffff");
	});

	it("clamps out-of-range values", () => {
		expect(rgbToHex({ r: 300, g: -50, b: 128 })).toBe("#ff0080");
	});
});

describe("rgbToHsv", () => {
	it("converts red", () => {
		const hsv = rgbToHsv({ r: 255, g: 0, b: 0 });
		expect(hsv.h).toBeCloseTo(0);
		expect(hsv.s).toBeCloseTo(1);
		expect(hsv.v).toBeCloseTo(1);
	});

	it("converts green", () => {
		const hsv = rgbToHsv({ r: 0, g: 255, b: 0 });
		expect(hsv.h).toBeCloseTo(120);
	});

	it("converts blue", () => {
		const hsv = rgbToHsv({ r: 0, g: 0, b: 255 });
		expect(hsv.h).toBeCloseTo(240);
	});

	it("converts black", () => {
		const hsv = rgbToHsv({ r: 0, g: 0, b: 0 });
		expect(hsv.s).toBe(0);
		expect(hsv.v).toBe(0);
	});

	it("converts white", () => {
		const hsv = rgbToHsv({ r: 255, g: 255, b: 255 });
		expect(hsv.s).toBe(0);
		expect(hsv.v).toBeCloseTo(1);
	});
});

describe("hsvToRgb", () => {
	it("converts red HSV", () => {
		expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
	});

	it("converts green HSV", () => {
		expect(hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 0 });
	});
	it("normalizes negative hue", () => {
		const result = hsvToRgb({ h: -120, s: 1, v: 1 });
		expect(result).toEqual({ r: 0, g: 0, b: 255 }); // -120 + 360 = 240 = blue
	});

	it("normalizes hue > 360", () => {
		const result = hsvToRgb({ h: 480, s: 1, v: 1 });
		expect(result).toEqual({ r: 0, g: 255, b: 0 });
	});

	it("converts white HSV", () => {
		expect(hsvToRgb({ h: 0, s: 0, v: 1 })).toEqual({ r: 255, g: 255, b: 255 });
	});

	it("converts black HSV", () => {
		expect(hsvToRgb({ h: 0, s: 1, v: 0 })).toEqual({ r: 0, g: 0, b: 0 });
	});
});

describe("hexToHsv", () => {
	it("converts hex to HSV", () => {
		const hsv = hexToHsv("#ff0000");
		expect(hsv.h).toBeCloseTo(0);
		expect(hsv.s).toBeCloseTo(1);
	});
});

describe("hsvToHex", () => {
	it("converts HSV to hex", () => {
		expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe("#ff0000");
	});
});

describe("shiftHue", () => {
	it("shifts hue by 120 degrees", () => {
		expect(shiftHue("#ff0000", 120)).toBe("#00ff00");
	});

	it("shifts hue by 240 degrees", () => {
		expect(shiftHue("#ff0000", 240)).toBe("#0000ff");
	});

	it("handles negative shift", () => {
		const result = shiftHue("#00ff00", -120);
		expect(result).toBe("#ff0000");
	});

	it("full rotation returns same color", () => {
		expect(shiftHue("#ff8800", 360)).toBe("#ff8800");
	});
});

describe("adjustHsv", () => {
	it("adjusts hue", () => {
		expect(adjustHsv("#ff0000", { h: 120 })).toBe("#00ff00");
	});

	it("adjusts saturation", () => {
		const result = adjustHsv("#ff0000", { s: 0.5 });
		expect(result).toBeDefined();
	});

	it("adjusts value", () => {
		const result = adjustHsv("#ff0000", { v: 0.5 });
		expect(result).toBeDefined();
	});

	it("adjusts all components", () => {
		const result = adjustHsv("#ff0000", { h: 120, s: 0.5, v: 0.5 });
		expect(result).toBeDefined();
	});

	it("handles no adjustments", () => {
		expect(adjustHsv("#ff0000", {})).toBe("#ff0000");
	});
});

describe("hslToHex", () => {
	it("converts red HSL", () => {
		expect(hslToHex(0, 1, 0.5)).toBe("#ff0000");
	});

	it("converts green HSL", () => {
		expect(hslToHex(120, 1, 0.5)).toBe("#00ff00");
	});

	it("converts blue HSL", () => {
		expect(hslToHex(240, 1, 0.5)).toBe("#0000ff");
	});

	it("converts white HSL", () => {
		expect(hslToHex(0, 0, 1)).toBe("#ffffff");
	});

	it("converts black HSL", () => {
		expect(hslToHex(0, 0, 0)).toBe("#000000");
	});
});

describe("colorLuma", () => {
	it("returns luma for hex color", () => {
		const luma = colorLuma("#ffffff");
		expect(luma).toBeDefined();
		expect(typeof luma).toBe("number");
	});

	it("returns luma for black", () => {
		const luma = colorLuma("#000000");
		expect(luma).toBeCloseTo(0);
	});

	it("returns luma for white", () => {
		const luma = colorLuma("#ffffff");
		expect(luma).toBeCloseTo(1, 1);
	});
});

describe("relativeLuminance", () => {
	it("returns luminance for hex color", () => {
		const lum = relativeLuminance("#ffffff");
		expect(lum).toBeDefined();
		expect(typeof lum).toBe("number");
	});

	it("returns 0 for black", () => {
		expect(relativeLuminance("#000000")).toBeCloseTo(0);
	});

	it("returns 1 for white", () => {
		expect(relativeLuminance("#ffffff")).toBeCloseTo(1, 1);
	});
});

describe("formatDuration", () => {
	it("formats milliseconds", () => {
		expect(formatDuration(500)).toBe("500ms");
	});

	it("formats seconds", () => {
		expect(formatDuration(1500)).toBe("1.5s");
	});

	it("formats minutes", () => {
		expect(formatDuration(90000)).toBe("1m30s");
	});

	it("formats hours", () => {
		expect(formatDuration(5400000)).toBe("1h30m");
	});

	it("formats days", () => {
		expect(formatDuration(86400000)).toBe("1d");
	});

	it("formats days with hours", () => {
		expect(formatDuration(90000000)).toBe("1d1h");
	});

	it("returns 0ms for zero", () => {
		expect(formatDuration(0)).toBe("0ms");
	});

	it("returns 0ms for negative", () => {
		expect(formatDuration(-100)).toBe("0ms");
	});

	it("returns 0ms for NaN", () => {
		expect(formatDuration(NaN)).toBe("0ms");
	});

	it("returns 0ms for Infinity", () => {
		expect(formatDuration(Infinity)).toBe("0ms");
	});
});

describe("formatClock", () => {
	it("formats seconds only", () => {
		expect(formatClock(30000)).toBe("0:30");
	});

	it("formats minutes and seconds", () => {
		expect(formatClock(90000)).toBe("1:30");
	});

	it("formats hours minutes seconds", () => {
		expect(formatClock(3661000)).toBe("1:01:01");
	});

	it("formats zero", () => {
		expect(formatClock(0)).toBe("0:00");
	});

	it("handles NaN", () => {
		expect(formatClock(NaN)).toBe("0:00");
	});

	it("handles negative", () => {
		expect(formatClock(-1000)).toBe("0:00");
	});
});

describe("formatNumber", () => {
	it("formats numbers < 1000", () => {
		expect(formatNumber(999)).toBe("999");
	});

	it("formats thousands", () => {
		expect(formatNumber(1500)).toBe("1.5K");
	});

	it("formats ten thousands", () => {
		expect(formatNumber(15000)).toBe("15K");
	});

	it("formats millions", () => {
		expect(formatNumber(1500000)).toBe("1.5M");
	});

	it("formats billions", () => {
		expect(formatNumber(1500000000)).toBe("1.5B");
	});

	it("formats 0", () => {
		expect(formatNumber(0)).toBe("0");
	});

	it("formats NaN", () => {
		expect(formatNumber(NaN)).toBe("0");
	});

	it("formats Infinity", () => {
		expect(formatNumber(Infinity)).toBe("0");
	});

	it("trims .0 from output", () => {
		expect(formatNumber(2000)).toBe("2K");
	});
});

describe("truncate", () => {
	it("returns string unchanged when within limit", () => {
		expect(truncate("hello", 10)).toBe("hello");
	});

	it("truncates with ellipsis", () => {
		expect(truncate("hello world", 8)).toBe("hello w…");
	});

	it("uses custom ellipsis", () => {
		expect(truncate("hello world", 8, "...")).toBe("hello...");
	});

	it("handles exact length", () => {
		expect(truncate("hello", 5)).toBe("hello");
	});

	it("handles empty string", () => {
		expect(truncate("", 5)).toBe("");
	});

	it("handles emoji correctly", () => {
		expect(truncate("😀😀😀😀", 2)).toBe("😀…");
	});
});

describe("formatBytes", () => {
	it("formats bytes", () => {
		expect(formatBytes(512)).toBe("512B");
	});

	it("formats kilobytes", () => {
		expect(formatBytes(1536)).toBe("1.5KB");
	});

	it("formats megabytes", () => {
		expect(formatBytes(1048576)).toBe("1.0MB");
	});

	it("formats gigabytes", () => {
		expect(formatBytes(1073741824)).toBe("1.0GB");
	});

	it("formats 0 bytes", () => {
		expect(formatBytes(0)).toBe("0B");
	});

	it("formats NaN", () => {
		expect(formatBytes(NaN)).toBe("0B");
	});
});

describe("pluralize", () => {
	it("returns singular for count 1", () => {
		expect(pluralize("item", 1)).toBe("item");
	});

	it("adds s for regular plural", () => {
		expect(pluralize("item", 2)).toBe("items");
	});

	it("adds es for words ending in ch", () => {
		expect(pluralize("match", 2)).toBe("matches");
	});

	it("adds es for words ending in sh", () => {
		expect(pluralize("brush", 2)).toBe("brushes");
	});

	it("adds es for words ending in s", () => {
		expect(pluralize("class", 2)).toBe("classes");
	});

	it("adds es for words ending in x", () => {
		expect(pluralize("box", 2)).toBe("boxes");
	});

	it("adds es for words ending in z", () => {
		expect(pluralize("buzz", 2)).toBe("buzzes");
	});

	it("changes y to ies for consonant+y", () => {
		expect(pluralize("entry", 2)).toBe("entries");
	});

	it("keeps y for vowel+y", () => {
		expect(pluralize("day", 2)).toBe("days");
	});
});

describe("formatCount", () => {
	it("formats singular", () => {
		expect(formatCount("item", 1)).toBe("1 item");
	});

	it("formats plural", () => {
		expect(formatCount("item", 5)).toBe("5 items");
	});

	it("handles NaN", () => {
		expect(formatCount("item", NaN)).toBe("0 items");
	});

	it("handles Infinity", () => {
		expect(formatCount("item", Infinity)).toBe("0 items");
	});
});

describe("formatAge", () => {
	it("returns empty for null", () => {
		expect(formatAge(null)).toBe("");
	});

	it("returns empty for undefined", () => {
		expect(formatAge(undefined)).toBe("");
	});

	it("returns empty for zero", () => {
		expect(formatAge(0)).toBe("");
	});

	it("returns empty for negative", () => {
		expect(formatAge(-10)).toBe("");
	});

	it("returns just now for < 60 seconds", () => {
		expect(formatAge(30)).toBe("just now");
	});

	it("returns minutes", () => {
		expect(formatAge(120)).toBe("2m ago");
	});

	it("returns hours", () => {
		expect(formatAge(7200)).toBe("2h ago");
	});

	it("returns days", () => {
		expect(formatAge(172800)).toBe("2d ago");
	});

	it("returns weeks", () => {
		expect(formatAge(1209600)).toBe("2w ago");
	});

	it("returns months", () => {
		expect(formatAge(5184000)).toBe("2mo ago");
	});
});

describe("formatMoreLines", () => {
	it("formats singular", () => {
		expect(formatMoreLines(1)).toBe("1 more line");
	});

	it("formats plural", () => {
		expect(formatMoreLines(5)).toBe("5 more lines");
	});
});

describe("formatPercent", () => {
	it("formats ratio as percent", () => {
		expect(formatPercent(0.5)).toBe("50.0%");
	});

	it("formats 0", () => {
		expect(formatPercent(0)).toBe("0.0%");
	});

	it("formats 1", () => {
		expect(formatPercent(1)).toBe("100.0%");
	});

	it("formats NaN", () => {
		expect(formatPercent(NaN)).toBe("0.0%");
	});

	it("formats Infinity", () => {
		expect(formatPercent(Infinity)).toBe("0.0%");
	});
});
