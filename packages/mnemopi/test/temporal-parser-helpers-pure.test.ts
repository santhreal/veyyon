import { describe, expect, it } from "bun:test";
import {
	DAY_MAP,
	extractDateFromText,
	extractTemporal,
	MONTH_MAP,
	NAMED_TIMES,
	parseNlDate,
	resolveRelativeDay,
} from "../src/core/temporal-parser";

const REF = new Date(Date.UTC(2024, 2, 15)); // Friday March 15 2024

describe("DAY_MAP", () => {
	it("maps full day names (Monday=0, Sunday=6)", () => {
		expect(DAY_MAP.monday).toBe(0);
		expect(DAY_MAP.tuesday).toBe(1);
		expect(DAY_MAP.wednesday).toBe(2);
		expect(DAY_MAP.thursday).toBe(3);
		expect(DAY_MAP.friday).toBe(4);
		expect(DAY_MAP.saturday).toBe(5);
		expect(DAY_MAP.sunday).toBe(6);
	});
	it("maps abbreviated day names", () => {
		expect(DAY_MAP.mon).toBe(0);
		expect(DAY_MAP.tue).toBe(1);
		expect(DAY_MAP.wed).toBe(2);
		expect(DAY_MAP.thu).toBe(3);
		expect(DAY_MAP.fri).toBe(4);
		expect(DAY_MAP.sat).toBe(5);
		expect(DAY_MAP.sun).toBe(6);
	});
});

describe("MONTH_MAP", () => {
	it("maps full month names", () => {
		expect(MONTH_MAP.january).toBe(1);
		expect(MONTH_MAP.december).toBe(12);
	});
	it("maps abbreviated month names", () => {
		expect(MONTH_MAP.jan).toBe(1);
		expect(MONTH_MAP.dec).toBe(12);
	});
});

describe("NAMED_TIMES", () => {
	it("defines morning hours", () => {
		expect(NAMED_TIMES.morning).toBeDefined();
		expect(NAMED_TIMES.morning[0]).toBeLessThan(NAMED_TIMES.morning[1]);
	});
	it("defines all named time keys", () => {
		expect(NAMED_TIMES.morning).toBeDefined();
		expect(NAMED_TIMES.afternoon).toBeDefined();
		expect(NAMED_TIMES.evening).toBeDefined();
		expect(NAMED_TIMES.night).toBeDefined();
		expect(NAMED_TIMES.midnight).toBeDefined();
		expect(NAMED_TIMES.noon).toBeDefined();
	});
});

describe("resolveRelativeDay", () => {
	it("returns reference date for unknown day name", () => {
		const result = resolveRelativeDay(REF, "funday");
		expect(result.getUTCDate()).toBe(15);
	});
	it("resolves 'this Friday' to current Friday", () => {
		const result = resolveRelativeDay(REF, "friday", "this");
		expect(result.getUTCDay()).toBe(5); // Friday
		expect(result.getUTCDate()).toBe(15); // Same day since ref IS Friday
	});
	it("resolves 'last Friday' to previous week's Friday", () => {
		const result = resolveRelativeDay(REF, "friday", "last");
		expect(result.getUTCDay()).toBe(5);
		expect(result.getUTCDate()).toBe(8); // One week before
	});
	it("resolves 'next Friday' to next week's Friday", () => {
		const result = resolveRelativeDay(REF, "friday", "next");
		expect(result.getUTCDay()).toBe(5);
		expect(result.getUTCDate()).toBe(22); // One week after
	});
	it("resolves 'this Monday' to the Monday of current week", () => {
		const result = resolveRelativeDay(REF, "monday", "this");
		expect(result.getUTCDay()).toBe(1);
		expect(result.getUTCDate()).toBe(11); // Monday before Friday the 15th
	});
	it("resolves 'next Monday' when today is Monday", () => {
		const monday = new Date(Date.UTC(2024, 2, 11)); // Monday March 11
		const result = resolveRelativeDay(monday, "monday", "next");
		expect(result.getUTCDate()).toBe(18); // Next Monday, not today
	});
	it("defaults to 'this' qualifier", () => {
		const result = resolveRelativeDay(REF, "monday");
		expect(result.getUTCDay()).toBe(1);
	});
	it("returns dateOnly for unknown qualifier", () => {
		const result = resolveRelativeDay(REF, "funday", "sometime");
		expect(result.getUTCDate()).toBe(15);
	});
});

