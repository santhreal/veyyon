import { describe, expect, test } from "bun:test";
// model-roles is imported FIRST, before settings, on purpose: it doubles as the regression guard
// for the import-cycle TDZ (see the getKnownRoleIds describe below). If model-roles ever re-enters
// the config/model-resolver cycle, this import throws "Cannot access 'MODEL_ROLE_ALIAS_PREFIX'
// before initialization" and the whole file fails to load.
import { getKnownRoleIds, getRoleInfo } from "@veyyon/coding-agent/config/model-roles";
import { Settings } from "@veyyon/coding-agent/config/settings";

describe("getRoleInfo", () => {
	test("returns built-in role info", () => {
		const settings = Settings.isolated({});

		expect(getRoleInfo("default", settings)).toEqual({
			name: "Default",
			color: "success",
			tag: "DEFAULT",
			hidden: true,
		});
		expect(getRoleInfo("smol", settings)).toEqual({
			name: "Fast",
			color: "warning",
			tag: "SMOL",
		});
		expect(getRoleInfo("slow", settings)).toEqual({
			name: "Thinking",
			color: "accent",
			tag: "SLOW",
		});
	});

	test("returns custom role info from modelTags", () => {
		const settings = Settings.isolated({
			modelTags: {
				custom: { name: "My Custom Tag", color: "error" },
				another: { name: "Another Tag" },
			},
		});

		expect(getRoleInfo("custom", settings)).toEqual({
			name: "My Custom Tag",
			color: "error",
		});
		expect(getRoleInfo("another", settings)).toEqual({
			name: "Another Tag",
			color: undefined,
		});
	});

	test("returns fallback for unknown roles", () => {
		const settings = Settings.isolated({});

		expect(getRoleInfo("unknown-role", settings)).toEqual({
			name: "unknown-role",
			color: "muted",
		});
	});

	test("configured metadata overrides built-in role info while keeping built-in defaults", () => {
		const settings = Settings.isolated({
			modelTags: {
				smol: { name: "My Smol", color: "success" },
			},
		});

		expect(getRoleInfo("smol", settings)).toEqual({
			tag: "SMOL",
			name: "My Smol",
			color: "success",
		});
	});

	test("keeps the built-in color when a configured tag color is not a valid theme color", () => {
		const settings = Settings.isolated({
			modelTags: {
				// "not-a-color" fails isValidThemeColor, so the built-in `warning` color is kept
				// rather than the invalid string being written straight through.
				smol: { name: "Custom", color: "not-a-color" as never },
			},
		});

		expect(getRoleInfo("smol", settings)).toEqual({
			tag: "SMOL",
			name: "Custom",
			color: "warning",
		});
	});
});

/**
 * getKnownRoleIds builds the selector/carousel role list. It had no direct test, and this describe
 * also guards a real regression: model-roles once imported the heavy `modes/theme/theme` barrel,
 * which pulls modes/theme/shimmer -> config/settings -> discovery -> ... -> config/model-resolver,
 * and model-resolver imports model-roles back. That cycle made model-resolver's top-level
 * `const MODEL_ROLE_ALIAS_PREFIXES = [MODEL_ROLE_ALIAS_PREFIX, ...]` read this module's exports while
 * they were still in the temporal dead zone, throwing "Cannot access 'MODEL_ROLE_ALIAS_PREFIX' before
 * initialization" the instant model-roles was imported first (this whole file failed to load). The fix
 * routes the color import through the leaf modes/theme/color. The `it loads` behavior below only
 * passes if that import edge stays off the cycle.
 *
 * The ordering contract pinned here: built-in selectable roles come first in MODEL_ROLE_IDS order,
 * then extra roles introduced by cycleOrder, then modelRoles keys, then modelTags keys, each added
 * once (deduped) and never the legacy "default" role.
 */
describe("getKnownRoleIds", () => {
	test("loads without an import-cycle error and lists the built-in roles first in order", () => {
		expect(getKnownRoleIds(Settings.isolated({}))).toEqual([
			"smol",
			"slow",
			"vision",
			"plan",
			"designer",
			"commit",
			"tiny",
			"task",
			"advisor",
		]);
	});

	test("appends custom roles from cycleOrder then modelTags, deduped and without 'default'", () => {
		const roles = getKnownRoleIds(
			Settings.isolated({
				// "default" is dropped, "myCustom" appears once despite the duplicate.
				cycleOrder: ["default", "smol", "myCustom", "myCustom"],
				modelTags: { taggedRole: { name: "T" }, smol: { name: "x" } },
			}),
		);
		expect(roles).toEqual([
			"smol",
			"slow",
			"vision",
			"plan",
			"designer",
			"commit",
			"tiny",
			"task",
			"advisor",
			"myCustom",
			"taggedRole",
		]);
	});

	test("appends custom roles assigned in modelRoles, skipping the legacy 'default'", () => {
		const roles = getKnownRoleIds(
			Settings.isolated({
				modelRoles: { default: "gpt", extraRole: "claude" },
			}),
		);
		expect(roles).toEqual([
			"smol",
			"slow",
			"vision",
			"plan",
			"designer",
			"commit",
			"tiny",
			"task",
			"advisor",
			"extraRole",
		]);
	});
});
