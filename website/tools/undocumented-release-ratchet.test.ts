/**
 * A published release the changelog does not describe fails the build.
 *
 * WHY THIS SUITE EXISTS. The generator already reconciled the CHANGELOG against
 * the published GitHub releases and already noticed the gap. It printed a
 * warning and exited 0, so every build reported the problem and shipped anyway,
 * and the gap grew until a user could install eight versions the changelog said
 * nothing about. That is what "600 commits and it mentions almost nothing"
 * looked like from the outside, reported 2026-07-25. A check nothing acts on is
 * not a check.
 *
 * The fix is a RATCHET rather than a flat "fail on any gap", and the shape is
 * the point:
 *
 *  - Flat failure would break the site deploy today over a backlog that predates
 *    the gate, so the first person to hit it would disable it.
 *  - A blanket `--allow-undocumented-releases` flag would be passed in CI once
 *    and then ignored exactly the way the warning was.
 *  - A named list of grandfathered versions can only shrink. Today's eight pass;
 *    a ninth fails immediately, on the build that introduced it, naming it.
 *
 * The list is therefore load-bearing and these tests defend it in both
 * directions: an unlisted gap must fail, and the listed ones must NOT silently
 * become a permanent excuse — when one is backfilled the generator says so, so
 * the list gets tightened instead of ossifying.
 */
import { describe, expect, it } from "bun:test";
// @ts-expect-error — plain .mjs module, no types; imported for its exports.
import { reportUndocumentedReleases, UNDOCUMENTED_RELEASE_BASELINE } from "./gen-changelog.mjs";

/** The reconciliation's shape: unmatched published releases carry a version. */
function unmatched(...versions: string[]): Array<{ version: string }> {
	return versions.map(version => ({ version }));
}

describe("undocumented release ratchet", () => {
	it("fails on a published release that is not in the baseline", () => {
		// The defect this exists to catch: a release cut without a changelog entry.
		// It must fail on the build that introduces it, not accumulate.
		expect(() => reportUndocumentedReleases(unmatched("1.1.0"), ["1.0.21"])).toThrow(/v1\.1\.0/);
	});

	it("names every unlisted release, not just the first", () => {
		// A message naming one of three sends the author back around the loop
		// twice for no reason.
		let message = "";
		try {
			reportUndocumentedReleases(unmatched("1.1.0", "1.0.21", "1.2.0"), ["1.0.21"]);
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toContain("v1.1.0");
		expect(message).toContain("v1.2.0");
		expect(message).not.toContain("v1.0.21");
		expect(message).toContain("2 published GitHub release(s)");
	});

	it("tells the author NOT to park the new gap in the baseline", () => {
		// The obvious way to make this error go away is to append to the list,
		// which would turn a shrinking record of old debt into a growing excuse.
		// The message has to close that door explicitly.
		expect(() => reportUndocumentedReleases(unmatched("1.1.0"), [])).toThrow(
			/do not add it to UNDOCUMENTED_RELEASE_BASELINE/,
		);
	});

	it("passes when every gap is grandfathered", () => {
		// Today's state. The deploy keeps working while the debt is visible.
		expect(() => reportUndocumentedReleases(unmatched("1.0.21", "1.0.22"), ["1.0.21", "1.0.22"])).not.toThrow();
	});

	it("passes when there is no gap at all", () => {
		expect(() => reportUndocumentedReleases([], ["1.0.21"])).not.toThrow();
	});

	it("ships a baseline that matches the real gap, with no stale entries", () => {
		// A baseline listing versions that are already documented would quietly
		// widen the allowance: the next real gap could reuse one of those numbers
		// and pass. Pinning the exact contents means backfilling forces an edit
		// here, which is the tightening step.
		expect([...UNDOCUMENTED_RELEASE_BASELINE]).toEqual([
			"1.0.36",
			"1.0.27",
			"1.0.26",
			"1.0.25",
			"1.0.24",
			"1.0.23",
			"1.0.22",
			"1.0.21",
		]);
	});

	it("is frozen, so nothing can widen the allowance at runtime", () => {
		expect(Object.isFrozen(UNDOCUMENTED_RELEASE_BASELINE)).toBe(true);
	});

	it("defaults to the shipped baseline when none is passed", () => {
		// The generator calls it with one argument. If the default were empty the
		// gate would fail the deploy today; if it were permissive it would fail
		// nothing.
		expect(() => reportUndocumentedReleases(unmatched("1.0.21"))).not.toThrow();
		expect(() => reportUndocumentedReleases(unmatched("9.9.9"))).toThrow(/v9\.9\.9/);
	});
});
