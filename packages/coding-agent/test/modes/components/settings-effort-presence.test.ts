/**
 * `defaultEffort` presence is the migration marker, not the row count.
 *
 * Settings.get() returns the schema default `{}` even when the key is absent,
 * so UI callsites must consult isConfigured(). Otherwise legacy `auto` either
 * never migrates on old profiles or is resurrected after the operator clears
 * the replacement list. This exercises the settings-definition condition that
 * controls whether the Auto Thinking Model row is visible.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { getSettingDef } from "@veyyon/coding-agent/modes/components/settings-defs";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

describe("Default Effort migration presence in settings UI", () => {
	it("uses legacy auto only while defaultEffort is absent, then honors an explicit empty object", () => {
		const condition = getSettingDef("providers.autoThinkingModel")?.condition;
		if (!condition) throw new Error("expected providers.autoThinkingModel condition");
		settings.set("defaultThinkingLevel", AUTO_THINKING);

		expect(settings.isConfigured("defaultEffort")).toBe(false);
		expect(condition()).toBe(true);

		settings.set("defaultEffort", {});

		expect(settings.isConfigured("defaultEffort")).toBe(true);
		expect(condition()).toBe(false);
	});
});
