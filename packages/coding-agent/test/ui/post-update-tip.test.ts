/**
 * The post-update hint: one line, in the tip slot, exactly once.
 *
 * It replaced a transcript block that announced the same thing above the welcome
 * card. Two failure modes come with moving it, and both are quiet:
 *
 *   - It STICKS. A forced tip that is not cleared after reading turns a one-time
 *     announcement into the only tip you ever see again, because every later
 *     welcome in the process reads the same variable.
 *   - It VANISHES. A forced tip that loses to the random pick shows nothing at
 *     all on the one launch it was written for, and nothing distinguishes that
 *     from a launch where no update happened.
 *
 * The wording is asserted for its three parts (version, notes, controls) rather
 * than as one exact string, so the sentence can be tuned without the suite
 * turning into a copy of it — but each part is required, because dropping the
 * controls half is exactly the omission that made updates feel like something
 * done to the user rather than something they configure.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	clearLaunchTip,
	setLaunchTip,
	updateInstalledTip,
	WelcomeComponent,
} from "@veyyon/coding-agent/modes/components/welcome";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

// The tip getter consults the theme for its symbol preset, so a bare component
// needs a real theme before it can be asked for one.
beforeAll(async () => {
	await initTheme(false);
});

afterEach(() => {
	clearLaunchTip();
});

function welcome(): WelcomeComponent {
	return new WelcomeComponent("1.4.0", "test-model", "test-provider");
}

describe("updateInstalledTip", () => {
	it("names the version that is now running", () => {
		// The number here is the one that belongs in a bug report, so it must be
		// the installed version rather than a generic "you were updated".
		expect(updateInstalledTip("1.4.0")).toContain("1.4.0");
	});

	it("points at the release notes", () => {
		expect(updateInstalledTip("1.4.0")).toContain("/changelog");
	});

	it("says the behavior is controllable, which nothing said before", () => {
		// `startup.autoUpdate` has existed and been wired the whole time; the reason
		// updates felt imposed is that no surface ever mentioned it.
		const tip = updateInstalledTip("1.4.0");

		expect(tip).toContain("/settings");
		expect(tip).toContain("auto-update");
	});

	it("offers the way back, not only the way forward", () => {
		expect(updateInstalledTip("1.4.0")).toContain("roll back");
	});

	it("stays one line", () => {
		// The slot wraps rather than truncates, so a multi-line hint pushes the
		// whole welcome card down instead of failing visibly.
		expect(updateInstalledTip("1.4.0")).not.toContain("\n");
	});
});

describe("the forced launch tip", () => {
	it("wins over the random pick on the launch it was set for", () => {
		setLaunchTip(updateInstalledTip("1.4.0"));

		expect(welcome().tip).toBe(updateInstalledTip("1.4.0"));
	});

	it("is not shown again to a later welcome in the same process", () => {
		// `/welcome` and a resumed session both render a fresh component. Repeating
		// "Updated to 1.4.0" there is stale by then.
		setLaunchTip(updateInstalledTip("1.4.0"));
		const first = welcome().tip;
		const second = welcome().tip;

		expect(first).toBe(updateInstalledTip("1.4.0"));
		expect(second).not.toBe(first);
	});

	it("leaves the ordinary rotation alone when nothing forced it", () => {
		// A launch with no update must look exactly like it always did: a real tip
		// from the corpus, not an empty slot.
		const tip = welcome().tip;

		expect(typeof tip).toBe("string");
		expect(tip).not.toContain("Updated to");
	});

	it("is stable across repeated reads of the same component", () => {
		// The getter memoizes; a second read that re-picked would make the card
		// change tip between renders of one frame.
		setLaunchTip(updateInstalledTip("1.4.0"));
		const component = welcome();

		expect(component.tip).toBe(component.tip);
	});

	it("can be cleared without being read", () => {
		setLaunchTip(updateInstalledTip("1.4.0"));
		clearLaunchTip();

		expect(welcome().tip).not.toContain("Updated to");
	});
});
