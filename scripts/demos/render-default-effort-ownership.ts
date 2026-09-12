/**
 * Render the settings selector model tab with configured default effort overrides.
 *
 * Initializes in-memory settings with a model role requiring high effort and a default
 * effort setting requiring low effort. Opens the model settings tab, selects the default
 * model entry, navigates into the effort picker, and prints the rendered selector lines
 * as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-default-effort-ownership.ts [--width 100] [--theme dark]
 */

import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import type { ModelRegistry } from "../../packages/coding-agent/src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../packages/coding-agent/src/config/settings";
import { DEFAULT_MODEL_SETTING_ID } from "../../packages/coding-agent/src/modes/terminal/components/selectors/settings-defs";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/terminal/components/selectors/settings-selector";
import { renderDemo } from "./render-args";

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
	contextWindow: 128_000,
	maxTokens: 8_000,
});
const registry = {
	isKeylessProvider: () => false,
	hasConfiguredAuth: () => true,
	authStorage: { hasAuth: () => true },
} as unknown as ModelRegistry;

await renderDemo(async ({ width }) => {
	resetSettingsForTest();
	await Settings.init({
		inMemory: true,
		overrides: {
			modelRoles: { default: "test/reasoning-model:high" },
			defaultEffort: { "test/reasoning-model": Effort.Low },
		},
	});

	const selector = new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			availablePersonalities: ["default"],
			providers: ["test"],
			cwd: process.cwd(),
			modelRegistry: registry,
			availableModels: [model],
		},
		{ onChange: () => {}, onCancel: () => {} },
	);
	selector.openTab("model");
	selector.selectSetting(DEFAULT_MODEL_SETTING_ID);
	selector.handleInput("\n");
	selector.handleInput("\n");
	return selector.render(width);
});
