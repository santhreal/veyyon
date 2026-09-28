/**
 * Every setting the terminal offers has a desktop carrier.
 *
 * WHY THIS SUITE EXISTS:
 * The desktop settings page is drawn from the `Settings` snapshot section and
 * writes through `SetSetting`. A path the section drops, a synthetic terminal
 * row with no schema path behind it, or a condition the desktop cannot resolve
 * leaves the desktop short of a knob the terminal offers, or drawing a knob
 * whose feature is off. `desktop-parity/settings.ts` records one carrier per
 * row; this suite enumerates the rows from the schema and the terminal screen at
 * run time and holds every decision to what the section does.
 *
 * THE CLASS THIS CLOSES:
 * 1. A schema path or synthetic terminal row with no recorded decision.
 * 2. A carried path the section omits, or lists with a value `SetSetting`
 *    rejects, so the desktop cannot write back what it reads.
 * 3. A new path absorbed by a terminal-only prefix without a decision: the
 *    opt-outs are pinned by exact equality.
 * 4. A condition the desktop resolves differently from the terminal, which
 *    shows or hides a dependent the terminal does not.
 *
 * WHAT IT DOES NOT CATCH:
 * Whether the desktop app draws the row, and whether a running session re-reads
 * a setting written mid-session.
 */

import { beforeAll, expect, test } from "bun:test";
import { bindSettingConditions } from "../../../src/config/setting-conditions";
import { Settings } from "../../../src/config/settings";
import {
	describeSettingTypeMismatch,
	getUi,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "../../../src/config/settings-schema";
import { DESKTOP_SETTING_CONDITIONS, dumpSettings } from "../../../src/gui-host/actions/settings";
import { type DesktopCarrier, membersCarriedBy } from "../../../src/gui-host/desktop-parity/carrier";
import { desktopSettingCarrier, RECORDED_SETTING_GAPS } from "../../../src/gui-host/desktop-parity/settings";
import { getAllSettingDefs } from "../../../src/modes/terminal/components/selectors/settings-defs";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

/** Every row id: each schema path, then each synthetic row the terminal screen adds. */
function settingRowIds(): string[] {
	const synthetic = getAllSettingDefs()
		.map(def => def.path as string)
		.filter(id => !Object.hasOwn(SETTINGS_SCHEMA, id));
	return [...Object.keys(SETTINGS_SCHEMA), ...synthetic];
}

function decisions(): { table: Record<string, DesktopCarrier>; undecided: string[] } {
	const table: Record<string, DesktopCarrier> = {};
	const undecided: string[] = [];
	for (const id of settingRowIds()) {
		const carrier = desktopSettingCarrier(id);
		if (carrier) table[id] = carrier;
		else undecided.push(id);
	}
	return { table, undecided };
}

/** Condition names the schema declares, each once. */
function declaredConditions(): string[] {
	const names = new Set<string>();
	for (const path of Object.keys(SETTINGS_SCHEMA) as SettingPath[]) {
		const condition = getUi(path)?.condition;
		if (condition) names.add(condition);
	}
	return [...names].sort();
}

test("every settings row has a recorded desktop carrier", () => {
	const { table, undecided } = decisions();
	expect(undecided).toEqual([]);
	expect(Object.keys(table).length).toBe(settingRowIds().length);
});

test("the terminal-only settings are exactly the recorded opt-outs", () => {
	expect(membersCarriedBy(decisions().table, "optOut")).toEqual([
		"showHardwareCursor",
		"startup.clearScrollback",
		"statusLine.compactThinkingLevel",
		"statusLine.enabled",
		"statusLine.leftSegments",
		"statusLine.preset",
		"statusLine.rightSegments",
		"statusLine.segmentOptions",
		"statusLine.separator",
		"statusLine.sessionAccent",
		"statusLine.showAccount",
		"statusLine.showHookStatus",
		"statusLine.transparent",
		"symbolPreset",
		"tui.hyperlinks",
		"tui.maxInlineImageColumns",
		"tui.maxInlineImageRows",
		"tui.maxInlineImages",
		"tui.paintGround",
		"tui.renderMermaid",
		"tui.scrollIsolation",
		"tui.scrollbackRebuild",
		"tui.textSizing",
		"tui.tight",
	]);
});

test("the recorded gaps are exactly the schema paths the Settings section omits", () => {
	const dumped = dumpSettings(Settings.isolated({}));
	const omitted = Object.keys(SETTINGS_SCHEMA).filter(path => !Object.hasOwn(dumped, path));
	expect(Object.keys(RECORDED_SETTING_GAPS).sort()).toEqual(omitted.sort());
	expect(membersCarriedBy(decisions().table, "gap")).toEqual([]);
});

test("a carried setting is listed by the Settings section with a value SetSetting accepts", () => {
	const dumped = dumpSettings(Settings.isolated({}));
	const unreadable: string[] = [];
	const unwritable: string[] = [];
	for (const [id, carrier] of Object.entries(decisions().table)) {
		if (!("setting" in carrier)) continue;
		const entry = dumped[carrier.setting];
		if (!entry || !Object.hasOwn(SETTINGS_SCHEMA, carrier.setting)) {
			unreadable.push(id);
			continue;
		}
		if (entry.value !== null && describeSettingTypeMismatch(carrier.setting, entry.value)) unwritable.push(id);
	}
	expect(unreadable).toEqual([]);
	expect(unwritable).toEqual([]);
});

test("the desktop resolves every declared condition the way the terminal does", () => {
	const settings = Settings.isolated({});
	const terminal = bindSettingConditions(() => settings);
	const disagreements: string[] = [];
	for (const name of declaredConditions()) {
		const desktop = DESKTOP_SETTING_CONDITIONS[name];
		if (!desktop) {
			disagreements.push(`${name}: unresolved`);
			continue;
		}
		// The terminal answers this one from its graphics protocol; the desktop
		// window decodes images itself.
		if (name === "hasImageProtocol") continue;
		if (terminal[name]?.() !== desktop(settings)) disagreements.push(name);
	}
	expect(disagreements).toEqual([]);
	expect(DESKTOP_SETTING_CONDITIONS.hasImageProtocol?.(settings)).toBe(true);
});

test("the Settings section hides a dependent while its master is off and shows it once on", () => {
	const settings = Settings.isolated({});
	settings.set("lsp.enabled", false);
	expect(dumpSettings(settings)["lsp.tool"]?.hidden).toBe(true);
	settings.set("lsp.enabled", true);
	expect(dumpSettings(settings)["lsp.tool"]?.hidden).toBe(false);
});
