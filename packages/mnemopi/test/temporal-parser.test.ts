import { describe, expect, it } from "bun:test";
import {
	DAY_MAP,
	extractDateFromText,
	extractTemporal,
	MONTH_MAP,
	NAMED_TIMES,
	parseNlDate,
	resolveRelativeDay,
} from "@veyyon/mnemopi/core/temporal-parser";

const REF = new Date("2026-05-20T15:30:00Z"); // Wednesday

function iso(value: Date): string {
	return value.toISOString().slice(0, 10);
}

describe("temporal parser", () => {
	it("exports day, month, and named-time constants", () => {
		expect(DAY_MAP.monday).toBe(0);
		expect(DAY_MAP.sun).toBe(6);
		expect(MONTH_MAP.may).toBe(5);
		expect(MONTH_MAP.dec).toBe(12);
		expect(NAMED_TIMES.morning).toEqual([6, 12]);
		expect(NAMED_TIMES.night).toEqual([21, 6]);
	});

	it("extracts ISO absolute dates", () => {
		const result = extractTemporal("Meeting was on 2026-05-15", REF);
		expect(result.event_date).toBe("2026-05-15");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-15", "week-20-2026", "friday"]);
		expect(result.primary_signal).toBe("2026-05-15");
	});

	it("rejects invalid ISO dates and falls through", () => {
		const result = extractTemporal("Bad leap day 2026-02-29", REF);
		expect(result.event_date).toBeNull();
		expect(result.event_date_precision).toBe("unknown");
		expect(result.temporal_tags).toEqual([]);
	});

	it("parses slash dates with Python's US/EU heuristic", () => {
		expect(extractTemporal("US date 05/20/2026", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("EU date 20/05/2026", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("Short year 5/20/26", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("Impossible 31/02/2026", REF).event_date).toBeNull();
	});

	it("parses named month dates using the reference year when omitted", () => {
		expect(extractTemporal("Shipped May 20, 2026", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("Shipped May 20th", REF).event_date).toBe("2026-05-20");
		expect(extractTemporal("Shipped Sep 7", REF).event_date).toBe("2026-09-07");
		expect(extractTemporal("Invalid Feb 30", REF).event_date).toBeNull();
	});

	it("extracts relative dates deterministically", () => {
		let result = extractTemporal("I had a meeting today", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-20", "wednesday"]);

		result = extractTemporal("I had a meeting yesterday", REF);
		expect(result.event_date).toBe("2026-05-19");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-19", "tuesday", "yesterday"]);

		result = extractTemporal("I have a meeting tomorrow", REF);
		expect(result.event_date).toBe("2026-05-21");
		expect(result.temporal_tags).toEqual(["2026-05-21", "thursday", "tomorrow"]);
	});

	// Regression: "day before yesterday" means two days ago, not one. The compound
	// phrase used to be shadowed by the plain `yesterday` branch (it contains the
	// substring "yesterday"), so it resolved to REF-1 and even tagged "yesterday".
	// The compound checks now run before the words they contain. REF is a
	// Wednesday (2026-05-20): two days before is Monday 2026-05-18.
	it("resolves 'day before yesterday' to two days before, not one", () => {
		const result = extractTemporal("day before yesterday", REF);
		expect(result.event_date).toBe("2026-05-18");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-18", "monday", "day before yesterday"]);
		expect(result.temporal_tags).not.toContain("yesterday");
	});

	// Symmetric twin: "day after tomorrow" means two days ahead and must not be
	// shadowed by the plain `tomorrow` branch. Two days after Wednesday 2026-05-20
	// is Friday 2026-05-22.
	it("resolves 'day after tomorrow' to two days ahead, not one", () => {
		const result = extractTemporal("let's meet the day after tomorrow", REF);
		expect(result.event_date).toBe("2026-05-22");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-22", "friday", "day after tomorrow"]);
		expect(result.temporal_tags).not.toContain("tomorrow");
	});

	// The plain single-word branches still resolve to one day off, unshadowed.
	it("keeps plain 'yesterday' and 'tomorrow' at one day", () => {
		expect(extractTemporal("yesterday", REF).event_date).toBe("2026-05-19");
		expect(extractTemporal("yesterday", REF).temporal_tags).toContain("yesterday");
		expect(extractTemporal("tomorrow", REF).event_date).toBe("2026-05-21");
		expect(extractTemporal("tomorrow", REF).temporal_tags).toContain("tomorrow");
	});

	it("extracts qualified day references", () => {
		let result = extractTemporal("Discussed this last Monday", REF);
		expect(result.event_date).toBe("2026-05-11");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-11", "week-20-2026", "monday", "last"]);

		result = extractTemporal("Discussed this Monday", REF);
		expect(result.event_date).toBe("2026-05-18");
		expect(result.temporal_tags).toEqual(["2026-05-18", "week-21-2026", "monday", "this"]);

		result = extractTemporal("Discussed next Monday", REF);
		expect(result.event_date).toBe("2026-05-25");
		expect(result.temporal_tags).toEqual(["2026-05-25", "week-22-2026", "monday", "next"]);
	});

	it("extracts bare day references as this-most-recent day", () => {
		let result = extractTemporal("on Monday we discussed the API", REF);
		expect(result.event_date).toBe("2026-05-18");
		expect(result.temporal_tags).toEqual(["2026-05-18", "week-21-2026", "monday"]);

		result = extractTemporal("on Wednesday we discussed the API", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.temporal_tags).toEqual(["2026-05-20", "week-21-2026", "wednesday"]);
	});

	it("extracts week, month, and year references", () => {
		expect(extractTemporal("this week", REF)).toMatchObject({
			event_date: "2026-05-20",
			event_date_precision: "week",
			temporal_tags: ["week-21-2026", "this-week"],
		});
		expect(extractTemporal("last week", REF)).toMatchObject({
			event_date: "2026-05-13",
			event_date_precision: "week",
			temporal_tags: ["week-20-2026", "last-week"],
		});
		expect(extractTemporal("next week", REF)).toMatchObject({
			event_date: "2026-05-27",
			event_date_precision: "week",
			temporal_tags: ["week-22-2026", "next-week"],
		});
		expect(extractTemporal("last month", REF)).toMatchObject({
			event_date: "2026-04-01",
			event_date_precision: "month",
			temporal_tags: ["2026-04", "last-month"],
		});
		expect(extractTemporal("next month", REF)).toMatchObject({
			event_date: "2026-06-01",
			event_date_precision: "month",
			temporal_tags: ["2026-06", "next-month"],
		});
		expect(extractTemporal("last year", REF)).toMatchObject({
			event_date: "2025-01-01",
			event_date_precision: "year",
			temporal_tags: ["2025", "last-year"],
		});
		expect(extractTemporal("next year", REF)).toMatchObject({
			event_date: "2027-01-01",
			event_date_precision: "year",
			temporal_tags: ["2027", "next-year"],
		});
	});

	it("handles month and year boundaries", () => {
		expect(extractTemporal("last month", new Date("2026-01-15T00:00:00Z")).event_date).toBe("2025-12-01");
		expect(extractTemporal("next month", new Date("2026-12-15T00:00:00Z")).event_date).toBe("2027-01-01");
	});

	it("extracts past intervals", () => {
		let result = extractTemporal("We deployed 2 days ago", REF);
		expect(result.event_date).toBe("2026-05-18");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-18", "2-days-ago"]);

		result = extractTemporal("We deployed 3 hours ago", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.event_date_precision).toBe("day");
		expect(result.temporal_tags).toEqual(["2026-05-20", "3-hours-ago"]);

		result = extractTemporal("We deployed 2 weeks back", REF);
		expect(result.event_date).toBe("2026-05-06");
		expect(result.event_date_precision).toBe("week");
		expect(result.temporal_tags).toEqual(["2026-05-06", "2-weeks-ago"]);
	});

	it("extracts future intervals", () => {
		let result = extractTemporal("in 3 weeks", REF);
		expect(result.event_date).toBe("2026-06-10");
		expect(result.event_date_precision).toBe("week");
		expect(result.temporal_tags).toEqual(["2026-06-10", "in-3-weeks"]);

		result = extractTemporal("in 2 months", REF);
		expect(result.event_date).toBe("2026-07-19");
		expect(result.event_date_precision).toBe("week");
		expect(result.temporal_tags).toEqual(["2026-07-19", "in-2-months"]);
	});

	it("extracts named times with and without dates", () => {
		let result = extractTemporal("Had coffee this morning", REF);
		expect(result.event_date).toBeNull();
		expect(result.event_date_precision).toBe("unknown");
		expect(result.temporal_tags).toEqual(["morning"]);
		expect(result.primary_signal).toBe("morning");

		result = extractTemporal("Yesterday evening we met", REF);
		expect(result.event_date).toBe("2026-05-19");
		expect(result.temporal_tags).toEqual(["2026-05-19", "tuesday", "yesterday", "evening"]);
	});

	// Named times are matched as whole words. Some keys are substrings of others
	// ("night" of "midnight", "noon" of "afternoon") and appear earlier in the
	// key order, so the old substring `includes` check tagged the wrong, shorter
	// time and dropped the real one. These pin whole-word matching so a named
	// time is only recorded when its exact word is present.
	it("tags a named time by whole word, not substring", () => {
		// "midnight" contains "night"; the tag must be midnight, not night.
		const midnight = extractTemporal("shipped it at midnight", REF);
		expect(midnight.temporal_tags).toEqual(["midnight"]);
		expect(midnight.primary_signal).toBe("midnight");

		// "afternoon" contains "noon"; the tag must be afternoon, not noon.
		expect(extractTemporal("met this afternoon", REF).temporal_tags).toEqual(["afternoon"]);

		// The exact shorter words still tag themselves.
		expect(extractTemporal("worked past noon", REF).temporal_tags).toEqual(["noon"]);
		expect(extractTemporal("out late at night", REF).temporal_tags).toEqual(["night"]);

		// A word that merely contains a named time is not a named time: "tonight"
		// is not in the vocabulary, so it tags nothing (before the fix it wrongly
		// matched "night" as a substring).
		expect(extractTemporal("see you tonight", REF).temporal_tags).toEqual([]);
	});

	it("extracts vague references", () => {
		let result = extractTemporal("recently updated the server", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.event_date_precision).toBe("relative");
		expect(result.temporal_tags).toEqual(["recently"]);

		result = extractTemporal("a while ago we changed the server", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.event_date_precision).toBe("relative");
		expect(result.temporal_tags).toEqual(["vague"]);
	});

	it("returns unknown when no temporal reference exists", () => {
		const result = extractTemporal("The database password is hunter2", REF);
		expect(result.event_date).toBeNull();
		expect(result.event_date_precision).toBe("unknown");
		expect(result.temporal_tags).toEqual([]);
		expect(result.primary_signal).toBeNull();
	});

	it("parses natural-language dates directly", () => {
		let result = parseNlDate("2026-05-15", REF);
		expect(result).not.toBeNull();
		expect(result?.[0].getUTCFullYear()).toBe(2026);
		expect(result?.[1]).toBe("day");
		expect(result?.[2]).toContain("2026-05-15");

		result = parseNlDate("yesterday", REF);
		expect(result).not.toBeNull();
		expect(result === null ? null : iso(result[0])).toBe("2026-05-19");

		expect(parseNlDate("not a date at all", REF)).toBeNull();
	});

	it("extracts temporal tags for parsed dates", () => {
		const result = extractTemporal("Last Monday we discussed the API design", REF);
		expect(result.temporal_tags.length).toBeGreaterThan(0);
		expect(result.temporal_tags).toContain("monday");
	});

	it("uses the first date expression when multiple are present", () => {
		const result = extractTemporal("Deployed v2 on 2026-01-15 and v3 yesterday", REF);
		expect(result.event_date).toBe("2026-01-15");
		expect(result.primary_signal).toBe("2026-01-15");
	});

	it("extracts just the date string", () => {
		expect(extractDateFromText("Deployed yesterday", REF)).toBe("2026-05-19");
		expect(extractDateFromText("No date here", REF)).toBeNull();
	});

	it("treats date-only and timezone-less string references as UTC", () => {
		expect(extractTemporal("yesterday", "2026-05-20").event_date).toBe("2026-05-19");
		expect(extractTemporal("yesterday", "2026-05-20T02:00:00").event_date).toBe("2026-05-19");
		expect(extractTemporal("yesterday", "2026-05-20T02:00:00Z").event_date).toBe("2026-05-19");
	});

	it("resolves relative days and falls back to the reference for unknown days or qualifiers", () => {
		// "this" of the reference weekday is the reference day itself.
		expect(iso(resolveRelativeDay(REF, "wednesday", "this"))).toBe("2026-05-20");
		// An unknown day name returns the reference date unchanged (dateOnly guard).
		expect(iso(resolveRelativeDay(REF, "notaday"))).toBe("2026-05-20");
		// An unrecognized qualifier falls through to the reference date, not this/last/next.
		expect(iso(resolveRelativeDay(REF, "wednesday", "whenever"))).toBe("2026-05-20");
	});

	it("extracts sub-day and multi-year intervals through every delta unit", () => {
		// second and minute units resolve to the same calendar day but a "week" precision.
		let result = extractTemporal("pinged 5 seconds ago", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.event_date_precision).toBe("week");
		expect(result.temporal_tags).toEqual(["2026-05-20", "5-seconds-ago"]);

		result = extractTemporal("pinged 10 minutes ago", REF);
		expect(result.event_date).toBe("2026-05-20");
		expect(result.temporal_tags).toEqual(["2026-05-20", "10-minutes-ago"]);

		// year deltas span 365 days each.
		result = extractTemporal("shipped 2 years ago", REF);
		expect(result.event_date).toBe("2024-05-20");
		expect(result.temporal_tags).toEqual(["2024-05-20", "2-years-ago"]);

		result = extractTemporal("renews in 1 year", REF);
		expect(result.event_date).toBe("2027-05-20");
		expect(result.temporal_tags).toEqual(["2027-05-20", "in-1-years"]);
	});

	it("extracts this-month and this-year references", () => {
		expect(extractTemporal("this month", REF)).toMatchObject({
			event_date: "2026-05-20",
			event_date_precision: "month",
			temporal_tags: ["2026-05", "this-month"],
		});
		expect(extractTemporal("this year", REF)).toMatchObject({
			event_date: "2026-05-20",
			event_date_precision: "year",
			temporal_tags: ["2026", "this-year"],
		});
	});

	it("returns null when an interval magnitude overflows the safe-integer range", () => {
		expect(parseNlDate("in 99999999999999999999 days", REF)).toBeNull();
		expect(parseNlDate("99999999999999999999 days ago", REF)).toBeNull();
	});

	it("parses last-year and next-year references directly through parseNlDate", () => {
		// parseNlDate has its own qualifier+unit block, distinct from extractTemporal's
		// regex path; the year arms round to Jan 1 of the adjacent year.
		const lastYear = parseNlDate("last year", REF);
		expect(lastYear).not.toBeNull();
		expect(lastYear === null ? null : iso(lastYear[0])).toBe("2025-01-01");
		expect(lastYear?.[1]).toBe("year");
		expect(lastYear?.[2]).toEqual(["2025", "last-year"]);

		const nextYear = parseNlDate("next year", REF);
		expect(nextYear).not.toBeNull();
		expect(nextYear === null ? null : iso(nextYear[0])).toBe("2027-01-01");
		expect(nextYear?.[1]).toBe("year");
		expect(nextYear?.[2]).toEqual(["2027", "next-year"]);
	});
});
