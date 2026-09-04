/**
 * Settings schema defaults: every sampled path has getDefault matching isolated empty Settings.
 */
import { describe, expect, it } from "bun:test";
import { Settings } from "../src/config/settings";
import { getDefault, SETTINGS_SCHEMA, type SettingPath } from "../src/config/settings-schema";

const SAMPLE_PATHS = ["tier.openai", "tier.subagent", "display.smoothStreaming", "tools.approvalMode"] as const;

describe("settings schema defaults matrix", () => {
	it("sample paths exist on SETTINGS_SCHEMA", () => {
		for (const p of SAMPLE_PATHS) {
			expect(Object.hasOwn(SETTINGS_SCHEMA, p)).toBe(true);
		}
	});

	it("getDefault matches Settings.isolated({}) for sample paths", () => {
		const settings = Settings.isolated({});
		for (const p of SAMPLE_PATHS) {
			const path = p as SettingPath;
			expect(settings.get(path)).toBe(getDefault(path));
		}
	});

	it("override wins over default for tools.approvalMode when valid", () => {
		const settings = Settings.isolated({ "tools.approvalMode": "ask" });
		// `as SettingPath` broadens get()'s return to the full SettingValue union,
		// which the "ask" literal does not narrow into; widen the matcher to assert
		// the runtime value directly.
		expect(settings.get("tools.approvalMode" as SettingPath)).toBe<unknown>("ask");
	});

	it("SETTINGS_SCHEMA has a large non-empty set of paths", () => {
		const keys = Object.keys(SETTINGS_SCHEMA);
		expect(keys.length).toBeGreaterThan(20);
		// every key is a non-empty string
		for (const k of keys) {
			expect(k.length).toBeGreaterThan(0);
			expect(k).not.toContain(" ");
		}
	});
});
