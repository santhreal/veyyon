/**
 * Regenerate the committed paired proof:
 * `env -u NO_COLOR FORCE_COLOR=3 bun scripts/demos/render-default-effort-ownership.ts --width 100 | bun scripts/demos/render-proof.ts --out assets/default-effort-ownership --width 100 --scale 2`
 */
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import type { ModelRegistry } from "../../packages/coding-agent/src/config/model-registry";
import { resetSettingsForTest, Settings } from "../../packages/coding-agent/src/config/settings";
import { DEFAULT_MODEL_SETTING_ID } from "../../packages/coding-agent/src/modes/components/settings-defs";
import { SettingsSelectorComponent } from "../../packages/coding-agent/src/modes/components/settings-selector";
import { initTheme } from "../../packages/coding-agent/src/modes/theme/theme";
import { renderWidth } from "./render-args";

const width = renderWidth(process.argv.slice(2));
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

resetSettingsForTest();
await Settings.init({
	inMemory: true,
	overrides: {
		modelRoles: { default: "test/reasoning-model:high" },
		defaultEffort: { "test/reasoning-model": Effort.Low },
	},
});
await initTheme();

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

process.stdout.write(`${selector.render(width).join("\n")}\n`);
