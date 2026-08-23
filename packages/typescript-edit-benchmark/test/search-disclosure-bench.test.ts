import { describe, expect, it } from "bun:test";
import { inlineCapForTurn } from "@veyyon/coding-agent/session/streaming-output";
import { BROAD_SEARCH_INLINE_MAX_BYTES } from "@veyyon/coding-agent/tools/text-search";
import { formatSearchDisclosureBenchmark, runSearchDisclosureBenchmark } from "../src/search-disclosure-bench";

/**
 * WHY: broad search output is paid again on every later model turn. This benchmark
 * drives the production SearchTool twice over one deterministic corpus: once
 * without artifact storage to recover the full pre-disclosure body, and once with
 * production artifact recovery enabled. It closes output inflation and lossy
 * compaction; it does not measure provider-side tool selection or tokenization.
 */
describe("unified search progressive disclosure benchmark", () => {
	it("reduces early-turn inline bytes while recovering the exact full result", async () => {
		const report = await runSearchDisclosureBenchmark();

		expect(report.fileCount).toBe(20);
		expect(report.matchCount).toBe(160);
		expect(report.exactRecovery).toBe(true);
		expect(report.artifactBytes).toBe(report.fullInlineBytes);
		expect(report.compactInlineBytes).toBeLessThanOrEqual(inlineCapForTurn(BROAD_SEARCH_INLINE_MAX_BYTES, 0));
		expect(report.compactInlineBytes).toBeLessThan(report.fullInlineBytes);
		expect(report.inlineReductionPercent).toBeGreaterThan(50);
		expect(report.estimatedByteTurnsAvoided).toBe(report.inlineReductionBytes * report.assumedLaterTurns);
		expect(report.estimatedTokensAvoided).toBeGreaterThan(0);

		const summary = formatSearchDisclosureBenchmark(report);
		expect(summary).toContain("Recovered artifact:");
		expect(summary).toContain("exact");
		expect(summary).toContain("Est. byte-turns avoided:");
		expect(summary).toContain("Est. tokens avoided:");
	});
});
