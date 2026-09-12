/**
 * A setting that declares a `ui` block is a row an operator can reach, and a
 * retired key is no row at all.
 *
 * WHY THIS SUITE EXISTS. The panel is not built from the schema, it is ADAPTED
 * from it: `pathToSettingDef` switches on a setting's type and returns `null`
 * for anything it does not recognize, and `getAllSettingDefs` drops a `null`
 * without a word. So a setting can carry a tab, a group, a label and a
 * description, appear in the generated reference, be written by hand into
 * `~/.veyyon/config.yml`, and still not exist on the screen. Fifteen optionless
 * numbers were in exactly that state -- among them `onboardingVersion`, whose
 * declaration still carries the note explaining that it now has to say `hidden`
 * out loud because the adapter no longer discards it for being a number with
 * nothing to pick from.
 *
 * A dropped row fails SILENTLY and in the safe-looking direction: nothing
 * crashes, no test goes red, and the only symptom is an operator who reads the
 * documentation for a knob and then cannot find it. That is the same end state
 * as a knob that was never wired, which is what the project calls a dead flag.
 *
 * The other direction is worse. A retired key is one the migration has already
 * moved off; drawing it as an editable row invites an operator to set a value
 * that nothing reads, or to fight the migration that keeps rewriting it.
 *
 * WHY IT IS DERIVED. From `settingsSchemaPaths()` and `SETTING_TYPES` at run
 * time, never a written-down list. A new setting whose type the adapter cannot
 * draw is red on arrival; so is a new `SettingType` that no drawn row uses,
 * because a type with no live example is a branch this sweep cannot check. The
 * two opt-out sets -- what is hidden on purpose, and what is retired -- are
 * pinned by exact equality rather than by count, so widening either one is a
 * decision someone records here instead of a number someone bumps.
 *
 * WHAT IT DOES NOT CATCH. Whether a reachable row WORKS: that its editor writes
 * the value, that the value reaches behavior, or that its `ui.condition` names a
 * live predicate. Reachability is necessary and nowhere near sufficient. The
 * condition names are held by `an-off-feature-hides-its-knobs.test.ts`, the
 * labels by `a-settings-name-carries-information.test.ts`, and whether a setting
 * changes anything at all is per-domain end-to-end work.
 */
import { describe, expect, it } from "bun:test";
import {
	getType,
	getUi,
	retiredBy,
	type SettingPath,
	settingsSchemaPaths,
} from "@veyyon/coding-agent/config/settings-schema";
import {
	getAllSettingDefs,
	invalidateSettingDefsCache,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/settings-defs";
import { SETTING_TYPES } from "@veyyon/settings";

invalidateSettingDefsCache();
const DEFS = getAllSettingDefs();
const DRAWN = new Set<string>(DEFS.map(def => def.path));

/** Every path carrying UI metadata, in schema order. */
const UI_PATHS: readonly SettingPath[] = settingsSchemaPaths().filter(path => getUi(path) !== undefined);

/** Whether a declaration asks to be kept off the screen. */
function hidden(path: SettingPath): boolean {
	return getUi(path)?.hidden === true;
}

const RETIRED: readonly SettingPath[] = settingsSchemaPaths().filter(path => retiredBy(path) !== undefined);

describe("a declared setting is a reachable control", () => {
	/**
	 * NON-VACUITY. Every assertion below walks a derived set, and an empty set
	 * satisfies all of them. These are the numbers as measured, as floors.
	 */
	it("reads the whole declared surface", () => {
		expect(UI_PATHS.length).toBeGreaterThanOrEqual(353);
		expect(DEFS.length).toBeGreaterThanOrEqual(354);
		expect(RETIRED.length).toBeGreaterThanOrEqual(5);
		expect(SETTING_TYPES.length).toBe(7);
	});

	/**
	 * THE ADAPTER DRAWS EVERY DECLARED ROW. The one setting that is missing on
	 * purpose says so in its own declaration, and it is named here so that a
	 * second one cannot join it by accident.
	 */
	it("draws every setting that declares a ui block, except the ones that opt out", () => {
		const undrawn = UI_PATHS.filter(path => !DRAWN.has(path));

		expect(
			undrawn,
			"these declare a tab, a group and a label but reach no row; either the adapter cannot draw the type or the declaration means to be hidden and must say `hidden: true`",
		).toEqual(["onboardingVersion"]);
		expect(undrawn.every(hidden)).toBe(true);
	});

	/**
	 * AND HIDING IS THE ONLY WAY OUT. Stated as its own direction so the
	 * assertion above cannot be satisfied by marking a row hidden to silence it:
	 * a hidden row is absent from the screen, and every other declared row is on
	 * it.
	 */
	it("keeps every hidden setting off the screen and every other one on it", () => {
		const hiddenPaths = UI_PATHS.filter(hidden);
		expect(hiddenPaths).toEqual(["onboardingVersion"]);
		expect(hiddenPaths.filter(path => DRAWN.has(path))).toEqual([]);
		expect(UI_PATHS.filter(path => !hidden(path) && !DRAWN.has(path))).toEqual([]);
	});

	/**
	 * EVERY TYPE HAS A LIVE EXAMPLE. The sweep above can only prove the adapter
	 * draws the types something currently uses. A new `SettingType` with no drawn
	 * row is a branch nothing here exercises, so it fails until a row uses it or
	 * someone records why none does.
	 */
	it("exercises every setting type through a drawn row", () => {
		const exercised = new Set(UI_PATHS.filter(path => DRAWN.has(path)).map(path => getType(path)));

		expect([...exercised].sort(), "no drawn row carries these types, so this suite cannot prove they render").toEqual(
			[...SETTING_TYPES].sort(),
		);
	});

	/**
	 * A RETIRED KEY IS NOT A KNOB. Both directions: it declares no UI, and it
	 * reaches no row. The second is what would catch a row drawn from somewhere
	 * other than a `ui` block.
	 */
	it("offers no row for a retired setting", () => {
		expect(
			RETIRED.filter(path => getUi(path) !== undefined),
			"a retired key declares UI, so the panel offers a value the migration will move",
		).toEqual([]);
		expect(
			RETIRED.filter(path => DRAWN.has(path)),
			"a retired key reaches a row in the settings panel",
		).toEqual([]);
	});
});
