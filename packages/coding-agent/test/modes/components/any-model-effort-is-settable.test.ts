/**
 * WHY: `/thinking` names **Settings → Model → Default Effort** as the place the
 * saved default lives, and the row it means — `defaultEffort`'s any-model `*`
 * row — had no test that pressed keys and read the setting back.
 *
 * It is the fragile row of that list. Every other row is keyed by a model
 * selector, so the picker has a model and stores `provider/id:level`. The `*`
 * row has neither: the submenu hands the picker the display string
 * `"any model"` and no model, and the chosen level survives only because the
 * suffix splitter is willing to take `:level` off a string that is not a model
 * selector. Two plausible changes break it silently, and both look like
 * tightening: a picker that offers nothing without a model (its only remaining
 * row is the CLEAR sentinel), or a suffix parse that rejects a non-selector.
 * Either one turns every pick on this row into a row deletion, and with the
 * enum this list replaced (`defaultThinkingLevel`) retired and carrying no UI
 * row, no screen could put the value back.
 *
 * So this drives the real `SettingsSelectorComponent` with the bytes a terminal
 * sends and asserts the stored setting. Under either regression the keystrokes
 * below land on "No default" and the row disappears.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { ANY_MODEL_EFFORT_KEY } from "@veyyon/coding-agent/config/effort-resolver";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

const DEFAULT_EFFORT_SETTING_ID = "defaultEffort";
const DOWN = "\x1b[B";
const ENTER = "\n";

const model: Model = buildModel({
	id: "reasoning-model",
	name: "Reasoning model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
});

const modelRegistry = {
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true },
} as unknown as ModelRegistry;

beforeAll(async () => {
	await initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	resetSettingsForTest();
});

/** Open Settings → Model → Default Effort, then its any-model row. */
function openAnyModelEffort(): SettingsSelectorComponent {
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["test"],
			cwd: process.cwd(),
			modelRegistry,
			availableModels: [model],
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	component.openTab("model");
	expect(component.selectSetting(DEFAULT_EFFORT_SETTING_ID)).toBe(true);
	component.handleInput(ENTER);
	// The any-model row sorts first in the list, so this enters its picker.
	component.handleInput(ENTER);
	return component;
}

describe("Settings → Model → Default Effort, any-model row", () => {
	/** Rows: No default, off, auto, minimal, low, medium, high, xhigh, max. */
	function pickRow(component: SettingsSelectorComponent, index: number): void {
		for (let step = 0; step < index; step++) component.handleInput(DOWN);
		component.handleInput(ENTER);
	}

	it("writes the level the operator picks", () => {
		const component = openAnyModelEffort();

		pickRow(component, 3);

		expect(settings.get("defaultEffort")).toEqual({ [ANY_MODEL_EFFORT_KEY]: Effort.Minimal });
	});

	it("reaches a level no single model in the picker supports, because every model clamps it", () => {
		// The only available model tops out at `high`. The profile-wide row is not
		// that model's row, so it must still offer the whole ladder.
		const component = openAnyModelEffort();

		pickRow(component, 8);

		expect(settings.get("defaultEffort")).toEqual({ [ANY_MODEL_EFFORT_KEY]: Effort.Max });
	});

	it("still removes the row from its first entry", () => {
		const component = openAnyModelEffort();

		pickRow(component, 0);

		expect(settings.get("defaultEffort")).toEqual({});
	});
});
