/**
 * `formatDurationCoarse` rounds to one unit (s/m/h/d). The hour→day hop is
 * at 48 hours, not 24: a 36h stall prints `36h`, a 48h stall prints `2d`.
 * Negative durations clamp to `0s`. This is the compact status-line contract
 * and must not drift into `@veyyon/utils` `formatDuration` (compound, floor).
 *
 * No existing test names these hops.
 */
import { describe, expect, it } from "bun:test";
import { formatDurationCoarse } from "@veyyon/coding-agent/slash-commands/helpers/format";

describe("formatDurationCoarse clamps negatives and sub-second noise", () => {
	it("prints 0s for 0", () => {
		expect(formatDurationCoarse(0)).toBe("0s");
	});

	it("prints 0s for a negative duration rather than '-1s'", () => {
		expect(formatDurationCoarse(-1)).toBe("0s");
		expect(formatDurationCoarse(-90_000)).toBe("0s");
	});

	it("prints 0s for 499ms (rounds to 0 seconds)", () => {
		expect(formatDurationCoarse(499)).toBe("0s");
	});

	it("prints 1s for 500ms (round half away from zero via Math.round)", () => {
		expect(formatDurationCoarse(500)).toBe("1s");
	});
});

describe("formatDurationCoarse second-to-minute hop is at 60 rounded seconds", () => {
	it("prints 59s just below the hop", () => {
		expect(formatDurationCoarse(59_000)).toBe("59s");
		expect(formatDurationCoarse(59_499)).toBe("59s");
	});

	it("prints 1m at 59.5s because seconds round to 60", () => {
		expect(formatDurationCoarse(59_500)).toBe("1m");
	});

	it("prints 1m at exactly 60s", () => {
		expect(formatDurationCoarse(60_000)).toBe("1m");
	});
});

describe("formatDurationCoarse minute-to-hour hop is at 60 rounded minutes", () => {
	it("prints 59m just below the hop", () => {
		expect(formatDurationCoarse(59 * 60_000)).toBe("59m");
	});

	it("prints 1h at 60 minutes", () => {
		expect(formatDurationCoarse(60 * 60_000)).toBe("1h");
	});
});

describe("formatDurationCoarse hour-to-day hop is 48h, not 24h", () => {
	it("prints 24h rather than 1d", () => {
		expect(formatDurationCoarse(24 * 60 * 60_000)).toBe("24h");
	});

	it("prints 36h rather than 2d or 1d", () => {
		expect(formatDurationCoarse(36 * 60 * 60_000)).toBe("36h");
	});

	it("prints 47h rather than 2d", () => {
		expect(formatDurationCoarse(47 * 60 * 60_000)).toBe("47h");
	});

	it("prints 2d at 48h (hours round to 48, then days = 48/24)", () => {
		expect(formatDurationCoarse(48 * 60 * 60_000)).toBe("2d");
	});

	it("never prints a compound unit", () => {
		expect(formatDurationCoarse(90 * 60_000)).toBe("2h");
		expect(formatDurationCoarse(90 * 60_000)).not.toContain("m");
		expect(formatDurationCoarse(90 * 60_000)).not.toContain("s");
	});
});
