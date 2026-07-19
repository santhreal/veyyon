/**
 * Contract tests for partialIsoDate, the single owner that assembles a partial
 * ISO 8601 date from year/month/day parts. Crossref (numeric `date-parts`) and
 * ORCID (string `{value}` fields) both delegate to it, so these pin the exact
 * output at every precision and prove the one behavior that diverged before the
 * two hand-rolled copies were unified: a day with no month is dropped, because a
 * bare day is not a valid calendar date.
 */
import { describe, expect, it } from "bun:test";
import { partialIsoDate } from "@veyyon/coding-agent/web/scrapers/utils";

describe("partialIsoDate", () => {
	it("emits year, year-month, or full date depending on precision (numeric parts)", () => {
		expect(partialIsoDate(2021, 3, 7)).toBe("2021-03-07");
		expect(partialIsoDate(2021, 3)).toBe("2021-03");
		expect(partialIsoDate(2021)).toBe("2021");
	});

	it("zero-pads month and day to two digits, including string inputs", () => {
		expect(partialIsoDate("2021", "3", "7")).toBe("2021-03-07");
		expect(partialIsoDate(2021, 11, 30)).toBe("2021-11-30");
		expect(partialIsoDate("1999", "12", "1")).toBe("1999-12-01");
	});

	it("returns null when no year is present", () => {
		expect(partialIsoDate(undefined)).toBeNull();
		expect(partialIsoDate(null, 3, 7)).toBeNull();
		expect(partialIsoDate("")).toBeNull();
		expect(partialIsoDate(0, 3, 7)).toBeNull();
	});

	it("treats falsy month or day as absent (0, empty string, null, undefined)", () => {
		expect(partialIsoDate(2021, 0, 7)).toBe("2021");
		expect(partialIsoDate("2021", "", "7")).toBe("2021");
		expect(partialIsoDate(2021, null, 7)).toBe("2021");
		expect(partialIsoDate(2021, 3, 0)).toBe("2021-03");
		expect(partialIsoDate("2021", "3", "")).toBe("2021-03");
	});

	it("drops a day that has no month rather than sliding it into the month slot", () => {
		// The behavior the pre-unification Crossref copy got wrong: it filtered out
		// the empty month and joined the remaining parts, promoting the day to the
		// month position (2021-07). A day with no month is not a valid date, so the
		// owner returns just the year.
		expect(partialIsoDate(2021, undefined, 7)).toBe("2021");
		expect(partialIsoDate("2021", undefined, "15")).toBe("2021");
	});
});