describe("parseNlDate", () => {
	it("parses ISO date (YYYY-MM-DD)", () => {
		const result = parseNlDate("2024-03-15", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCFullYear()).toBe(2024);
		expect(result![0].getUTCMonth()).toBe(2);
		expect(result![0].getUTCDate()).toBe(15);
		expect(result![1]).toBe("day");
	});
	it("parses M/D/YYYY format", () => {
		const result = parseNlDate("3/15/2024", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDate()).toBe(15);
	});
	it("parses D/M/YYYY when day > 12", () => {
		const result = parseNlDate("15/3/2024", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDate()).toBe(15);
		expect(result![0].getUTCMonth()).toBe(2);
	});
	it("parses 2-digit year by adding 2000", () => {
		const result = parseNlDate("3/15/24", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCFullYear()).toBe(2024);
	});
	it("parses 'March 15th'", () => {
		const result = parseNlDate("March 15th", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCMonth()).toBe(2);
		expect(result![0].getUTCDate()).toBe(15);
	});
	it("parses 'Jan 1, 2024'", () => {
		const result = parseNlDate("Jan 1, 2024", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCMonth()).toBe(0);
		expect(result![0].getUTCDate()).toBe(1);
		expect(result![0].getUTCFullYear()).toBe(2024);
	});
	it("parses 'today'", () => {
		const result = parseNlDate("today", REF);
		expect(result).not.toBeNull();
		expect(result![1]).toBe("day");
		expect(result![0].getUTCDate()).toBe(15);
	});
	it("parses 'yesterday'", () => {
		const result = parseNlDate("yesterday", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDate()).toBe(14);
	});
	it("parses 'tomorrow'", () => {
		const result = parseNlDate("tomorrow", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDate()).toBe(16);
	});
	it("parses 'day after tomorrow'", () => {
		const result = parseNlDate("day after tomorrow", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDate()).toBe(17);
	});
	it("parses 'day before yesterday'", () => {
		const result = parseNlDate("day before yesterday", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDate()).toBe(13);
	});
	it("parses 'last Friday'", () => {
		const result = parseNlDate("last Friday", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDay()).toBe(5);
		expect(result![0].getUTCDate()).toBe(8);
	});
	it("parses 'next Monday'", () => {
		const result = parseNlDate("next Monday", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDay()).toBe(1);
		expect(result![0].getUTCDate()).toBe(18);
	});
	it("parses 'this week'", () => {
		const result = parseNlDate("this week", REF);
		expect(result).not.toBeNull();
		expect(result![1]).toBe("week");
	});
	it("parses 'last month'", () => {
		const result = parseNlDate("last month", REF);
		expect(result).not.toBeNull();
		expect(result![1]).toBe("month");
		expect(result![0].getUTCMonth()).toBe(1); // February
	});
	it("parses 'next year'", () => {
		const result = parseNlDate("next year", REF);
		expect(result).not.toBeNull();
		expect(result![1]).toBe("year");
		expect(result![0].getUTCFullYear()).toBe(2025);
	});
	it("parses '3 days ago'", () => {
		const result = parseNlDate("3 days ago", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDate()).toBe(12);
	});
	it("parses 'in 2 weeks'", () => {
		const result = parseNlDate("in 2 weeks", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDate()).toBe(29);
	});
	it("parses 'recently'", () => {
		const result = parseNlDate("recently", REF);
		expect(result).not.toBeNull();
		expect(result![1]).toBe("relative");
	});
	it("parses 'a while ago'", () => {
		const result = parseNlDate("a while ago", REF);
		expect(result).not.toBeNull();
		expect(result![1]).toBe("relative");
	});
	it("returns null for non-date text", () => {
		expect(parseNlDate("hello world", REF)).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(parseNlDate("", REF)).toBeNull();
	});
	it("parses 'on Friday' without qualifier", () => {
		const result = parseNlDate("on Friday", REF);
		expect(result).not.toBeNull();
		expect(result![0].getUTCDay()).toBe(5);
	});
	it("parses '5 hours ago'", () => {
		const result = parseNlDate("5 hours ago", REF);
		expect(result).not.toBeNull();
		expect(result![1]).toBe("day");
	});
	it("parses 'in 3 months'", () => {
		const result = parseNlDate("in 3 months", REF);
		expect(result).not.toBeNull();
		expect(result![1]).toBe("week");
	});
});

describe("extractTemporal", () => {
	it("extracts date from text with date", () => {
		const result = extractTemporal("2024-03-15", REF);
		expect(result.event_date).toBe("2024-03-15");
		expect(result.event_date_precision).toBe("day");
	});
	it("returns unknown precision for non-date text", () => {
		const result = extractTemporal("hello world", REF);
		expect(result.event_date).toBeNull();
		expect(result.event_date_precision).toBe("unknown");
	});
	it("extracts named time tags (morning)", () => {
		const result = extractTemporal("meeting tomorrow morning", REF);
		expect(result.temporal_tags).toContain("morning");
	});
	it("extracts named time tags (afternoon)", () => {
		const result = extractTemporal("call tomorrow afternoon", REF);
		expect(result.temporal_tags).toContain("afternoon");
	});
	it("does not match 'night' as substring of 'midnight'", () => {
		const result = extractTemporal("midnight launch", REF);
		expect(result.temporal_tags).toContain("midnight");
		expect(result.temporal_tags).not.toContain("night");
	});
	it("primary_signal is first tag", () => {
		const result = extractTemporal("yesterday", REF);
		expect(result.primary_signal).toBe(result.temporal_tags[0]);
	});
	it("primary_signal is null when no tags", () => {
		const result = extractTemporal("hello world", REF);
		expect(result.primary_signal).toBeNull();
	});
});

describe("extractDateFromText", () => {
	it("returns ISO date string for text with date", () => {
		expect(extractDateFromText("2024-03-15", REF)).toBe("2024-03-15");
	});
	it("returns null for non-date text", () => {
		expect(extractDateFromText("hello world", REF)).toBeNull();
	});
	it("returns null for empty string", () => {
		expect(extractDateFromText("", REF)).toBeNull();
	});
});
