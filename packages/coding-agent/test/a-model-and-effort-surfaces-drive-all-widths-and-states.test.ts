import { describe, expect, it, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import {
	effortStepItems,
	formatSelectorSummary,
	renderEffortStep,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/effort-picker";
import {
	buildBrowserItems,
	ModelBrowser,
} from "@veyyon/coding-agent/modes/terminal/components/selectors/model-browser";
import { ModelHubComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/model-hub";
import { ModelSelectorPanel } from "@veyyon/coding-agent/modes/terminal/components/selectors/model-selector";
import { ThinkingSelectorComponent } from "@veyyon/coding-agent/modes/terminal/components/selectors/thinking-selector";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";
import * as thinking from "@veyyon/coding-agent/thinking";
import { Container, type TUI } from "@veyyon/tui";
import type { SgrMouseEvent } from "@veyyon/utils/mouse";
import { visibleWidth } from "@veyyon/utils/width";

const WIDTHS = [60, 100, 160] as const;

function makeTestTui(rows: number = 24): TUI {
	return {
		terminal: { rows, cols: 100 },
		requestRender: vi.fn(),
		showOverlay: vi.fn(() => ({ hide: vi.fn() })),
		setFocus: vi.fn(),
	} as unknown as TUI;
}

const testTheme = await getThemeByName("dark");
if (testTheme) {
	setThemeInstance(testTheme);
}

await Settings.init({ inMemory: true });
const settings = Settings.instance;

function makeNoEffortModel(provider = "test-provider", id = "no-effort-model"): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	});
}
function makeLongNameModel(): Model {
	return buildModel({
		id: "very-long-model-identifier-that-exceeds-normal-column-widths-and-needs-sanitization-1234567890",
		name: "Very Long Model Identifier Name",
		api: "openai-chat",
		provider: "super-extra-long-custom-enterprise-provider-name-which-might-overflow-the-sidebar",
		baseUrl: "https://example.com",
		reasoning: true,
		reasoningOptions: { efforts: [Effort.Low, Effort.High] },
		input: ["text"],
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	});
}

function makeTestRegistry(models: Model[], overrides: Record<string, unknown> = {}): ModelRegistry {
	return {
		refresh: vi.fn(async () => {}),
		refreshProvider: vi.fn(async () => {}),
		getError: () => undefined,
		getAvailable: () => models,
		getAll: () => models,
		getDiscoverableProviders: () => [],
		getProviderDiscoveryState: () => undefined,
		isKeylessProvider: (p: string) => p === "ollama",
		hasConfiguredAuth: (m: Model) => m.provider !== "unauth-provider",
		authStorage: {
			hasAuth: (p: string) => p !== "unauth-provider",
			getAuth: () => undefined,
			setAccountName: () => true,
		},
		...overrides,
	} as unknown as ModelRegistry;
}

