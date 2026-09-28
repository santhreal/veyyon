/**
 * WHY: the terminal ships a theme set and the desktop draws its own dark and
 * light palettes. A shipped theme on a ground with no decision would be a theme
 * the desktop neither draws nor states it declines. This sweep enumerates the
 * shipped themes at run time, groups them by ground, and fails when a ground
 * has no decision or a decision names a ground no theme uses.
 *
 * Not caught: a custom theme on disk, which `LoadThemes` lists and which takes
 * the decision of its ground the same way.
 */
import { describe, expect, it } from "bun:test";
import { membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import { THEME_GROUND_CARRIERS, themeCarrier, themeGround } from "../../../src/gui-host/desktop-parity/themes";
import { getBuiltinThemeNames } from "../../../src/theme/builtin-themes";

describe("terminal themes on the desktop", () => {
	it("decides the ground of every shipped theme, and only those grounds", () => {
		const names = getBuiltinThemeNames();
		const grounds = [...new Set(names.map(themeGround))].sort();
		expect(grounds).toEqual(Object.keys(THEME_GROUND_CARRIERS).sort());
		expect(names.filter(name => themeCarrier(name) === undefined)).toEqual([]);
	});

	it("puts the root dark and light themes on their own grounds", () => {
		expect([themeGround("dark"), themeGround("light")]).toEqual(["dark", "light"]);
	});

	it("opts every ground out, because the desktop draws its own palettes", () => {
		expect(membersCarriedBy(THEME_GROUND_CARRIERS, "optOut")).toEqual(["dark", "light"]);
		expect(membersCarriedBy(THEME_GROUND_CARRIERS, "gap")).toEqual([]);
	});
});
