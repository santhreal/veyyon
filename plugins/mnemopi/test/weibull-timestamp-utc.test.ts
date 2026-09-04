import { describe, expect, it } from "bun:test";
import { weibullBoost } from "@veyyon/mnemopi/core/weibull";

// weibull decay is age-based (now - created_at). Before the fix, parseTimestamp
// hand-rolled `new Date(...)` with a local-time `new Date(year, month-1, day)`
// fallback, so a naive (no-timezone) stamp was read in the backend's local zone
// and the same stored memory decayed differently depending on the host. The
// canonical parser reads a naive or date-only stamp as UTC, matching the
// Z-suffixed rows mnemopi actually writes. This host is UTC-7, so a regression to
// local parsing shifts the age by 7 hours and these assertions fail.
describe("weibull timestamp parsing is UTC and host-independent", () => {
	// 7 days (168 h) after the created_at instant.
	const queryTime = new Date(Date.UTC(2026, 0, 8, 12, 0, 0));

	it("reads a naive timestamp identically to its Z-suffixed form", () => {
		const naive = weibullBoost("2026-01-01T12:00:00", queryTime, "general");
		const utc = weibullBoost("2026-01-01T12:00:00Z", queryTime, "general");
		expect(naive).toBe(utc);
	});

	it("reads a SQLite space-separated stamp as UTC too", () => {
		const sqlite = weibullBoost("2026-01-01 12:00:00", queryTime, "general");
		const utc = weibullBoost("2026-01-01T12:00:00Z", queryTime, "general");
		expect(sqlite).toBe(utc);
	});

	it("reads a date-only stamp as UTC midnight", () => {
		const dateOnly = weibullBoost("2026-01-01", queryTime, "general");
		const utcMidnight = weibullBoost("2026-01-01T00:00:00Z", queryTime, "general");
		expect(dateOnly).toBe(utcMidnight);
	});

	it("computes the exact 7-day 'general' survival from the UTC instant", () => {
		// general: k=1.0, eta=168.0 h. age = 168 h exactly, so
		// survival = exp(-(168/168)^1) = exp(-1).
		const boost = weibullBoost("2026-01-01T12:00:00Z", queryTime, "general");
		expect(boost).toBeCloseTo(Math.exp(-1), 12);
	});

	it("passes a Date instance through untouched", () => {
		const instant = new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
		expect(weibullBoost(instant, queryTime, "general")).toBeCloseTo(Math.exp(-1), 12);
	});

	it("returns 0 for an unparseable stamp", () => {
		expect(weibullBoost("not a date", queryTime, "general")).toBe(0);
	});
});
