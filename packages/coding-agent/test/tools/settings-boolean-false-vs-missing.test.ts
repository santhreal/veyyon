import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/**
 * Settings boolean false is not treated as missing for several paths.
 */

describe("Settings boolean false vs missing", () => {
	let settingsState: SettingsTestState | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	const paths = [
		"lsp.formatOnWrite",
		"lsp.diagnosticsOnWrite",
		"compaction.enabled",
		"grep.enabled",
		"glob.enabled",
	] as const;

	it("false override is returned as false for each path", () => {
		for (const p of paths) {
			const s = Settings.isolated({ [p]: false } as never);
			expect(s.get(p)).toBe(false);
		}
	});

	it("true override is returned as true for each path", () => {
		for (const p of paths) {
			const s = Settings.isolated({ [p]: true } as never);
			expect(s.get(p)).toBe(true);
		}
	});
});