describe("Model and effort surfaces drive all widths and states", () => {
	const astra = getBundledModel("openai-codex", "gpt-6-astra")!;
	const noEffort = makeNoEffortModel();
	const longModel = makeLongNameModel();
	const testModels = [astra, noEffort, longModel];
	const registry = makeTestRegistry(testModels);

	describe("1. Catalog thinking efforts mapping to selectable tiers", () => {
		it("gpt-6-astra derives low..max effort choices", () => {
			const choices = thinking.configuredThinkingLevelsForModel(astra);
			expect(choices).toContain(thinking.AUTO_THINKING);
			expect(choices).toContain(ThinkingLevel.Off);
			expect(choices).toContain(ThinkingLevel.Low);
			expect(choices).toContain(ThinkingLevel.Medium);
			expect(choices).toContain(ThinkingLevel.High);
			expect(choices).toContain(ThinkingLevel.XHigh);
			expect(choices).toContain(ThinkingLevel.Max);
		});

		it("effortStepItems for gpt-6-astra includes model default and all valid tiers", () => {
			const items = effortStepItems(astra);
			expect(items.length).toBe(8); // Model default + auto + off + low + medium + high + xhigh + max = 8
			expect(items[0].label).toBe("Model default");
			const values = items.map(it => it.value);
			expect(values).toContain("");
			expect(values).toContain("auto");
			expect(values).toContain("off");
			expect(values).toContain("low");
			expect(values).toContain("medium");
			expect(values).toContain("high");
			expect(values).toContain("xhigh");
			expect(values).toContain("max");
		});

		it("ThinkingSelectorComponent preselects default row when currentLevel is undefined", () => {
			const selected: Array<thinking.ConfiguredThinkingLevel | undefined> = [];
			const comp = new ThinkingSelectorComponent(
				undefined,
				astra,
				level => {
					selected.push(level);
				},
				() => {},
			);
			const list = comp.getSelectList();
			expect(list.getSelectedItem()?.value).toBe("");
			comp.handleInput("\n");
			expect(selected).toEqual([undefined]);
		});

		it("ThinkingSelectorComponent preselects specific level when currentLevel is configured", () => {
			const selected: Array<thinking.ConfiguredThinkingLevel | undefined> = [];
			const comp = new ThinkingSelectorComponent(
				ThinkingLevel.High,
				astra,
				level => {
					selected.push(level);
				},
				() => {},
			);
			const list = comp.getSelectList();
			expect(list.getSelectedItem()?.value).toBe("high");
			comp.handleInput("\n");
			expect(selected).toEqual([ThinkingLevel.High]);
		});
	});

	describe("2. Model with no effort control", () => {
		it("returns empty choices from configuredThinkingLevelsForModel", () => {
			const choices = thinking.configuredThinkingLevelsForModel(noEffort);
			expect(choices).toEqual([]);
			expect(thinking.hasConfigurableThinkingEffort(noEffort)).toBe(false);
		});

		it("effortStepItems returns single model default row", () => {
			const items = effortStepItems(noEffort);
			expect(items.length).toBe(1);
			expect(items[0].label).toBe("Model default");
			expect(items[0].value).toBe("");
		});

		it("renderEffortStep displays noSelectableEffortNotice", () => {
			const container = new Container();
			renderEffortStep(container, "test-provider/no-effort-model", noEffort, vi.fn(), vi.fn());
			const lines = container.render(100).map(l => stripVTControlCharacters(l));
			const headingLine = lines.find(l => l.includes("exposes no selectable effort"));
			expect(headingLine).toBeDefined();
			expect(headingLine).toContain("This model exposes no selectable effort, so only Model default applies.");
		});
	});

	describe("3. Provider with zero models or failed discovery", () => {
		it("renders each discovery failure state in ModelHub without crashing or overflow", () => {
			const states = [
				{ status: "cached", fetchedAt: Date.now() - 300_000, expected: "Using cached model list" },
				{ status: "unavailable", error: "HTTP 404 from http://localhost:11434", expected: "404" },
				{ status: "unavailable", error: "connection refused", expected: "Discovery failed: connection refused" },
				{ status: "unauthenticated", expected: "requires authentication" },
				{ status: "empty", expected: "returned 0 models" },
				{ status: "idle", expected: "has not been refreshed yet" },
			];

			for (const state of states) {
				const reg = makeTestRegistry([], {
					getDiscoverableProviders: () => ["ollama"],
					getProviderDiscoveryState: () => state,
				});
				const tui = makeTestTui(24);
				const hub = new ModelHubComponent(
					tui,
					settings,
					reg,
					[],
					{ onAssign: vi.fn(), onUnassign: vi.fn(), onCancel: vi.fn() },
					{ initialProviderId: "ollama" },
				);
				for (const width of WIDTHS) {
					const lines = hub.render(width);
					expect(lines.length).toBe(24);
					for (const line of lines) {
						expect(visibleWidth(line)).toBeLessThanOrEqual(width);
					}
					if (width >= 100) {
						const plain = lines.map(l => stripVTControlCharacters(l)).join("\n");
						expect(plain).toContain(state.expected);
					}
				}
				hub.dispose();
			}
		});
	});

	describe("4. Disabled providers and missing credentials", () => {
		it("renders locked providers with missing credentials warning and env vars / OAuth instructions", () => {
			const reg = makeTestRegistry(testModels, {
				hasConfiguredAuth: (_m: Model) => false,
				authStorage: {
					hasAuth: () => false,
					getAuth: () => undefined,
					setAccountName: () => true,
				},
			});
			const tui = makeTestTui(24);
			const hub = new ModelHubComponent(tui, settings, reg, [], {
				onAssign: vi.fn(),
				onUnassign: vi.fn(),
				onCancel: vi.fn(),
			});

			for (const width of WIDTHS) {
				const lines = hub.render(width);
				expect(lines.length).toBe(24);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
			hub.dispose();
		});

		it("ModelSelectorPanel shows 'no auth' warning badge for unauthenticated models", () => {
			const reg = makeTestRegistry(testModels, {
				hasConfiguredAuth: (m: Model) => m.provider !== "openai-codex",
				isKeylessProvider: () => false,
				authStorage: {
					hasAuth: (p: string) => p !== "openai-codex",
					getAuth: () => undefined,
				},
			});
			const panel = new ModelSelectorPanel(
				settings,
				reg,
				testModels,
				{ title: "Select Model" },
				{ onPick: vi.fn(), onCancel: vi.fn() },
			);
			const lines = panel.render(100).map(l => stripVTControlCharacters(l));
			const unauthLine = lines.find(l => l.includes("gpt-6-astra"));
			expect(unauthLine).toBeDefined();
			expect(unauthLine).toContain("no auth");
		});
	});

	describe("5. Very long model ID and provider name at 60 columns", () => {
		it("ModelBrowser truncates properly at 60 columns without line overflow", () => {
			const browser = new ModelBrowser(settings);
			browser.setItems(buildBrowserItems([longModel]));
			const lines = browser.render(60);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(60);
			}
		});

		it("ModelHubComponent renders long provider and model names at 60 columns without overflow", () => {
			const tui = makeTestTui(24);
			const hub = new ModelHubComponent(tui, settings, registry, [], {
				onAssign: vi.fn(),
				onUnassign: vi.fn(),
				onCancel: vi.fn(),
			});
			const lines = hub.render(60);
			expect(lines.length).toBe(24);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(60);
			}
			hub.dispose();
		});

		it("ModelSelectorPanel renders long titles/descriptions at 60 columns without overflow", () => {
			const panel = new ModelSelectorPanel(
				settings,
				registry,
				[longModel],
				{
					title: "Extremely Long Title For Model Selection Panel That Might Overflow Sixty Columns",
					description: "Extremely Long Description Subtitle Explaining What This Model Slot Is For",
					allowClear: true,
				},
				{ onPick: vi.fn(), onCancel: vi.fn() },
			);
			const lines = panel.render(60);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(60);
			}
		});
	});

	describe("6. Search and filter behavior", () => {
		it("ModelBrowser filters, highlights, handles backspace and cancel ladder", () => {
			const browser = new ModelBrowser(settings);
			browser.setItems(buildBrowserItems(testModels));

			for (const ch of "astra") browser.handleInput(ch);
			expect(browser.query).toBe("astra");
			expect(browser.visibleCount).toBe(1);

			browser.handleInput("\x7f"); // Backspace
			expect(browser.query).toBe("astr");

			let cancelled = 0;
			browser.onCancel = () => {
				cancelled += 1;
			};
			browser.handleInput("\x1b"); // Escape clears query first
			expect(browser.query).toBe("");
			expect(cancelled).toBe(0);

			browser.handleInput("\x1b"); // Escape with empty query calls onCancel
			expect(cancelled).toBe(1);
		});

		it("ModelSelectorPanel shows 'No matching models' when search query has 0 matches", () => {
			const panel = new ModelSelectorPanel(
				settings,
				registry,
				testModels,
				{ title: "Select Model" },
				{ onPick: vi.fn(), onCancel: vi.fn() },
			);
			for (const char of "nonexistentquery") {
				panel.handleInput(char);
			}
			const lines = panel.render(100).map(l => stripVTControlCharacters(l));
			const emptyLine = lines.find(l => l.includes("No matching") || l.includes("No models"));
			expect(emptyLine).toBeDefined();
			expect(emptyLine).toContain("No matching models");
			expect(emptyLine).not.toContain("No models available — configure a provider or /login");
		});

		it("ModelSelectorPanel shows indented 'No models available' when models list is genuinely empty", () => {
			const panel = new ModelSelectorPanel(
				settings,
				registry,
				[],
				{ title: "Select Model" },
				{ onPick: vi.fn(), onCancel: vi.fn() },
			);
			const lines = panel.render(100).map(l => stripVTControlCharacters(l));
			const emptyLine = lines.find(l => l.includes("No models available"));
			expect(emptyLine).toBeDefined();
			expect(emptyLine).toContain("  No models available — configure a provider or /login");
		});
	});

	describe("7. Keyboard and mouse selection", () => {
		it("ModelBrowser keyboard navigation (arrows, home/end, pageUp/pageDown, enter)", () => {
			const browser = new ModelBrowser(settings);
			const items = buildBrowserItems(testModels);
			browser.setItems(items);
			const activated: unknown[] = [];
			browser.onActivate = item => {
				activated.push(item);
			};

			expect(browser.getSelected()?.id).toBe(testModels[0].id);

			browser.handleInput("\x1b[B"); // Down
			expect(browser.getSelected()?.id).toBe(testModels[1].id);

			browser.handleInput("\x1b[F"); // End
			expect(browser.getSelected()?.id).toBe(testModels[testModels.length - 1].id);

			browser.handleInput("\x1b[H"); // Home
			expect(browser.getSelected()?.id).toBe(testModels[0].id);

			browser.handleInput("\n"); // Enter
			expect(activated).toEqual([items[0]]);
		});

		it("ModelBrowser mouse interaction (wheel, hover motion, click select, click activate)", () => {
			const browser = new ModelBrowser(settings);
			const items = buildBrowserItems(testModels);
			browser.setItems(items);
			const activated: unknown[] = [];
			browser.onActivate = item => {
				activated.push(item);
			};

			// Mouse motion over line 3 (index 1)
			browser.routeMouse({ row: 3, col: 10, leftClick: false, motion: true, wheel: null } as SgrMouseEvent, 3);
			browser.render(100);

			// Click to select line 3 (index 1)
			browser.routeMouse({ row: 3, col: 10, leftClick: true, motion: false, wheel: null } as SgrMouseEvent, 3);
			expect(browser.getSelected()?.id).toBe(testModels[1].id);

			// Second click on selected line activates
			browser.routeMouse({ row: 3, col: 10, leftClick: true, motion: false, wheel: null } as SgrMouseEvent, 3);
			expect(activated).toEqual([items[1]]);
		});
	});

	describe("8. Model summary formatting", () => {
		it("formatSelectorSummary formats thinking effort suffix cleanly", () => {
			expect(formatSelectorSummary("openai-codex/gpt-6-astra:high")).toBe("openai-codex/gpt-6-astra · high");
			expect(formatSelectorSummary("openai-codex/gpt-6-astra")).toBe("openai-codex/gpt-6-astra");
			expect(formatSelectorSummary("")).toBe("");
		});
	});
});
