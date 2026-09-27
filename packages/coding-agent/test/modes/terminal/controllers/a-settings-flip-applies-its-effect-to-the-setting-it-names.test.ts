/**
 * A flip in the settings UI applies its live effect to the setting it names, and to no other.
 *
 * WHY THIS SUITE EXISTS. `SelectorController.handleSettingChange` was a `switch` over a bare
 * string. Eighteen of its labels were names no setting has (`showImages`, `autoCompact`,
 * `theme`, `statusLinePreset`, ...) and three were declared settings the selector has no row
 * for, so their effects never ran. `showImages` was written for what is now
 * `terminal.showImages`: turning inline images off left every drawn card showing them. A
 * `discovery.` prefix branch meant for per-provider toggles caught the one `discovery.*` setting
 * the selector does send, read `discovery.importForeignConfig` as a provider named
 * `importForeignConfig`, wrote that name into `disabledProviders`, and left the import flag
 * where startup put it.
 *
 * THE CLASS IT CLOSES. The effect table is typed by `SettingPath`, so a key that is not a
 * declared setting fails to compile. The sweep below enumerates every declared setting at run
 * time and fails on one that has an effect but no row in the settings selector, which is a key
 * nothing can reach. The two behavior cases pin the instances that shipped.
 *
 * WHAT IT DOES NOT CATCH. A selector row whose live state needs an effect and has none: a
 * missing row in the table is indistinguishable from a setting that is read on every use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { getUi, SETTINGS_SCHEMA, type SettingPath } from "@veyyon/coding-agent/config/settings-schema";
import {
	captureRegistryForTests,
	getDisabledProviders,
	initializeWithSettings,
	isForeignConfigImportEnabled,
	isProviderEnabled,
	type RegistrySnapshot,
	restoreRegistryForTests,
} from "@veyyon/coding-agent/discovery/capability";
import { SelectorController } from "@veyyon/coding-agent/modes/terminal/controllers/selector-controller";
import { settingEffect } from "@veyyon/coding-agent/modes/terminal/controllers/setting-effects";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../../../helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;
let registrySnapshot: RegistrySnapshot | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	registrySnapshot = captureRegistryForTests();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	if (registrySnapshot) restoreRegistryForTests(registrySnapshot);
	registrySnapshot = undefined;
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("the settings effect table", () => {
	it("has an effect only for settings the selector has a row for", () => {
		const declared = Object.keys(SETTINGS_SCHEMA) as SettingPath[];
		const withEffect = declared.filter(path => settingEffect(path) !== undefined);
		const unreachable = withEffect.filter(path => getUi(path) === undefined);

		expect(unreachable).toEqual([]);
		// The sweep is only as good as its reach: with no effect found it would pass on anything.
		expect(withEffect).toContain("terminal.showImages");
		expect(withEffect).toContain("discovery.importForeignConfig");
	});

	it("answers nothing for a name inherited from Object.prototype", () => {
		for (const inherited of ["toString", "constructor", "hasOwnProperty", "__proto__"]) {
			expect(settingEffect(inherited)).toBeUndefined();
		}
	});
});

describe("flipping Import Other Tools' Config", () => {
	function controller(): SelectorController {
		return new SelectorController({ showWarning: vi.fn() } as unknown as InteractiveModeContext);
	}

	it("moves the import flag discovery reads and leaves the disabled providers alone", () => {
		initializeWithSettings(Settings.isolated({ "discovery.importForeignConfig": false, disabledProviders: [] }));
		expect(isProviderEnabled("claude")).toBe(false);

		controller().handleSettingChange("discovery.importForeignConfig", true);

		expect(isForeignConfigImportEnabled()).toBe(true);
		expect(isProviderEnabled("claude")).toBe(true);
		expect(getDisabledProviders()).toEqual([]);

		controller().handleSettingChange("discovery.importForeignConfig", false);

		expect(isForeignConfigImportEnabled()).toBe(false);
		expect(isProviderEnabled("claude")).toBe(false);
		expect(getDisabledProviders()).toEqual([]);
	});
});

describe("flipping Show Inline Images", () => {
	it("rebuilds the transcript under the new value and retires what scrollback holds", () => {
		const applied: string[] = [];
		const selector = new SelectorController({
			showWarning: vi.fn(),
			rebuildChatFromMessages: () =>
				applied.push(`rebuild showImages=${Settings.instance.get("terminal.showImages")}`),
			ui: { resetDisplay: () => applied.push("retire scrollback") },
		} as unknown as InteractiveModeContext);

		Settings.instance.override("terminal.showImages", false);
		selector.handleSettingChange("terminal.showImages", false);

		expect(applied).toEqual(["rebuild showImages=false", "retire scrollback"]);
	});
});
