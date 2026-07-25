/**
 * The cache-invalidation report, pinned.
 *
 * WHY THIS SUITE EXISTS. Five turns of a real trace re-read 46-72k tokens each
 * as fresh input because the system prompt changed mid-session, roughly 8% of
 * that run's bill. Two explanations were proposed and both were wrong (provider
 * cache TTL expiry, duplicated tool docs), because there was no evidence to
 * check them against. This report is that evidence, so the failure mode it must
 * never have is reporting a number it cannot stand behind.
 */

import { describe, expect, test } from "bun:test";
import { type ArmResult, emptyArmResult, renderPromptCacheInvalidationSection } from "./aggregate";

function row(arm: string, invalidations: string[] | null): ArmResult {
	return { ...emptyArmResult(arm, "task", 0), promptCacheInvalidations: invalidations };
}

describe("renderPromptCacheInvalidationSection", () => {
	/**
	 * The attribution itself: counts per cause, ordered by how much damage each
	 * one did. Without the breakdown the report says only "the cache died four
	 * times", which is the uninformative state this replaced.
	 */
	test("breaks invalidations down by cause, most frequent first", () => {
		const out = renderPromptCacheInvalidationSection(
			[row("full", ["hindsight:MM TTL reload", "argot-arm", "hindsight:MM TTL reload"])],
			["full"],
		);
		expect(out).toContain("hindsight:MM TTL reload x2, argot-arm x1");
	});

	/**
	 * Zero is a real, good answer and must be legible as one: the prompt never
	 * changed and the provider served the whole prefix from cache. Rendering it
	 * the same as "we did not measure" would hide the best outcome the system can
	 * produce.
	 */
	test("reports a clean arm as zero rather than as unmeasured", () => {
		const out = renderPromptCacheInvalidationSection([row("decode", [])], ["decode"]);
		expect(out).toContain("| decode | 0 | 0.0 | none |");
		expect(out).not.toContain("Not recorded");
	});

	/**
	 * A run recorded before the instrumentation existed carries `null`, which is
	 * NOT zero. Printing it as zero would claim a run had a perfectly cached
	 * session when nobody ever looked, and that claim would be indistinguishable
	 * from the real thing.
	 */
	test("withholds the table for runs that predate the instrumentation", () => {
		const out = renderPromptCacheInvalidationSection([row("old", null)], ["old"]);
		expect(out).toContain("Not recorded for this run");
		expect(out).not.toContain("| old |");
	});

	/**
	 * The per-run average is what makes arms comparable when they have different
	 * sample counts, so it divides by runs rather than by invalidations.
	 */
	test("averages over runs, not over invalidations", () => {
		const out = renderPromptCacheInvalidationSection(
			[row("full", ["argot-arm", "argot-arm"]), row("full", []), row("full", ["argot-arm"])],
			["full"],
		);
		expect(out).toContain("| full | 3 | 1.0 |");
	});

	/**
	 * Errored runs are excluded, because a run that died early invalidated fewer
	 * caches for a reason that has nothing to do with the arm, and averaging it in
	 * would make a broken arm look cheap.
	 */
	test("ignores errored runs", () => {
		const errored = { ...row("full", ["argot-arm"]), error: "container died" };
		const out = renderPromptCacheInvalidationSection([row("full", ["argot-arm", "argot-arm"]), errored], ["full"]);
		expect(out).toContain("| full | 2 | 2.0 |");
	});
});
