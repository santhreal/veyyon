/**
 * The forced launch tip has ONE owner, and reading it clears it.
 *
 * WHY THIS SUITE EXISTS. The forced-tip state used to live inside `welcome.ts` next to the component that
 * renders it, which is the obvious home until you notice who WRITES it: `main.ts`, during startup, before
 * any mode is chosen. Importing the welcome component for two functions put a `modes/components` module --
 * and `@veyyon/tui`, the theme, the shimmer machinery and the tips corpus behind it -- into the static
 * boot graph of every launch, including `-p`, `--rpc` and ACP runs that never draw a welcome card. The
 * state and the message moved to `launch-tip.ts`, which imports one constant.
 *
 * Splitting a module-level variable out is where a second copy gets created by accident, and a second copy
 * fails in the quietest possible way: `main.ts` sets the tip in one module and the component reads
 * `undefined` from the other, so the post-update announcement simply never appears and nothing
 * distinguishes that from a launch with no update. So this suite asserts the two modules are the same
 * owner, through the `welcome.ts` re-export that existing callers still use.
 *
 * The read-and-clear rule is the other half. `takeLaunchTip` exists as one operation because a caller that
 * read without clearing would turn a one-time announcement into the only tip the process ever shows again
 * -- the failure `post-update-tip.test.ts` covers from the component's side, pinned here at the owner.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	clearLaunchTip,
	setLaunchTip,
	takeLaunchTip,
	updateInstalledTip,
} from "@veyyon/coding-agent/modes/components/launch-tip";
import * as welcome from "@veyyon/coding-agent/modes/components/welcome";

afterEach(() => {
	clearLaunchTip();
});

describe("the launch tip owner", () => {
	/** Nothing pending is the ordinary case, and it must read as absent rather than as an empty string. */
	it("reports no tip when none was set", () => {
		expect(takeLaunchTip()).toBeUndefined();
	});

	/** The round trip: what was set is what comes back, byte for byte. */
	it("returns exactly the tip that was set", () => {
		setLaunchTip("Updated to Veyyon 9.9.9 · /changelog");

		expect(takeLaunchTip()).toBe("Updated to Veyyon 9.9.9 · /changelog");
	});

	/**
	 * Read-and-clear, in one call. This is the assertion that fails if `takeLaunchTip` is ever "simplified"
	 * into a plain getter: the second read must be empty, or every later welcome in the process repeats a
	 * stale announcement.
	 */
	it("clears the tip as it reads it", () => {
		setLaunchTip("one shot");

		expect(takeLaunchTip()).toBe("one shot");
		expect(takeLaunchTip()).toBeUndefined();
	});

	/** A later set wins: the tip describes this launch, so the newest write is the one that matters. */
	it("keeps only the most recent tip", () => {
		setLaunchTip("first");
		setLaunchTip("second");

		expect(takeLaunchTip()).toBe("second");
	});

	/** `clearLaunchTip` exists so a test cannot leak a tip into the next one; prove it actually does that. */
	it("drops a pending tip on clear", () => {
		setLaunchTip("should not survive");
		clearLaunchTip();

		expect(takeLaunchTip()).toBeUndefined();
	});
});

describe("the welcome component's view of the launch tip", () => {
	/**
	 * ONE owner, reached two ways. `welcome.ts` re-exports the setters so callers that already import from
	 * the component keep working, and those re-exports must be the SAME functions -- a second copy of the
	 * state would satisfy every test above while silently breaking the one path that matters, `main.ts`
	 * writing where the component reads.
	 */
	it("re-exports the same functions rather than a second copy of the state", () => {
		expect(welcome.setLaunchTip).toBe(setLaunchTip);
		expect(welcome.clearLaunchTip).toBe(clearLaunchTip);
		expect(welcome.updateInstalledTip).toBe(updateInstalledTip);
	});

	/**
	 * And a tip set through the component's re-export is visible to the owner. This is the actual
	 * cross-module path in production, written the way `main.ts` writes it.
	 */
	it("shares the pending tip across both import paths", () => {
		welcome.setLaunchTip(updateInstalledTip("1.4.0"));

		expect(takeLaunchTip()).toContain("1.4.0");
	});
});
