import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import { DEFAULT_MODEL_SLOT } from "@veyyon/coding-agent/config/model-roles";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SelectorController } from "@veyyon/coding-agent/modes/controllers/selector-controller";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { AUTO_THINKING } from "@veyyon/coding-agent/thinking";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

describe("selector setting side effects", () => {
	it("refreshes the status line when git integration changes at runtime", () => {
		const updateSettings = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			statusLine: { updateSettings },
			ui: { requestRender },
		} as unknown as InteractiveModeContext);

		Settings.instance.override("git.enabled", false);
		controller.handleSettingChange("git.enabled", false);

		expect(updateSettings).toHaveBeenCalledWith(
			expect.objectContaining({
				preset: Settings.instance.get("statusLine.preset"),
				leftSegments: Settings.instance.get("statusLine.leftSegments"),
				rightSegments: Settings.instance.get("statusLine.rightSegments"),
			}),
		);
		// The setting-change side effect is a single render request — the lazy
		// top-border provider rebuilds during paint (#4145).
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("returns coordinator-backed secret transitions in rapid enable/disable initiation order", async () => {
		const initiated: boolean[] = [];
		const refreshSecrets = vi.fn(async () => {
			initiated.push(Settings.instance.get("secrets.enabled"));
		});
		const controller = new SelectorController({
			session: { refreshSecrets },
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		Settings.instance.override("secrets.enabled", true);
		const enabled = controller.handleSettingChange("secrets.enabled", true);
		Settings.instance.override("secrets.enabled", false);
		const disabled = controller.handleSettingChange("secrets.enabled", false);

		expect(enabled).toBeInstanceOf(Promise);
		expect(disabled).toBeInstanceOf(Promise);
		await Promise.all([enabled, disabled]);
		expect(refreshSecrets).toHaveBeenCalledTimes(2);
		expect(initiated).toEqual([true, false]);
	});

	it("enforces restart as the profile-sharing dispatch barrier", async () => {
		let shuttingDown = false;
		let oldSharedStorageLookups = 0;
		const shutdown = vi.fn(async () => {
			// InteractiveMode.shutdown sets its barrier before its first await.
			shuttingDown = true;
		});
		const showWarning = vi.fn();
		const controller = new SelectorController({
			shutdown,
			showWarning,
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		const transition = controller.handleSettingChange("profileSharing", false);
		const dispatchUsingCapturedSharedStorage = () => {
			if (shuttingDown) throw new Error("restart required");
			oldSharedStorageLookups++;
		};

		expect(shutdown).toHaveBeenCalledTimes(1);
		expect(() => dispatchUsingCapturedSharedStorage()).toThrow("restart required");
		expect(oldSharedStorageLookups).toBe(0);
		expect(showWarning).toHaveBeenCalledWith(expect.stringContaining("Restart required"));
		await transition;
	});

	it("invalidates the UI and requests a repaint when tui.tight changes", () => {
		const invalidate = vi.fn();
		const requestRender = vi.fn();
		const controller = new SelectorController({
			ui: { invalidate, requestRender },
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("tui.tight", true);

		expect(invalidate).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	/**
	 * The settings selector must update the live agent and journal policy, not
	 * only persist a value that takes effect after restart.
	 */
	it("applies session instrumentation to the live session", () => {
		const setInstrumentationLevel = vi.fn();
		const controller = new SelectorController({
			session: { setInstrumentationLevel },
		} as unknown as InteractiveModeContext);

		controller.handleSettingChange("session.instrumentation", "rich");

		expect(setInstrumentationLevel).toHaveBeenCalledWith("rich");
	});

	it("/model picker sets the interactive session model", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for model selector test");
		setThemeInstance(testTheme);

		const nextModel = getBundledModel("openai", "gpt-5.6") ?? getBundledModel("openai", "gpt-5.5");
		if (!nextModel) throw new Error("Expected bundled OpenAI models for selector test");

		const setModel = vi.fn(async () => ({ switched: true }));
		let picker: { handleInput(data: string): void } | undefined;
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					picker = component as { handleInput(data: string): void };
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings: Settings.isolated({}),
			session: {
				model: nextModel,
				modelRegistry: {
					getAll: () => [nextModel],
					getAvailable: () => [nextModel],
					getError: () => undefined,
					refresh: async () => {},
				},
				scopedModels: [{ model: nextModel }],
				getContextUsage: () => undefined,
				resolveTemporaryModelThinkingLevel: () => AUTO_THINKING,
				setModel,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext);

		controller.showModelSelector();
		if (!picker) throw new Error("Expected model picker overlay");
		picker.handleInput("\n");
		await Promise.resolve();

		// The slot is named once, by its storage key: the picker used to pass the
		// `interactive` alias, which `setModel` then translated inline.
		expect(setModel).toHaveBeenCalledWith(nextModel, DEFAULT_MODEL_SLOT, expect.objectContaining({ persist: true }));
	});

	it("temporary /switch picker updates the session model", async () => {
		const testTheme = await getThemeByName("dark");
		if (!testTheme) throw new Error("Failed to load dark theme for quick-role picker test");
		setThemeInstance(testTheme);

		const smol = buildModel({
			id: "smol-model",
			name: "smol-model",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			provider: "test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const slow = buildModel({
			id: "slow-model",
			name: "slow-model",
			api: "ollama-chat",
			baseUrl: "https://example.com",
			reasoning: false,
			provider: "test",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 1024,
		});
		const setModelTemporary = vi.fn(async () => {});
		const showError = vi.fn();
		let picker: { handleInput(data: string): void } | undefined;
		const settings = Settings.isolated({});
		const controller = new SelectorController({
			ui: {
				requestRender: vi.fn(),
				setFocus: vi.fn(),
				showOverlay: vi.fn((component: unknown) => {
					picker = component as { handleInput(data: string): void };
					return { hide: vi.fn() };
				}),
				terminal: { rows: 40 },
			},
			editorContainer: { clear: vi.fn(), addChild: vi.fn(), children: [] },
			editor: {},
			settings,
			session: {
				model: slow,
				modelRegistry: {
					getAll: () => [smol, slow],
					getAvailable: () => [smol, slow],
					getError: () => undefined,
					refresh: async () => {},
				},
				scopedModels: [{ model: smol }, { model: slow }],
				getContextUsage: () => undefined,
				resolveTemporaryModelThinkingLevel: () => undefined,
				setModelTemporary,
			},
			statusLine: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError,
		} as unknown as InteractiveModeContext);

		controller.showModelSelector({ temporaryOnly: true });
		if (!picker) throw new Error("Expected temporary model picker overlay");
		picker.handleInput("\n");
		await Promise.resolve();

		expect(setModelTemporary).toHaveBeenCalledWith(slow, undefined);
		expect(showError).not.toHaveBeenCalled();
	});
});
