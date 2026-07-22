import { describe, expect, it } from "bun:test";
import { formatLocalCalendarDate } from "../../src/utils/local-date";

/**
 * formatLocalCalendarDate renders a Date as YYYY-MM-DD using the host's LOCAL
 * calendar fields, not UTC. It had no test. Two regressions are worth locking:
 *   - single-digit months and days must be zero-padded (a naive template would
 *     emit "2025-1-5" and break lexicographic date sorting and equality checks);
 *   - it must read local getFullYear/getMonth/getDate, never toISOString (UTC),
 *     so a date built with the local Date constructor round-trips to the same
 *     calendar day regardless of the host timezone.
 * The month is +1 because getMonth is zero-based; forgetting that offset would
 * shift every date back a month, so January is pinned explicitly.
 */

describe("formatLocalCalendarDate", () => {
	it("zero-pads a single-digit month and day", () => {
		// Local Jan 5, 2025. getMonth() is 0 for January, so the +1 offset and the
		// padStart are both exercised: a bug in either would not produce "2025-01-05".
		expect(formatLocalCalendarDate(new Date(2025, 0, 5))).toBe("2025-01-05");
	});

	it("renders a two-digit month and day without extra padding", () => {
		expect(formatLocalCalendarDate(new Date(2025, 11, 25))).toBe("2025-12-25");
	});

	it("maps zero-based getMonth to a one-based calendar month", () => {
		// October is month index 9; the output must read 10, not 09.
		expect(formatLocalCalendarDate(new Date(2024, 9, 1))).toBe("2024-10-01");
	});

	it("does not pad or truncate the year", () => {
		expect(formatLocalCalendarDate(new Date(999, 0, 1))).toBe("999-01-01");
	});

	it("round-trips a locally constructed date to the same calendar day", () => {
		// Built from local fields, so it stays on the same day in any host timezone;
		// a UTC-based implementation (toISOString) could roll to the previous or
		// next day near midnight. This pins the local-not-UTC contract.
		const d = new Date(2023, 6, 4, 23, 59, 59);
		expect(formatLocalCalendarDate(d)).toBe("2023-07-04");
	});
});
