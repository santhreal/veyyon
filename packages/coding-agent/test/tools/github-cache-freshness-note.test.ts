import { describe, expect, it } from "bun:test";
import { formatFreshnessNote } from "@veyyon/coding-agent/tools/github-cache";

/**
 * formatFreshnessNote turns a GitHub cache status plus a fetch timestamp into the
 * one-line freshness banner shown to the agent. It takes `now` as an injectable
 * parameter, so its output is fully deterministic and was worth pinning; it had no
 * test. Contracts:
 *   - "miss" and "refreshed" both read "Fetched live" (the content is current);
 *   - "disabled" reads "Cache disabled; fetched live";
 *   - "fresh" reads "Cached: <age>" and "stale" reads a WARNING with the same age
 *     humanization;
 *   - age is clamped at zero (a future timestamp never shows negative), then
 *     humanized in three tiers: seconds under 60, whole minutes under an hour,
 *     whole hours otherwise, each rounded.
 * A regression would mislabel live vs cached content or emit a negative/oddly
 * rounded age. The 3599s -> "60m ago" boundary is pinned as current behavior (the
 * minute tier runs right up to 3600s) so any switch to "1h ago" is a deliberate diff.
 */

const NOW = 1_000_000_000_000;

describe("formatFreshnessNote status labels", () => {
	it("reports live fetches for miss and refreshed", () => {
		expect(formatFreshnessNote("miss", 0, NOW)).toBe("Fetched live");
		expect(formatFreshnessNote("refreshed", 0, NOW)).toBe("Fetched live");
	});

	it("reports a disabled cache distinctly", () => {
		expect(formatFreshnessNote("disabled", 0, NOW)).toBe("Cache disabled; fetched live");
	});

	it("prefixes fresh content with 'Cached:' and stale content with a WARNING", () => {
		expect(formatFreshnessNote("fresh", NOW - 5_000, NOW)).toBe("Cached: 5s ago");
		expect(formatFreshnessNote("stale", NOW - 7_200_000, NOW)).toBe(
			"WARNING: showing cached content from 2h ago; live refresh failed or is still running",
		);
	});
});

describe("formatFreshnessNote age humanization", () => {
	it("uses seconds under a minute", () => {
		expect(formatFreshnessNote("fresh", NOW - 5_000, NOW)).toBe("Cached: 5s ago");
		expect(formatFreshnessNote("fresh", NOW - 59_000, NOW)).toBe("Cached: 59s ago");
	});

	it("uses rounded minutes from 60s up to just under an hour", () => {
		expect(formatFreshnessNote("fresh", NOW - 90_000, NOW)).toBe("Cached: 2m ago");
		// 3599s stays in the minute tier and rounds to 60m, not 1h — pinned as-is.
		expect(formatFreshnessNote("fresh", NOW - 3_599_000, NOW)).toBe("Cached: 60m ago");
	});

	it("uses rounded hours at and beyond an hour", () => {
		expect(formatFreshnessNote("fresh", NOW - 3_600_000, NOW)).toBe("Cached: 1h ago");
		expect(formatFreshnessNote("fresh", NOW - 7_200_000, NOW)).toBe("Cached: 2h ago");
	});

	it("clamps a future timestamp to a zero-second age", () => {
		expect(formatFreshnessNote("fresh", NOW + 5_000, NOW)).toBe("Cached: 0s ago");
	});
});
