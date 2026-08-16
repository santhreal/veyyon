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
 * tightening: a picker that offers nothing at all here (its only remaining row
 * is the CLEAR sentinel), or a suffix parse that rejects a non-selector.
 * Either one turns every pick on this row into a row deletion, and with the
 * enum this list replaced (`defaultThinkingLevel`) retired and carrying no UI
 * row, no screen could put the value back.
 *
 * What the row offers is the UNION of what this session's catalog declares —
 * not the session's own model, since the row applies to every model, and not
 * the configuration vocabulary, which is how `minimal` was offered to a session
 * whose models declare `low, high, max`. Both bounds are driven below: a level
 * the session's model cannot take is still reachable when another model in the
 * catalog declares it, and a level nothing declares is not a row at all.
 *
 * So this drives the real `SettingsSelectorComponent` with the bytes a terminal
 * sends and asserts the stored setting. Under either regression the keystrokes
 * below land on "No default" and the row disappears.
 */

import { stripVTControlCharacters } from "node:util";
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

/**
 * A second model in the same session, declaring a level the first cannot take.
 * The `*` row applies to every model, so `max` must be reachable from it — and it
 * is reachable because THIS row declares it, not because a constant lists it.
 */
const maxModel: Model = buildModel({
	id: "max-model",
	name: "Max model",
	api: "openai-completions",
	provider: "test",
	baseUrl: "https://example.test",
	reasoning: true,
	thinking: { mode: "effort", efforts: [Effort.Max] },
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
function openAnyModelEffort(catalog: readonly Model[] = [model]): SettingsSelectorComponent {
	const component = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["test"],
			cwd: process.cwd(),
			modelRegistry,
			availableModels: catalog,
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
	function pickRow(component: SettingsSelectorComponent, index: number): void {
		for (let step = 0; step < index; step++) component.handleInput(DOWN);
		component.handleInput(ENTER);
	}

	/** Rows with only `model` in the session: No default, off, auto, low, high. */
	it("writes the level the operator picks", () => {
		const component = openAnyModelEffort();

		pickRow(component, 3);

		expect(settings.get("defaultEffort")).toEqual({ [ANY_MODEL_EFFORT_KEY]: Effort.Low });
	});

	/**
	 * The row is not narrowed to any one model, so a level the session's own model cannot take is
	 * still reachable when something else in the catalog declares it. Rows: No default, off, auto,
	 * low, high, max.
	 */
	it("reaches a level one model in the catalog declares and the other cannot take", () => {
		const component = openAnyModelEffort([model, maxModel]);

		pickRow(component, 5);

		expect(settings.get("defaultEffort")).toEqual({ [ANY_MODEL_EFFORT_KEY]: Effort.Max });
	});

	/**
	 * The other bound, read off the screen because pressing past the last row wraps rather than
	 * reaching anything new. `minimal`, `medium` and `xhigh` are levels of the configuration
	 * vocabulary that NOTHING in this session declares; offering them is the defect, since the pick
	 * is then clamped away by every model it could ever apply to.
	 */
	it("never offers a level nothing in the catalog declares", () => {
		const component = openAnyModelEffort([model, maxModel]);
		const rendered = stripVTControlCharacters(component.render(160).join("\n"));
		const offered = (level: string): boolean => new RegExp(`\\b${level}\\b`).test(rendered);

		expect([Effort.Low, Effort.High, Effort.Max].filter(offered)).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect([Effort.Minimal, Effort.Medium, Effort.XHigh].filter(offered)).toEqual([]);
	});

	it("still removes the row from its first entry", () => {
		const component = openAnyModelEffort();

		pickRow(component, 0);

		expect(settings.get("defaultEffort")).toEqual({});
	});
});
