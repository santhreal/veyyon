/**
 * The release gate's decision, including the case where a previous cut was stranded.
 *
 * WHY THIS SUITE EXISTS. The gate governs every release, so each branch is pinned by name rather than
 * covered in aggregate. The failure it recovers from happened live: `release.ts` moves
 * `## [Unreleased]` into the new version's section AT CUT TIME, before CI publishes, so a cut whose CI
 * then fails leaves a tag with no GitHub release and an empty `## [Unreleased]`. The gate then reported
 * "nothing to release" on every subsequent push, and `v1.0.33` and `v1.0.34` sat unpublished while the
 * installable version stayed at `v1.0.27`.
 *
 * A recovery that can bump a version is dangerous in a different direction, so both bounds are asserted
 * as hard as the recovery itself: a re-cut requires main to have MOVED past the failed tag, and two
 * stranded tags stop the gate and ask for a person. The in-progress and success cases are pinned too,
 * because cutting over a run that has not finished, or over one that succeeded, would create the very
 * silent tag this is about.
 */

import { describe, expect, it } from "bun:test";
import { type CiConclusion, decideReleaseGate, MAX_STRANDED_TAGS, type SilentTag } from "./release-gate-decision.ts";

const MAIN = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OLDER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function tag(name: string, conclusion: CiConclusion, sha = OLDER): SilentTag {
	return { tag: name, sha, conclusion };
}

function decide(options: { bullets?: boolean; silentTags?: SilentTag[]; mainHeadSha?: string } = {}) {
	return decideReleaseGate({
		hasUnreleasedBullets: options.bullets ?? false,
		silentTags: options.silentTags ?? [],
		mainHeadSha: options.mainHeadSha ?? MAIN,
	});
}

describe("the ordinary path", () => {
	/**
	 * Unchanged, and checked first. Everything else in this file only runs when the changelog says there
	 * is nothing to ship, so a bug in the stranded-tag logic cannot suppress a normal release.
	 */
	it("cuts when a publishable package has an Unreleased bullet", () => {
		const decision = decide({ bullets: true });

		expect(decision.cut).toBe(true);
		expect(decision.needsAttention).toBe(false);
		expect(decision.reason).toContain("Unreleased changelog bullet");
	});

	it("cuts on a waiting bullet even while a tag is unpublished, rather than stopping to reason about it", () => {
		// The bullet is newer work than the stranded tag, and cutting ships both: the release-notes
		// script rolls the silent tag's sections into the new release.
		const decision = decide({ bullets: true, silentTags: [tag("v1.0.34", "failure")] });

		expect(decision.cut).toBe(true);
		expect(decision.needsAttention).toBe(false);
	});

	it("does not cut when nothing is unreleased and every tag is published", () => {
		const decision = decide();

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(false);
		expect(decision.reason).toContain("no unpublished tag");
	});
});

describe("one stranded tag", () => {
	/**
	 * THE recovery. The changelog is empty because the failed cut consumed it, so the only evidence that
	 * work is waiting is the tag itself.
	 */
	it("re-cuts when its CI failed and main has moved since", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", "failure")] });

		expect(decision.cut).toBe(true);
		expect(decision.needsAttention).toBe(false);
		expect(decision.reason).toContain("v1.0.34");
		expect(decision.reason).toContain("re-cutting");
	});

	it("re-cuts for a cancelled run, which also published nothing", () => {
		expect(decide({ silentTags: [tag("v1.0.34", "cancelled")] }).cut).toBe(true);
	});

	it("re-cuts for a timed-out run, for the same reason", () => {
		expect(decide({ silentTags: [tag("v1.0.34", "timed_out")] }).cut).toBe(true);
	});

	/**
	 * BOUND ONE. Cutting the same tree again fails the same way, so a re-cut is only recovery when main
	 * carries something the failed tag did not. Without this, a persistent failure would bump a version
	 * on every gate entry.
	 */
	it("refuses when the failed tag IS main HEAD, because the tree has not changed", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", "failure", MAIN)] });

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(true);
		expect(decision.reason).toContain("same tree");
	});

	/** A run still going may yet publish. Cutting over it would create a second silent tag by hand. */
	it("waits while its CI is still running", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", null)] });

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(false);
		expect(decision.reason).toContain("still running");
	});

	/**
	 * A green run with no release is a different bug: the publish step reported success without creating
	 * the release. A new version would bury the evidence, so this is reported and left alone.
	 */
	it("reports a successful run with no release instead of cutting over it", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", "success")] });

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(true);
		expect(decision.reason).toContain("without creating the release");
	});

	it("treats a skipped run as successful for this purpose, so it does not cut over it", () => {
		// `skipped` and `neutral` are not failures. Neither published anything, but neither is evidence
		// that a re-cut would help, and guessing here is how a version-inflation loop starts.
		expect(decide({ silentTags: [tag("v1.0.34", "skipped")] }).cut).toBe(false);
		expect(decide({ silentTags: [tag("v1.0.34", "neutral")] }).cut).toBe(false);
	});
});

