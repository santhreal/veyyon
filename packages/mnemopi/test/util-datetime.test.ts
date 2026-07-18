import { describe, expect, it } from "bun:test";
import {
	normalizeDateTimeUtc,
	parseIsoDateTimeUtc,
	parseQueryTime,
	parseTsFast,
	recencyDecay,
	temporalBoost,
	toUtcIso,
} from "../src/util/datetime";

describe("parseIsoDateTimeUtc", () => {
	it("assumes UTC for zone-less timestamps and date-only strings", () => {
		expect(parseIsoDateTimeUtc("2026-01-02T03:04:05").toISOString()).toBe("2026-01-02T03:04:05.000Z");
		expect(parseIsoDateTimeUtc("2026-01-02").toISOString()).toBe("2026-01-02T00:00:00.000Z");
	});

	it("respects explicit zones instead of double-appending Z", () => {
		expect(parseIsoDateTimeUtc("2026-01-02T03:04:05Z").toISOString()).toBe("2026-01-02T03:04:05.000Z");
		expect(parseIsoDateTimeUtc("2026-01-02T03:04:05+02:00").toISOString()).toBe("2026-01-02T01:04:05.000Z");
		expect(parseIsoDateTimeUtc("2026-01-02T03:04:05-0330").toISOString()).toBe("2026-01-02T06:34:05.000Z");
	});

	it("throws RangeError on empty and unparseable input", () => {
		expect(() => parseIsoDateTimeUtc("")).toThrow(RangeError);
		expect(() => parseIsoDateTimeUtc("   ")).toThrow(RangeError);
		expect(() => parseIsoDateTimeUtc("not a date")).toThrow(RangeError);
	});
});

describe("parseTsFast", () => {
	it("parses like parseIsoDateTimeUtc and caches the result object", () => {
		const first = parseTsFast("2026-03-04T05:06:07");
		expect(first?.toISOString()).toBe("2026-03-04T05:06:07.000Z");
		expect(parseTsFast("2026-03-04T05:06:07")).toBe(first as Date);
	});

	it("returns undefined instead of throwing on bad input", () => {
		expect(parseTsFast("")).toBeUndefined();
		expect(parseTsFast("garbage")).toBeUndefined();
	});
});

describe("parseQueryTime / normalizeDateTimeUtc / toUtcIso", () => {
	it("normalizes strings, clones Dates, and defaults to now", () => {
		expect(parseQueryTime("2026-01-01").toISOString()).toBe("2026-01-01T00:00:00.000Z");
		const original = new Date("2026-01-01T00:00:00Z");
		const cloned = normalizeDateTimeUtc(original);
		expect(cloned).not.toBe(original);
		expect(cloned.getTime()).toBe(original.getTime());
		expect(Math.abs(parseQueryTime(null).getTime() - Date.now())).toBeLessThan(5000);
		expect(() => normalizeDateTimeUtc(new Date("invalid"))).toThrow(RangeError);
	});

	it("toUtcIso renders a Date as its UTC ISO string", () => {
		expect(toUtcIso(new Date("2026-05-06T07:08:09.100Z"))).toBe("2026-05-06T07:08:09.100Z");
	});
});

describe("recencyDecay", () => {
	const now = new Date("2026-06-01T00:00:00Z");

	it("is 1 at zero age and halves per halflife", () => {
		expect(recencyDecay("2026-06-01T00:00:00Z", 24, now)).toBeCloseTo(1, 10);
		// e^(-24/24) after one halflife-hours span
		expect(recencyDecay("2026-05-31T00:00:00Z", 24, now)).toBeCloseTo(Math.exp(-1), 10);
	});

	it("falls back to 0.5 for missing or unparseable timestamps", () => {
		expect(recencyDecay(null, 24, now)).toBe(0.5);
		expect(recencyDecay("garbage", 24, now)).toBe(0.5);
	});
});

describe("temporalBoost", () => {
	const query = "2026-06-02T00:00:00Z";

	it("decays with age relative to the query time", () => {
		expect(temporalBoost("2026-06-02T00:00:00Z", query)).toBeCloseTo(1, 10);
		expect(temporalBoost("2026-06-01T00:00:00Z", query, 24)).toBeCloseTo(Math.exp(-1), 10);
	});

	it("clamps future memories to the query time instead of boosting past 1", () => {
		expect(temporalBoost("2026-06-03T00:00:00Z", query)).toBeCloseTo(1, 10);
	});

	it("returns 0 for unparseable memory timestamps", () => {
		expect(temporalBoost("garbage", query)).toBe(0);
	});
});
