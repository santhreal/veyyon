import { afterAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { getAllSettingDefs, invalidateSettingDefsCache } from "@veyyon/coding-agent/modes/components/settings-defs";

const AUTO_QA_SETTING_PATHS = ["dev.autoqa", "dev.autoqaPush.enabled", "dev.autoqaPush.endpoint"] as const;

function visibleAutoQaSettings(): string[] {
	invalidateSettingDefsCache();
	return getAllSettingDefs()
		.filter(def => (AUTO_QA_SETTING_PATHS as readonly string[]).includes(def.path))
		.filter(def => !def.condition || def.condition())
		.map(def => def.path);
}

async function setGlobalAutoQaEnabled(enabled: boolean): Promise<void> {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, overrides: { "dev.autoqa": enabled } });
}

describe("Auto QA profile upload settings", () => {
	afterAll(() => {
		resetSettingsForTest();
	});

	/** A new profile must record nothing and upload nothing until the operator enables each boundary. */
	it("defaults recording and automatic upload off with the owned collector endpoint", () => {
		const settings = Settings.isolated();

		expect(settings.get("dev.autoqa")).toBe(false);
		expect(settings.get("dev.autoqaPush.enabled")).toBe(false);
		expect(settings.get("dev.autoqaPush.endpoint")).toBe("https://veyyon.dev/api/grievances");
	});

	/** Dependent network controls must disappear while Auto QA itself is disabled, not remain as inert knobs. */
	it("shows only the local recording master while Auto QA is off", async () => {
		await setGlobalAutoQaEnabled(false);

		expect(visibleAutoQaSettings()).toEqual(["dev.autoqa"]);
	});

	/** Enabling local reporting must reveal the separate upload consent and destination controls. */
	it("reveals automatic upload and its endpoint when Auto QA is on", async () => {
		await setGlobalAutoQaEnabled(true);

		expect(visibleAutoQaSettings()).toEqual(["dev.autoqa", "dev.autoqaPush.enabled", "dev.autoqaPush.endpoint"]);
	});
});
