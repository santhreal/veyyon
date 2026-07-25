/**
 * `describeMissingClickTarget`: why a click found nothing to click.
 *
 * WHY THIS SUITE EXISTS. Clicking by selector examines every matched element and keeps the ones it
 * can see. An element leaves that list two ways, and they mean opposite things. It can be genuinely
 * unclickable, which is a page or a selector problem you fix by looking at the page. Or the PROBE
 * can throw: probing means evaluating in the page, and that throws when the node was detached
 * between the query and the check, which is routine on anything that re-renders. The element was
 * there; the check lost a race.
 *
 * The second case used to be swallowed by a `catch { }` with no body and no comment, the only
 * unexplained silent catch left in the tree, and the timeout then reported `no-visible-candidate`
 * for it. That is a wrong answer, not a vague one: it sends you to inspect CSS and stacking contexts
 * for an element that was on screen the whole time, while the actual cause is a re-render you would
 * fix by waiting for the page to settle or by selecting something stable.
 *
 * So the two are now distinguished and counted, and the message names the first probe error. This
 * suite pins those strings, because they are the entire product of the diagnosis: a reader who is
 * already stuck is the only person who ever sees them.
 */

import { describe, expect, it } from "bun:test";
import { describeMissingClickTarget } from "../../../src/tools/browser/tab-worker";

describe("nothing matched the selector", () => {
	/** No matches at all is a different message from matches that could not be used. */
	it("says no-matches", () => {
		expect(describeMissingClickTarget({ probed: 0, probeFailures: 0, firstProbeError: null })).toBe("no-matches");
	});
});

describe("everything matched was examined successfully", () => {
	/**
	 * The honest use of the old wording: every candidate was probed, none threw, and none was
	 * visible. This is the case where inspecting the page IS the right next step.
	 */
	it("says no-visible-candidate when no probe failed", () => {
		expect(describeMissingClickTarget({ probed: 4, probeFailures: 0, firstProbeError: null })).toBe(
			"no-visible-candidate",
		);
	});
});

describe("probes failed", () => {
	/**
	 * The case the silent catch hid, in its purest form: every match was dropped by a throwing probe,
	 * so nothing was ever judged for visibility and "no visible candidate" is a claim the code is not
	 * entitled to make. The counts and the underlying error both appear.
	 */
	it("says every probe failed, with the count and the first error", () => {
		expect(
			describeMissingClickTarget({
				probed: 3,
				probeFailures: 3,
				firstProbeError: "Execution context was destroyed, most likely because of a navigation",
			}),
		).toBe(
			"every candidate probe failed (3 of 3): Execution context was destroyed, most likely because of a navigation",
		);
	});

	/** One match, one failure: the same message, and it must not read as a plural or a fraction of nothing. */
	it("handles a single match whose probe failed", () => {
		expect(describeMissingClickTarget({ probed: 1, probeFailures: 1, firstProbeError: "detached" })).toBe(
			"every candidate probe failed (1 of 1): detached",
		);
	});

	/**
	 * The mixed case, which is the common one on a page that re-renders part of itself: some elements
	 * really were invisible AND some probes threw. Both facts are reported, because suppressing either
	 * one leaves the reader with half a cause.
	 */
	it("reports both causes when some probes failed and the rest were invisible", () => {
		expect(describeMissingClickTarget({ probed: 5, probeFailures: 2, firstProbeError: "detached Node" })).toBe(
			"no-visible-candidate, and 2 of 5 probes failed: detached Node",
		);
	});

	/**
	 * A probe can fail with a value that carries no message. The count still has to survive, since the
	 * count alone is what distinguishes a race from an invisible element.
	 */
	it("keeps the counts when the error carried no message", () => {
		expect(describeMissingClickTarget({ probed: 2, probeFailures: 2, firstProbeError: null })).toBe(
			"every candidate probe failed (2 of 2)",
		);
		expect(describeMissingClickTarget({ probed: 4, probeFailures: 1, firstProbeError: null })).toBe(
			"no-visible-candidate, and 1 of 4 probes failed",
		);
	});
});

describe("what the message never does", () => {
	/**
	 * The regression this exists to prevent. Whenever a probe failed, the message must not be the bare
	 * `no-visible-candidate` string the old code returned for every case, because that is the exact
	 * wrong answer: it asserts the elements were examined and found invisible when they were not
	 * examined at all.
	 */
	it("never reports a bare no-visible-candidate when a probe failed", () => {
		for (const probed of [1, 2, 7]) {
			for (let probeFailures = 1; probeFailures <= probed; probeFailures++) {
				const message = describeMissingClickTarget({ probed, probeFailures, firstProbeError: "boom" });

				expect(message).not.toBe("no-visible-candidate");
				expect(message).toContain(String(probeFailures));
			}
		}
	});

	/** And it never claims a probe failed when none did, which would send a reader chasing a race that never happened. */
	it("never mentions probes when none failed", () => {
		for (const probed of [0, 1, 9]) {
			expect(describeMissingClickTarget({ probed, probeFailures: 0, firstProbeError: null })).not.toContain("probe");
		}
	});
});