describe("two stranded tags", () => {
	/**
	 * BOUND TWO, and the exact incident: `v1.0.33` and `v1.0.34` both cut, both failed on the same source
	 * lock. A third tag would have failed identically. The gate stops and says so.
	 */
	it("refuses to cut a third and asks for a person", () => {
		const decision = decide({ silentTags: [tag("v1.0.34", "failure"), tag("v1.0.33", "failure")] });

		expect(decision.cut).toBe(false);
		expect(decision.needsAttention).toBe(true);
		expect(decision.reason).toContain("v1.0.34");
		expect(decision.reason).toContain("v1.0.33");
		expect(decision.reason).toContain("re-run the release workflow by hand");
	});

	it("refuses regardless of what the newest run concluded, because the count is the signal", () => {
		for (const conclusion of ["failure", "success", null] as CiConclusion[]) {
			expect(decide({ silentTags: [tag("v1.0.35", conclusion), tag("v1.0.34", "failure")] }).cut).toBe(false);
		}
	});

	it("still cuts a genuinely new Unreleased bullet, so the bound does not freeze ordinary releasing", () => {
		// The bound stops the gate from inventing versions. It must not stop a human's new work from
		// shipping, or one bad cut would freeze the release train until someone noticed.
		const decision = decide({ bullets: true, silentTags: [tag("v1.0.34", "failure"), tag("v1.0.33", "failure")] });

		expect(decision.cut).toBe(true);
	});

	it("uses the documented bound rather than a literal 2 in the branch", () => {
		// Pins the constant to the behaviour: a list one short of the bound recovers, a list at the bound
		// refuses. If someone raises MAX_STRANDED_TAGS, this test follows them instead of going stale.
		const belowBound = Array.from({ length: MAX_STRANDED_TAGS - 1 }, (_, i) => tag(`v1.0.${40 + i}`, "failure"));
		const atBound = Array.from({ length: MAX_STRANDED_TAGS }, (_, i) => tag(`v1.0.${40 + i}`, "failure"));

		expect(decide({ silentTags: belowBound }).cut).toBe(true);
		expect(decide({ silentTags: atBound }).cut).toBe(false);
	});
});

describe("every refusal", () => {
	/**
	 * A refusal that a person needs to act on must be distinguishable from "nothing to release", because
	 * the incident was precisely a gate reporting the second while the first was true.
	 */
	it("carries a reason, and only the ones needing action are flagged", () => {
		const cases: Array<{ decision: ReturnType<typeof decide>; attention: boolean }> = [
			{ decision: decide(), attention: false },
			{ decision: decide({ silentTags: [tag("v1.0.34", null)] }), attention: false },
			{ decision: decide({ silentTags: [tag("v1.0.34", "success")] }), attention: true },
			{ decision: decide({ silentTags: [tag("v1.0.34", "failure", MAIN)] }), attention: true },
			{ decision: decide({ silentTags: [tag("v1.0.34", "failure"), tag("v1.0.33", "failure")] }), attention: true },
		];

		for (const { decision, attention } of cases) {
			expect(decision.cut).toBe(false);
			expect(decision.reason.length).toBeGreaterThan(20);
			expect(decision.needsAttention).toBe(attention);
		}
	});
});
