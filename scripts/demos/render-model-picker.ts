/**
 * Print the session model picker (`/model`, `/models`, `/switch`, alt+p) as
 * ANSI, deterministically.
 *
 * The picker cannot be captured by opening it for real: the list is whatever
 * the machine's model cache and credentials produce, so the frame would differ
 * per host and per day. This renders the SHIPPED `ModelPickerComponent` with
 * the real theme against a fixed model list, so the pixels come from the code
 * that ships.
 *
 * Usage:
 *
 *     bun scripts/demos/render-model-picker.ts [--theme titanium|light] [--width 100] [--reloading]
 *
 * `--reloading` renders the in-flight state, which is the second frame worth
 * proving: the status line swaps to the progress text and the list must stay
 * legible underneath it.
 */
import type { Model } from "../../packages/ai/src/index";
import { buildModel } from "../../packages/catalog/src/build";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import type { ModelRegistry } from "../../packages/coding-agent/src/config/model-registry";
import { ModelPickerComponent } from "../../packages/coding-agent/src/modes/components/model-picker";
import type { TUI } from "../../packages/tui/src/index";
import { flag, hasFlag, initRender, renderWidth } from "./render-args";

/** A short, stable list: enough rows to show the frame, few enough to stay readable. */
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

const themeName = flag("theme", "titanium");
const width = renderWidth();
const reloading = hasFlag("reloading");

await initRender(themeName, { settings: true });

const models = MODELS.map(([provider, id]) => makeModel(provider, id));
// A refresh that never settles holds the in-flight frame still for the capture.
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

// Ctrl+R, through the real key path rather than by poking private state.
if (reloading) picker.handleInput("\x12");

process.stdout.write(`${picker.render(width).join("\n")}\n`);
