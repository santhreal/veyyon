/**
 * Default Model chooses a model. Default Effort owns the main model's saved effort.
 *
 * The default-model submenu used to append an effort suffix to `modelRoles.default`.
 * That hidden selector pin outranked the adjacent Default Effort row, so changing the
 * setting named "Default Effort" could have no effect until the model was re-picked.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { DEFAULT_MODEL_SLOT } from "@veyyon/coding-agent/config/model-roles";
import { resetSettingsForTest, Settings, settings } from "@veyyon/coding-agent/config/settings";
import { resolveRoleAssignments } from "@veyyon/coding-agent/modes/components/model-browser";
import { DEFAULT_MODEL_SETTING_ID } from "@veyyon/coding-agent/modes/components/settings-defs";
import { SettingsSelectorComponent } from "@veyyon/coding-agent/modes/components/settings-selector";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

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

function openDefaultModel(): SettingsSelectorComponent {
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
	expect(component.selectSetting(DEFAULT_MODEL_SETTING_ID)).toBe(true);
	component.handleInput("\n");
	return component;
}

describe("default model and effort ownership", () => {
	/** Re-picking a configurable model must remove an old hidden suffix instead of opening a second effort editor. */
	it("stores a bare selector from the Default Model picker", () => {
		settings.setModelRole(DEFAULT_MODEL_SLOT, "test/reasoning-model:high");
		const component = openDefaultModel();

		component.handleInput("\n");

		expect(settings.getModelRole(DEFAULT_MODEL_SLOT)).toBe("test/reasoning-model");
	});

	/** Once Default Model is bare, edits to the model-specific Default Effort row must immediately decide startup effort. */
	it("lets Default Effort control the selected main model", () => {
		settings.setModelRole(DEFAULT_MODEL_SLOT, "test/reasoning-model:high");
		const component = openDefaultModel();
		component.handleInput("\n");

		settings.set("defaultEffort", { "test/reasoning-model": ThinkingLevel.Low });
		expect(resolveRoleAssignments(Settings.instance, [model]).default?.thinkingLevel).toBe(ThinkingLevel.Low);

		settings.set("defaultEffort", { "test/reasoning-model": ThinkingLevel.High });
		expect(resolveRoleAssignments(Settings.instance, [model]).default?.thinkingLevel).toBe(ThinkingLevel.High);
	});
});
