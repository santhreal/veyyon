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

	it("strips the IXDTF named-zone bracket and honors the numeric offset", () => {
		// Temporal.ZonedDateTime.toString() form: <datetime><offset>[Zone].
		expect(parseIsoDateTimeUtc("2026-01-02T03:04:05.123456+05:30[Asia/Kolkata]").toISOString()).toBe(
			"2026-01-01T21:34:05.123Z",
		);
		// A bracket with only Z before it is UTC.
		expect(parseIsoDateTimeUtc("2026-01-02T03:04:05Z[UTC]").toISOString()).toBe("2026-01-02T03:04:05.000Z");
		// A zone bracket with no offset falls back to the zone-less UTC assumption.
		expect(parseIsoDateTimeUtc("2026-01-02T03:04:05[America/Denver]").toISOString()).toBe("2026-01-02T03:04:05.000Z");
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

	it("uses the caller-supplied fallback for missing or unparseable timestamps (recall passes 0)", () => {
		expect(recencyDecay(null, 24, now, 0)).toBe(0);
		expect(recencyDecay("", 24, now, 0)).toBe(0);
		expect(recencyDecay("garbage", 24, now, 0)).toBe(0);
	});

	it("clamps a future timestamp to age 0 so the weight never exceeds 1", () => {
		// One day in the future relative to `now`; without the clamp the age is
		// negative and the exponential would climb above 1.
		expect(recencyDecay("2026-06-02T00:00:00Z", 24, now, 0)).toBe(1);
	});
});

describe("recencyDecay / temporalBoost parity across zone forms (single owner)", () => {
	// Every former fork (helpers.ts, recall.ts) is gone; these assert the owner
	// reproduces the exact outputs the live recall path relied on for each input
	// shape: explicit Z, zone-less (assumed UTC), date-only, invalid, and future.
	const now = new Date("2026-06-10T00:00:00Z");
	const oneDay = 24;

	it("recencyDecay treats a zone-less timestamp as UTC, matching the explicit-Z form", () => {
		const withZ = recencyDecay("2026-06-09T00:00:00Z", oneDay, now, 0);
		const zoneLess = recencyDecay("2026-06-09T00:00:00", oneDay, now, 0);
		expect(zoneLess).toBeCloseTo(withZ, 12);
		expect(zoneLess).toBeCloseTo(Math.exp(-1), 12);
	});

	it("recencyDecay reads a date-only string as UTC midnight", () => {
		expect(recencyDecay("2026-06-09", oneDay, now, 0)).toBeCloseTo(Math.exp(-1), 12);
	});

	it("temporalBoost matches recall's distance decay for Z, zone-less, and offset forms", () => {
		const query = new Date("2026-06-10T00:00:00Z");
		expect(temporalBoost("2026-06-09T00:00:00Z", query, oneDay)).toBeCloseTo(Math.exp(-1), 12);
		expect(temporalBoost("2026-06-09T00:00:00", query, oneDay)).toBeCloseTo(Math.exp(-1), 12);
		expect(temporalBoost("2026-06-09T03:00:00+03:00", query, oneDay)).toBeCloseTo(Math.exp(-1), 12);
		expect(temporalBoost("2026-06-11T00:00:00Z", query, oneDay)).toBe(1); // future -> clamp
		expect(temporalBoost("garbage", query, oneDay)).toBe(0);
		expect(temporalBoost("", query, oneDay)).toBe(0);
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
