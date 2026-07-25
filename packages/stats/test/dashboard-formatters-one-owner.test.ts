/**
 * The dashboard's percentages and the CLI's come from ONE formatter.
 *
 * WHY THIS SUITE EXISTS. `formatPercent` existed twice under the same name: once in
 * `@veyyon/utils/format`, which `packages/stats/src/index.ts` (the terminal report) uses, and once
 * as a local copy in `src/client/data/formatters.ts`, which every dashboard route uses. Same name,
 * same one-decimal output, and one disagreement: the copy rendered `NaN%` where the shared owner
 * renders `0.0%`. A rate of 0/0 is not exotic for a dashboard — a project with no requests yet has
 * exactly that error rate — so the CLI and the dashboard could print different things for the same
 * number, and nothing would fail.
 *
 * These tests assert the two are now literally the same function, and pin the whole input range
 * that a rate can arrive with, because "delegates to the shared owner" is only worth asserting if
 * the resulting bytes are also asserted. `formatBytes` is checked the same way: it was already
 * shared, and this suite is where a future re-copy of either would be caught.
 */

import { describe, expect, it } from "bun:test";
import { formatBytes, formatPercent } from "@veyyon/utils/format";
import * as dashboard from "../src/client/data/formatters";

describe("the dashboard's shared formatters", () => {
	it("re-exports the shared percent formatter itself, not a copy of it", () => {
		// Function identity, which is the only assertion a second implementation cannot
		// satisfy no matter how closely it matches the output.
		expect(dashboard.formatPercent).toBe(formatPercent);
	});

	it("re-exports the shared byte formatter itself", () => {
		expect(dashboard.formatBytes).toBe(formatBytes);
	});

	it("renders an ordinary rate with one decimal place", () => {
		expect(dashboard.formatPercent(0)).toBe("0.0%");
		expect(dashboard.formatPercent(0.123)).toBe("12.3%");
		expect(dashboard.formatPercent(0.5)).toBe("50.0%");
		expect(dashboard.formatPercent(1)).toBe("100.0%");
	});

	it("renders a 0/0 rate as 0.0%, which is the case the two copies disagreed on", () => {
		// THE bug. `errors / calls` with no calls is NaN, and a dashboard cell reading
		// `NaN%` is a bug report waiting to happen — while the CLI, already on the shared
		// owner, printed `0.0%` for the same session.
		expect(dashboard.formatPercent(Number.NaN)).toBe("0.0%");
		expect(dashboard.formatPercent(0 / 0)).toBe("0.0%");
	});

	it("renders an infinite rate as 0.0% rather than Infinity%", () => {
		// The other non-finite arrival: a division by a zero denominator that is not
		// itself zero on top.
		expect(dashboard.formatPercent(Number.POSITIVE_INFINITY)).toBe("0.0%");
		expect(dashboard.formatPercent(Number.NEGATIVE_INFINITY)).toBe("0.0%");
	});

	it("does not clamp a rate above one, because that is real data", () => {
		// Cache reads can exceed the request count, and a share can legitimately exceed
		// the whole it is measured against. Clamping would hide a data problem behind a
		// plausible number.
		expect(dashboard.formatPercent(1.5)).toBe("150.0%");
		expect(dashboard.formatPercent(12)).toBe("1200.0%");
	});

	it("keeps a tiny rate visible as a rounded value rather than an empty cell", () => {
		// 0.04% rounds to 0.0%, which reads as "none", and that is the shared owner's
		// documented behaviour rather than an accident — pinned so a change to it is a
		// decision made once, for every surface, instead of drifting per copy again.
		expect(dashboard.formatPercent(0.0004)).toBe("0.0%");
		expect(dashboard.formatPercent(0.0006)).toBe("0.1%");
	});

	it("rounds at the decimal boundary the way the float actually lands", () => {
		// Not a rounding-mode choice: `0.1235 * 100` is 12.349999999999998 in binary
		// floating point, so `toFixed(1)` gives 12.3 and the next representable step up
		// gives 12.4. Pinned as the real bytes rather than the arithmetic one would
		// expect, because a reader comparing two adjacent rows needs to know the boundary
		// is float-exact and not a half-away-from-zero rule someone could "fix".
		expect(dashboard.formatPercent(0.1234)).toBe("12.3%");
		expect(dashboard.formatPercent(0.1235)).toBe("12.3%");
		expect(dashboard.formatPercent(0.1236)).toBe("12.4%");
	});

	it("renders a negative rate with its sign", () => {
		// A delta can be negative. It must not silently become positive.
		expect(dashboard.formatPercent(-0.05)).toBe("-5.0%");
	});
});
