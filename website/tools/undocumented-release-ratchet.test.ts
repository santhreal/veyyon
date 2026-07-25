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

	it("ships an empty baseline, so the gate is unconditional", () => {
		// The backfill landed on 2026-07-25: `## [1.0.0]` through `## [1.0.36]` were
		// reconstructed from git history, which documented all eight grandfathered
		// versions and emptied the list. Every published release now needs an entry.
		//
		// Pinned exactly, and this is the assertion that must not be relaxed: a
		// baseline listing a documented version would quietly widen the allowance,
		// because the next real gap could reuse that number and pass. An empty list
		// leaves no number to reuse. Adding one back is a regression even when the
		// version named is genuinely undocumented; the fix is the entry, not the
		// exemption.
		expect([...UNDOCUMENTED_RELEASE_BASELINE]).toEqual([]);
	});

	it("is frozen, so nothing can widen the allowance at runtime", () => {
		expect(Object.isFrozen(UNDOCUMENTED_RELEASE_BASELINE)).toBe(true);
	});

	it("excuses nothing when no baseline is passed", () => {
		// The generator calls it with one argument, so the default decides what the
		// site deploy tolerates. It is the shipped baseline, which is now empty, so
		// every undocumented release fails including the eight that used to be
		// grandfathered. A permissive default would fail nothing and the gate would
		// be decoration again.
		expect(() => reportUndocumentedReleases(unmatched("1.0.21"))).toThrow(/v1\.0\.21/);
		expect(() => reportUndocumentedReleases(unmatched("1.0.36"))).toThrow(/v1\.0\.36/);
		expect(() => reportUndocumentedReleases(unmatched("9.9.9"))).toThrow(/v9\.9\.9/);
	});

	it("still passes when every published release is documented", () => {
		expect(() => reportUndocumentedReleases([])).not.toThrow();
	});
});
