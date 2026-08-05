/**
 * A setting that declares a `ui` block is REACHABLE in `/settings`.
 *
 * THE BUG THIS LOCKS OUT. `subagent.idleTtlMs` shipped with a complete `ui` block -- tab, group,
 * label, a two-sentence description -- and a docs entry, and it did not appear in `/settings` at all.
 * The adapter that turns a schema row into a UI row (`pathToSettingDef` in
 * `modes/components/settings-defs.ts`) returns `null` for a NUMBER with no `ui.options`, so stage one
 * of the park/close lifecycle was documented, defaulted and honored while being unreachable. Nothing
 * failed. Every settings suite in this repository checks named paths one at a time
 * (`settings-layout`, `model-selector-settings`, `subagent-agents-surface`, `compaction-strategy-settings`),
 * so a row nobody thought to name is a row nobody notices is gone.
 *
 * WHY IT IS ASSERTED AGAINST THE SCHEMA AND NOT AGAINST THE UI. The failure mode of the suites above
 * is that they derive what they expect from what the UI returned, so a missing row drops out of both
 * sides of the comparison. This walks `SETTINGS_SCHEMA` -- the declaration, the thing an author edits
 * -- and asks the UI whether each declared row came out the other end. A row that vanishes has nowhere
 * to hide, because the left-hand side never consulted the UI.
 *
 * THERE IS NO ALLOWLIST. This file shipped with a fifteen-entry shrink-only defect list, every entry
 * an optionless number carrying a full `ui` block that the adapter silently dropped. Those fifteen
 * were fixed rather than tolerated: an optionless number renders as a text input now, and the one
 * remaining key that genuinely must not appear (`onboardingVersion`, machine-written state) says so
 * in the schema with `ui.hidden`. So "declared and not rendered" is now an empty set, and the last
 * case below refuses `hidden` as a hiding place: a key with an option list is a knob, and a knob that
 * hides to silence this suite fails here instead.
 */
import { describe, expect, it } from "bun:test";
import {
	getDefault,
	getType,
	getUi,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "@veyyon/coding-agent/config/settings-schema";
import { getSettingsForTab, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";

function declaredVisible(): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => {
		const ui = getUi(path);
		return ui !== undefined && ui.hidden !== true;
	});
}

function reachableInSettings(): Set<string> {
	invalidateSettingDefsCache();
	const reachable = new Set<string>();
	for (const tab of SETTING_TABS) {
		for (const def of getSettingsForTab(tab)) reachable.add(def.path);
	}
	return reachable;
}

describe("every setting that declares a ui block is reachable in /settings", () => {
	/**
	 * NON-VACUITY FIRST. Every assertion below is about a set difference, and both sides collapsing to
	 * empty satisfies all of them. A schema that failed to compose, or a `getSettingsForTab` that
	 * returned nothing, would report a perfectly healthy surface.
	 */
	it("reads a real schema and a real settings surface", () => {
		expect(declaredVisible().length).toBeGreaterThan(300);
		expect(reachableInSettings().size).toBeGreaterThan(300);
		// And the row the whole suite is named after is on the surface. It shipped with a full ui block,
		// a docs entry and no row at all, because the adapter dropped optionless numbers.
		expect(reachableInSettings().has("subagent.idleTtlMs")).toBe(true);
	});

	/**
	 * THE CONTRACT. A `ui` block is a claim that an operator can find and change the setting, and the
	 * only way to declare one and mean otherwise is `hidden: true`, which says so in the schema where
	 * the next author reads it. Anything else that makes the claim and is not on the surface is a
	 * defect, and there is no allowlist: this list is empty and stays empty.
	 */
	it("has no declared row missing from the surface", () => {
		const reachable = reachableInSettings();
		const missing = declaredVisible()
			.filter(path => !reachable.has(path))
			.sort();

		expect(
			missing,
			"each of these declares a ui block (tab, group, label, description) and renders nowhere in /settings; mark it ui.hidden if that is deliberate",
		).toEqual([]);
	});

	/**
	 * AND `hidden` IS NOT A PLACE TO PARK A BROKEN ROW. Every hidden key is machine-written state the
	 * app maintains, so it carries a default and no operator-facing option list; a knob someone hid to
	 * silence the case above would be a knob with options, and fails here.
	 */
	it("hides only machine-written state, never a knob", () => {
		const hidden = (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(path => getUi(path)?.hidden === true);

		expect(hidden).toEqual(["onboardingVersion"]);
		for (const path of hidden) {
			expect(getType(path), path).toBe("number");
			expect(getUi(path)?.options, `${path} offers choices, so it is a knob and must not be hidden`).toBeUndefined();
			expect(getDefault(path), `${path} is machine state and must have a default`).not.toBeUndefined();
		}
	});
});
