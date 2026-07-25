/**
 * The per-turn receipt has to report the turn's length, unambiguously.
 *
 * Once a turn scrolls away there is no record of what it cost, and the wall clock
 * is the number you want when comparing two models or two edit formats on the same
 * prompt. The receipt read the total duration only to divide output tokens by it,
 * so it published a rate and never the time behind it: you could see `59.3/s` and
 * still not know whether the turn took four seconds or forty.
 *
 * Worse, the ONE time value the row did show was time-to-first-token wearing the
 * clock icon, with nothing to say so. A reader seeing `◷ 0.8s` next to a long turn
 * would read it as the turn's length and be wrong by an order of magnitude. The
 * clock now means the turn's length, matching the status line's `time_spent`
 * segment so the two surfaces speak one dialect, and TTFT carries its own label.
 *
 * Assertions here read the rendered row with styling stripped and check exact
 * values, not shape: a receipt that renders plausible-looking numbers that are the
 * wrong ones is the failure mode this whole row exists to fix.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { Usage } from "@veyyon/ai";
import { createUsageRowBlock } from "@veyyon/coding-agent/modes/components/usage-row";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function usage(over: Partial<Usage> = {}): Usage {
	return { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, ...over } as Usage;
}

/** The rendered row, styling removed, whitespace collapsed. */
function row(u: Usage, durationMs?: number, ttftMs?: number): string {
	return createUsageRowBlock(u, durationMs, ttftMs)
		.render(120)
		.map(line => line.replace(/\x1b\[[0-9;]*m/g, ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

describe("the turn's wall clock", () => {
	it("reports seconds to a tenth, the same way the status line does", () => {
		expect(row(usage(), 14_200)).toContain("14.2s");
	});

	/** A turn over a minute is the case the raw-seconds form reads worst: `84.0s`
	 * makes the reader do the division. `formatDuration` is the one owner of that
	 * choice, and the status line already uses it. */
	it("reports a minutes-long turn in minutes and seconds", () => {
		expect(row(usage(), 84_000)).toContain("1m24s");
	});

	it("reports a sub-second turn in milliseconds rather than 0.0s", () => {
		const text = row(usage(), 420);

		expect(text).toContain("420ms");
		expect(text).not.toContain("0.0s");
	});

	/** No duration means no claim about one. Printing `0ms`, which is what
	 * `formatDuration` returns for a missing value, would assert a measurement
	 * nobody took. */
	it("is absent when the turn reported no duration", () => {
		const text = row(usage(), undefined);

		expect(text).not.toContain("0ms");
		expect(text).not.toContain("s ");
	});

	it("is absent when the reported duration is zero", () => {
		expect(row(usage(), 0)).not.toContain("0ms");
	});
});

describe("time to first token", () => {
	/** The bug this fixes: TTFT and the turn length are different quantities, and
	 * TTFT alone under a clock icon read as the turn length. */
	it("is labelled, so it cannot be mistaken for the turn's length", () => {
		expect(row(usage(), 14_200, 800)).toContain("ttft 0.8s");
	});

	it("sits alongside the wall clock, both readable at once", () => {
		const text = row(usage(), 14_200, 800);

		expect(text).toContain("14.2s");
		expect(text).toContain("ttft 0.8s");
	});

	it("is absent when the turn reported none", () => {
		expect(row(usage(), 14_200)).not.toContain("ttft");
	});
});

describe("what the receipt spends", () => {
	/** Cache writes are billed as input, so a row that showed `input` alone
	 * understated the turn. This pins the sum rather than the raw field. */
	it("counts cache writes as input", () => {
		expect(row(usage({ input: 1000, cacheWrite: 12_000 }), 1000)).toContain("13K");
	});

	it("reports output tokens", () => {
		expect(row(usage({ output: 842 }), 1000)).toContain("842");
	});

	it("reports cache reads only when there were any", () => {
		expect(row(usage({ cacheRead: 24_000 }), 1000)).toContain("24K");
		expect(row(usage({ cacheRead: 0 }), 1000).match(/\d/g)?.length).toBeGreaterThan(0);
	});
});

describe("the throughput figure", () => {
	it("is output tokens over the whole request, to a tenth", () => {
		// 500 tokens in 10s = 50.0/s
		expect(row(usage({ output: 500 }), 10_000)).toContain("50.0/s");
	});

	/** Under a tenth of a second the rate is an artifact of the clock, not a
	 * measurement: a cached reply yields absurd figures. */
	it("is suppressed for a turn too short to measure", () => {
		expect(row(usage({ output: 500 }), 50)).not.toContain("/s");
	});

	it("is suppressed when the turn produced no output tokens", () => {
		expect(row(usage({ output: 0 }), 10_000)).not.toContain("/s");
	});
});
