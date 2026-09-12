/**
 * Render the model picker component with mock models and reload states.
 *
 * Populates a model registry with synthetic models across multiple providers. Constructs
 * the model picker component, optionally triggers a reload input sequence via Ctrl+R,
 * and prints the rendered picker interface as ANSI text.
 *
 * Usage:
 *   bun scripts/demos/render-model-picker.ts [--reloading] [--width 100] [--theme titanium]
 */

import type { TUI } from "../../hosts/terminal/engine/src/index";
import type { Model } from "../../packages/ai/src/index";
import { buildModel } from "../../packages/catalog/src/build";
import type { ModelRegistry } from "../../packages/coding-agent/src/config/model-registry";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { ModelPickerComponent } from "../../packages/coding-agent/src/modes/terminal/components/selectors/model-picker";
import { renderDemo } from "./render-args";

const MODELS: readonly [string, string][] = [
	["anthropic", "claude-opus-5"],
	["anthropic", "claude-sonnet-5"],
	["openai", "gpt-6"],
	["ollama", "llama-4-70b"],
	["zai", "glm-5.2"],
];

function makeModel(provider: string, id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	});
}

await renderDemo(
	({ width, hasFlag }) => {
		const reloading = hasFlag("reloading");
		const models = MODELS.map(([provider, id]) => makeModel(provider, id));
		const pending = Promise.withResolvers<void>();
		const registry = {
			refresh: () => pending.promise,
			refreshProvider: async () => {},
			getError: () => undefined,
			getAvailable: () => models,
			getAll: () => models,
		} as unknown as ModelRegistry;

		const tui = { requestRender: () => {}, terminal: { rows: 40 } } as unknown as TUI;
		const picker = new ModelPickerComponent(
			tui,
			Settings.instance,
			registry,
			models.map(model => ({ model })),
			{ onPick: () => {}, onCancel: () => {} },
			{ currentSelector: "anthropic/claude-opus-5" },
		);

		if (reloading) picker.handleInput("\x12");
		return picker.render(width);
	},
	{ settings: true },
);
