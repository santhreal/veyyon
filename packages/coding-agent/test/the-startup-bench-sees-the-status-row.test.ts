/**
 * The startup bench's `statusrow` marker fires on the row the card paints.
 *
 * WHY THIS SUITE EXISTS. `scripts/bench-startup.ts` reads its arms off the bytes a launch writes,
 * and a marker that matches nothing does not fail: the arm prints `statusrow: no samples` and the
 * table is one line shorter than it was. The marker was the context gauge (`▰` or `% left`), which
 * is the row's LAST segment, so an eighty-column terminal — what the bench's pty gives — sheds it
 * whenever the location, branch and model ahead of it are long enough, and the headline number for
 * the launch card's status row silently stopped being measured.
 *
 * THE CLASS, NOT THE INCIDENT. The defect is not "the gauge was clipped". It is "the bench looks
 * for a string the row need not contain". So the marker now keys on the approval rung, which every
 * preset's row carries between two separator dots, and this suite sweeps every rung in
 * `AUTONOMY_LABEL` at run time against the row `LaunchComposerFoot` actually renders, at the width
 * the bench measures at. A rung added to the ladder, or a rung whose label the row renders
 * differently, turns this red rather than deleting a line from the bench table.
 *
 * WHAT WAS TRIED AGAINST IT. Restoring the gauge marker (`/▰|% left/`) goes red on the
 * eighty-column cases and stays green on the wide ones, which is exactly the asymmetry that hid
 * the defect. Dropping the dot boundaries from the marker stays green, and says what the second
 * half of this suite is for: no line the hero paints today carries a rung word, so the boundaries
 * are what keeps a tip such as "Auto runs every tier unasked" from timing the arm against the tip
 * block instead of the row. The tip sweep is over `TIP_ENTRIES`, so the day such a tip is written
 * the boundary is already held.
 *
 * WHAT IT DOES NOT CATCH. It proves the marker matches the row's bytes, not that the bench spawns
 * a launch that paints one; a card that stopped painting the row entirely is held by
 * `the-card-and-the-live-row-are-one-row.test.ts`. Nor does it see a rung word reaching the screen
 * from somewhere neither the hero nor the tips own — a provider warning, a plugin banner.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import { COMPOSER_INSET_COLS, LaunchComposerFoot } from "@veyyon/coding-agent/modes/terminal/components/composer/composer-chrome";
import { renderWelcomeTip, TIP_ENTRIES, WelcomeComponent } from "@veyyon/coding-agent/modes/terminal/components/dialogs/welcome";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import { AUTONOMY_LABEL, type AutonomyLevel } from "@veyyon/coding-agent/tools/core/approval-modes";
import * as utils from "@veyyon/utils";
import { stripAnsi } from "@veyyon/utils";
import { STATUS_ROW } from "../../../scripts/bench-startup";

/** The pty the bench spawns is eighty columns, which is where the gauge is shed. */
const BENCH_WIDTH = 80;
/** Wide enough that nothing is shed, so a rung that fails at both widths is the label, not the fit. */
const WIDE = 400;
/** The width the hero gives the tip block at the bench's terminal: `min(64, width - 4)`. */
const TIP_WIDTH = Math.min(64, BENCH_WIDTH - 4);

/** A named profile puts the profile chip on the row, which is the longer of the two rows. */
const ACTIVE_PROFILE = "work";
/** Long enough to crowd the eighty-column row the way a resolved model id does. */
const CONFIGURED_MODEL = "claude-sonnet-4-5";

/** The card's footline, as the component paints it, with the composer inset removed. */
function cardRow(width: number): string {
	const rows = new LaunchComposerFoot().render(width);
	const footline = rows.find(row => stripAnsi(row).trim().length > 0);
	return stripAnsi(footline ?? "").slice(COMPOSER_INSET_COLS);
}

let profileSpy: Mock<() => string> | null = null;

beforeAll(async () => {
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false);
	settings.setModelRole("default", CONFIGURED_MODEL);
});

afterAll(() => {
	resetSettingsForTest();
});

beforeEach(() => {
	profileSpy = spyOn(utils, "getActiveProfileOrDefault").mockReturnValue(ACTIVE_PROFILE);
});

afterEach(() => {
	profileSpy?.mockRestore();
	profileSpy = null;
});

describe("the startup bench sees the status row", () => {
	/** The sweep below is vacuous if the ladder is empty or the marker matches everything. */
	it("sweeps the ladder the product ships", () => {
		const rungs = Object.keys(AUTONOMY_LABEL);

		expect(rungs).toContain("auto");
		expect(rungs.length).toBeGreaterThan(3);
		expect(STATUS_ROW.test("")).toBe(false);
	});

	for (const rung of Object.keys(AUTONOMY_LABEL) as AutonomyLevel[]) {
		for (const width of [BENCH_WIDTH, WIDE]) {
			it(`fires on the ${rung} row at ${width} columns`, () => {
				settings.set("tools.approvalMode", rung);
				const row = cardRow(width);

				expect(row).toContain(AUTONOMY_LABEL[rung]);
				expect(STATUS_ROW.test(row)).toBe(true);
			});
		}
	}

	/**
	 * The marker times the row, so it must not fire on anything the card paints above it. The hero
	 * carries the same separator dots, and the tip block under it is the only launch copy anybody
	 * writes prose into.
	 */
	it("does not fire on the hero above the row", () => {
		const hero = new WelcomeComponent("1.0.0", "no-model", "no-provider").render(BENCH_WIDTH);

		expect(hero.length).toBeGreaterThan(0);
		const fired = hero.map(line => stripAnsi(line)).filter(line => STATUS_ROW.test(line));

		expect(fired).toEqual([]);
	});

	it("does not fire on any tip the card can pick", () => {
		expect(TIP_ENTRIES.length).toBeGreaterThan(5);

		const fired = TIP_ENTRIES.flatMap(tip => renderWelcomeTip(tip.text, TIP_WIDTH))
			.map(line => stripAnsi(line))
			.filter(line => STATUS_ROW.test(line));

		expect(fired).toEqual([]);
	});
});
