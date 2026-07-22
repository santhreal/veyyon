import { describe, expect, it } from "bun:test";
import {
	commas,
	dedupeStrings,
	ensureNumericMetricMap,
	fmtNum,
	formatElapsed,
	formatNum,
	inferMetricUnitFromName,
	isBetter,
	mergeAsi,
	normalizePathSpec,
	parseAsiLines,
	parseMetricLines,
	pathMatchesSpec,
	sanitizeAsi,
} from "@veyyon/coding-agent/autoresearch/helpers";

/**
 * helpers.ts is the pure formatting/parsing layer of the autoresearch loop: it
 * turns experiment stdout (METRIC/ASI lines) into typed maps and renders numbers,
 * elapsed times, and metric units for the operator. It had ZERO tests. These pin
 * the contracts, and specifically lock out BUG-FMTNUM-ROUNDING-CARRY-LOST:
 * fmtNum floored the whole part but rounded the fraction with toFixed separately,
 * so a fraction that carried to 1.00 (1.999, 99.999, 0.999) dropped the carry and
 * printed "1.00" / "99.00" / "0.00". Every non-integer metric near an integer
 * boundary was mis-displayed. fmtNum now rounds once at the target precision.
 */

describe("fmtNum", () => {
	it("does not drop a fractional rounding carry into the whole part (regression)", () => {
		expect(fmtNum(1.999, 2)).toBe("2.00");
		expect(fmtNum(99.999, 2)).toBe("100.00");
		expect(fmtNum(0.999, 2)).toBe("1.00");
		expect(fmtNum(-1.999, 2)).toBe("-2.00");
	});

	it("rounds to the requested decimals and groups the whole part with commas", () => {
		expect(fmtNum(1234.567, 2)).toBe("1,234.57");
		expect(fmtNum(-1234.5, 2)).toBe("-1,234.50");
	});

	it("rounds to a whole number with no decimals when decimals <= 0", () => {
		expect(fmtNum(1.5, 0)).toBe("2");
		expect(fmtNum(1234.4)).toBe("1,234");
	});
});

describe("formatNum", () => {
	it("renders a dash for null", () => {
		expect(formatNum(null, "ms")).toBe("-");
	});

	it("uses no decimals for integers and two for fractions, then appends the unit", () => {
		expect(formatNum(1234, "ms")).toBe("1,234ms");
		expect(formatNum(1.999, "ms")).toBe("2.00ms");
	});
});

describe("commas", () => {
	it("groups digits in threes and preserves the sign", () => {
		expect(commas(0)).toBe("0");
		expect(commas(1234567)).toBe("1,234,567");
		expect(commas(-1234)).toBe("-1,234");
	});
});

describe("formatElapsed", () => {
	it("shows seconds only under a minute and zero-pads seconds past a minute", () => {
		expect(formatElapsed(1000)).toBe("1s");
		expect(formatElapsed(65_000)).toBe("1m 05s");
		expect(formatElapsed(3_661_000)).toBe("61m 01s");
	});
});

describe("inferMetricUnitFromName", () => {
	it("maps a name suffix to its unit, checking microseconds before milliseconds", () => {
		expect(inferMetricUnitFromName("latency_µs")).toBe("µs");
		expect(inferMetricUnitFromName("p50_ms")).toBe("ms");
		expect(inferMetricUnitFromName("elapsed_s")).toBe("s");
		expect(inferMetricUnitFromName("size_kb")).toBe("kb");
		expect(inferMetricUnitFromName("throughput")).toBe("");
	});
});

describe("normalizePathSpec and pathMatchesSpec", () => {
	it("normalizes separators, leading ./, and trailing slashes to a bare spec", () => {
		expect(normalizePathSpec("./foo/")).toBe("foo");
		expect(normalizePathSpec("  ")).toBe(".");
		expect(normalizePathSpec("a\\b\\")).toBe("a/b");
		expect(normalizePathSpec("///")).toBe(".");
	});

	it("matches a path against a directory spec by prefix, and matches everything under '.'", () => {
		expect(pathMatchesSpec("src/foo", "src")).toBe(true);
		expect(pathMatchesSpec("anything", ".")).toBe(true);
		expect(pathMatchesSpec("srcfoo", "src")).toBe(false);
	});
});

describe("dedupeStrings", () => {
	it("trims, drops blanks, and keeps first occurrence order", () => {
		expect(dedupeStrings([" a ", "a", "b", "", "  ", "b"])).toEqual(["a", "b"]);
	});
});

describe("isBetter", () => {
	it("compares by direction", () => {
		expect(isBetter(1, 2, "lower")).toBe(true);
		expect(isBetter(3, 2, "lower")).toBe(false);
		expect(isBetter(3, 2, "higher")).toBe(true);
		expect(isBetter(1, 2, "higher")).toBe(false);
	});
});

describe("parseMetricLines", () => {
	it("parses METRIC lines, ignoring noise, prototype keys, and non-finite values", () => {
		const metrics = parseMetricLines("METRIC foo=1.5\nnoise\nMETRIC bar=42\nMETRIC __proto__=9\nMETRIC baz=NaN");
		expect([...metrics]).toEqual([
			["foo", 1.5],
			["bar", 42],
		]);
	});
});

describe("parseAsiLines", () => {
	it("parses typed ASI values (bool, number, string, JSON) and returns null when empty", () => {
		expect(parseAsiLines('ASI a=true\nASI b=12\nASI c=hello\nASI d={"x":1}')).toEqual({
			a: true,
			b: 12,
			c: "hello",
			d: { x: 1 },
		});
		expect(parseAsiLines("no asi lines here")).toBeNull();
	});
});

describe("mergeAsi", () => {
	it("merges override over base and returns undefined when both are absent", () => {
		expect(mergeAsi({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
		expect(mergeAsi({ a: 1 }, { a: 9 })).toEqual({ a: 9 });
		expect(mergeAsi(null, undefined)).toBeUndefined();
	});
});

describe("ensureNumericMetricMap", () => {
	it("keeps only finite numeric entries and drops prototype keys", () => {
		expect(ensureNumericMetricMap({ a: 1, b: Number.NaN, __proto__: 5, c: "x" } as never)).toEqual({ a: 1 });
	});
});

describe("sanitizeAsi", () => {
	it("recursively strips prototype-polluting keys from nested objects", () => {
		expect(sanitizeAsi({ a: 1, b: "s", c: { d: 2, constructor: 9 }, e: [1, "x", null] })).toEqual({
			a: 1,
			b: "s",
			c: { d: 2 },
			e: [1, "x", null],
		});
	});
});
