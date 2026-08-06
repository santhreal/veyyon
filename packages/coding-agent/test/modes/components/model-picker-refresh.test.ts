/**
 * WHY: the picker lists whatever the model cache holds, and that cache stays
 * fresh for two hours (`DEFAULT_CACHE_TTL_MS`). A provider that published a
 * model this morning is therefore absent from `/models` with nothing on screen
 * explaining the absence, and the only cure shipped in the product was
 * `veyyon models refresh` from a shell the user would have to quit the TUI to
 * reach.
 *
 * The strategy argument is the entire contract. `refresh()` defaults to
 * `online-if-uncached`, which is answered by the very cache that is hiding the
 * model, so a refresh wired that way would redraw the same list and look like
 * the feature is broken. Only `online` goes past a fresh cache.
 *
 * `ctrl+r` also has to be claimed before the browser sees it: the browser
 * treats every key it does not recognise as query text, so an unclaimed
 * control byte would land in the search box and filter the list to nothing.
 */
import { beforeAll, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ModelPickerComponent } from "@veyyon/coding-agent/modes/components/model-picker";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { TUI } from "@veyyon/tui";

const CTRL_R = "\x12";

function makeModel(id: string): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider: "ollama",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

interface Harness {
	picker: ModelPickerComponent;
	/** Every strategy `refresh` was called with, in order. */
	strategies: string[];
	frame: (width?: number) => string;
}

function createPicker(refresh?: (strategy: string) => Promise<void>): Harness {
	const strategies: string[] = [];
	const model = makeModel("llama-3");
	const registry = {
		refresh: (strategy = "online-if-uncached") => {
			strategies.push(strategy);
			return refresh ? refresh(strategy) : Promise.resolve();
		},
		refreshProvider: async () => {},
		getError: () => undefined,
		getAvailable: () => [model],
		getAll: () => [model],
	} as unknown as ModelRegistry;

	const tui = { requestRender: vi.fn(), terminal: { rows: 40 } } as unknown as TUI;
	// A non-empty scoped list is the branch that does NOT fetch on open, so the
	// recorded strategies belong to the key press and nothing else.
	const picker = new ModelPickerComponent(tui, Settings.isolated({}), registry, [{ model }], {
		onPick: () => {},
		onCancel: () => {},
	});
	return {
		picker,
		strategies,
		frame: (width = 100) => stripVTControlCharacters(picker.render(width).join("\n")),
	};
}

/**
 * Drain the microtask queue. The refresh chain is `.then().catch().finally()`,
 * so its state is settled a fixed number of ticks after the fetch resolves --
 * deterministic, and never a wall-clock wait.
 */
async function settle(): Promise<void> {
	for (let tick = 0; tick < 5; tick++) await Promise.resolve();
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Failed to load the dark theme for model picker tests");
	setThemeInstance(theme);
});

describe("reloading the model catalog from the picker", () => {
	test("ctrl+r refetches past the cache instead of re-reading it", () => {
		const harness = createPicker();

		harness.picker.handleInput(CTRL_R);

		expect(harness.strategies).toEqual(["online"]);
	});

	test("ctrl+r never reaches the search box", () => {
		const harness = createPicker();

		harness.picker.handleInput(CTRL_R);

		// An unclaimed key becomes query text, and no model matches an
		// unprintable byte, so the list would render empty. It still lists.
		expect(harness.frame()).toContain("llama-3");
		expect(harness.strategies).toEqual(["online"]);
	});

	test("a second press while one is in flight does not stack another fetch", async () => {
		const gate = Promise.withResolvers<void>();
		const harness = createPicker(() => gate.promise);

		harness.picker.handleInput(CTRL_R);
		harness.picker.handleInput(CTRL_R);
		expect(harness.strategies).toEqual(["online"]);

		gate.resolve();
		await settle();

		harness.picker.handleInput(CTRL_R);
		expect(harness.strategies).toEqual(["online", "online"]);
	});

	test("a failed reload reports the reason instead of staying busy", async () => {
		const harness = createPicker(() => Promise.reject(new Error("models.dev unreachable")));

		harness.picker.handleInput(CTRL_R);
		await settle();

		const frame = harness.frame();
		expect(frame).toContain("models.dev unreachable");
		expect(frame).not.toContain("Reloading the model catalog");
	});

	test("the frame says how to reload, so the absence of a model is actionable", () => {
		expect(createPicker().frame()).toContain("ctrl+r");
	});

	test("the hint is a whole sentence at every width, never a clipped one", () => {
		// The medium card is ~56 columns of content. Truncating the long form
		// lands inside "from your providers", which reads as a rendering fault
		// and drops the actionable half of the sentence.
		const harness = createPicker();
		const hintLine = (width: number) =>
			harness
				.frame(width)
				.split("\n")
				.find(line => line.includes("Don't see a model?")) ?? "";

		expect(hintLine(100)).toContain("Don't see a model? ctrl+r reloads the catalog");
		expect(hintLine(100)).not.toContain("…");
		// A wide card has room for the sources, which is the part worth saying.
		expect(hintLine(160)).toContain("models.dev");
		expect(hintLine(160)).not.toContain("…");
	});
});
