/**
 * formatClock — the house style for TICKING elapsed clocks (`0:07`, `12:34`,
 * `1:02:03`). This formatter was hoisted out of pause-screen.ts into the ONE
 * shared owner when the working line's per-task clock and the location line's
 * total-elapsed clock were added; these tests lock its exact digit contract so
 * all three surfaces tick identically and a second local copy never reappears
 * with drifted padding or rounding.
 */
import { describe, expect, it } from "bun:test";
import { formatClock } from "@veyyon/utils/format";

describe("formatClock", () => {
	/** Sub-minute durations keep the `M:SS` frame with a zero minute — a bare
	 * seconds count ("7s") would make the readout jump shape at the minute
	 * boundary, which reads as a glitch on a live ticking line. */
	it("renders sub-minute values as 0:SS with two-digit seconds", () => {
		expect(formatClock(0)).toBe("0:00");
		expect(formatClock(999)).toBe("0:00");
		expect(formatClock(1_000)).toBe("0:01");
		expect(formatClock(7_000)).toBe("0:07");
		expect(formatClock(59_999)).toBe("0:59");
	});

	/** Minutes are unpadded (a leading zero would read as an hour slot),
	 * seconds always two digits. */
	it("renders minute-scale values as M:SS", () => {
		expect(formatClock(60_000)).toBe("1:00");
		expect(formatClock(95_000)).toBe("1:35");
		expect(formatClock(12 * 60_000 + 34_000)).toBe("12:34");
		expect(formatClock(59 * 60_000 + 59_000)).toBe("59:59");
	});

	/** At the hour the frame widens to H:MM:SS and minutes gain the pad —
	 * `1:2:3` would be ambiguous with the minute-scale frame. */
	it("renders hour-scale values as H:MM:SS with padded minutes and seconds", () => {
		expect(formatClock(3_600_000)).toBe("1:00:00");
		expect(formatClock(3_600_000 + 2 * 60_000 + 3_000)).toBe("1:02:03");
		expect(formatClock(25 * 3_600_000 + 60_000)).toBe("25:01:00");
	});

	/** Milliseconds floor, never round: a clock that shows a second before it
	 * has elapsed ticks visibly faster than wall time. */
	it("floors partial seconds instead of rounding up", () => {
		expect(formatClock(1_999)).toBe("0:01");
		expect(formatClock(59_999)).toBe("0:59");
	});

	/** Skew guard: a wall-clock adjustment can make `now - startedAt` negative,
	 * and NaN/Infinity must never leak "NaN:NaN" into a live status row. */
	it("clamps negative and non-finite inputs to 0:00", () => {
		expect(formatClock(-1)).toBe("0:00");
		expect(formatClock(-612_090)).toBe("0:00");
		expect(formatClock(Number.NaN)).toBe("0:00");
		expect(formatClock(Number.POSITIVE_INFINITY)).toBe("0:00");
		expect(formatClock(Number.NEGATIVE_INFINITY)).toBe("0:00");
	});
});
