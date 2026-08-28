/**
 * WHY: push-to-talk replaces the composer cursor with an animated microphone
 * glyph, and it does that by suppressing two cursor settings and writing a
 * cursor override. Both settings are captured on entry and restored on exit, so
 * every exit route has to restore them: a recording that ends without restoring
 * leaves the composer with no visible cursor for the rest of the session, and a
 * hue timer that outlives the recording repaints the editor forever.
 *
 * Closes the class: the whole state machine (`recording` → `transcribing` →
 * `idle`) is driven, and each transition is asserted on the VALUES it left
 * behind — the exact sequence written to each cursor setting, the override text,
 * and which component the repaints named. `dispose()` and `cleanup()` are both
 * asserted to restore. The two lifecycle tests run against the real
 * `STTController` with the recorder and transcriber stubbed at their module
 * boundary; the timer tests drive the same callback the real controller invokes,
 * so the hue sweep is observable without a real clock.
 *
 * Does NOT catch: the transcription itself, the submit trigger, or the recorder
 * — those are the STT suites. Audio ducking is not asserted.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import type { TUI } from "@veyyon/tui";
import { visibleWidth } from "@veyyon/utils/width";
import { Settings, settings } from "../../../src/config/settings";
import { VoiceController, type VoiceControllerContext } from "../../../src/modes/terminal/controllers/voice-controller";
import * as downloader from "../../../src/speech/stt/downloader";
import * as recorder from "../../../src/speech/stt/recorder";
import { STTController, type SttState } from "../../../src/speech/stt/stt-controller";
import * as transcriber from "../../../src/speech/stt/transcriber";
import { initTheme, theme } from "../../../src/theme/theme";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

type ComposerEditor = VoiceControllerContext["editor"];

/** Every value the controller wrote, in the order it wrote them. */
interface Harness {
	controller: VoiceController;
	editor: ComposerEditor;
	overrides: (string | undefined)[];
	overrideWidths: (number | undefined)[];
	hardwareCursor: boolean[];
	terminalCursor: boolean[];
	componentRenders: object[];
	renderRequests: () => number;
	warnings: string[];
	statuses: string[];
	cursorOverride: () => string | undefined;
	cursorOverrideWidth: () => number | undefined;
}

function makeHarness(): Harness {
	const overrides: (string | undefined)[] = [];
	const overrideWidths: (number | undefined)[] = [];
	const hardwareCursor: boolean[] = [];
	const terminalCursor: boolean[] = [];
	const componentRenders: object[] = [];
	const warnings: string[] = [];
	const statuses: string[] = [];
	let renders = 0;
	let override: string | undefined;
	let overrideWidth: number | undefined;

	const editor = {
		insertText: () => {},
		setVolatileText: () => {},
		clearVolatileText: () => {},
		commitVolatileText: () => {},
		submit: () => {},
		deleteBeforeCursor: () => {},
		getUseTerminalCursor: () => true,
		setUseTerminalCursor: (use: boolean) => {
			terminalCursor.push(use);
		},
		get cursorOverride(): string | undefined {
			return override;
		},
		set cursorOverride(value: string | undefined) {
			override = value;
			overrides.push(value);
		},
		get cursorOverrideWidth(): number | undefined {
			return overrideWidth;
		},
		set cursorOverrideWidth(value: number | undefined) {
			overrideWidth = value;
			overrideWidths.push(value);
		},
	} as unknown as ComposerEditor;

	const ui = {
		getShowHardwareCursor: () => true,
		setShowHardwareCursor: (show: boolean) => {
			hardwareCursor.push(show);
		},
		requestRender: () => {
			renders += 1;
		},
		requestComponentRender: (component: object) => {
			componentRenders.push(component);
		},
	} as unknown as TUI;

	return {
		controller: new VoiceController({
			editor,
			showStatus: (message: string) => {
				statuses.push(message);
			},
			showWarning: (message: string) => {
				warnings.push(message);
			},
			ui,
		}),
		editor,
		overrides,
		overrideWidths,
		hardwareCursor,
		terminalCursor,
		componentRenders,
		renderRequests: () => renders,
		warnings,
		statuses,
		cursorOverride: () => override,
		cursorOverrideWidth: () => overrideWidth,
	};
}

describe("a recording owns the cursor and gives it back", () => {
	let state: SettingsTestState | undefined;
	let harness: Harness | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		state = beginSettingsTest();
		await Settings.init({ inMemory: true });
		settings.set("stt.enabled", true);
		settings.set("stt.modelName", "fast");
		settings.set("stt.submitTrigger", "never");
		vi.spyOn(downloader, "isSttModelCached").mockResolvedValue(true);
		vi.spyOn(downloader, "downloadSttModel").mockResolvedValue(undefined);
		vi.spyOn(recorder, "ensureRecorder").mockResolvedValue({ tool: "sox", bin: "sox" });
		vi.spyOn(recorder, "detectRecorder").mockReturnValue({ tool: "sox", bin: "sox" });
		vi.spyOn(recorder, "startRecording").mockResolvedValue({ stop: async () => {} });
		vi.spyOn(recorder, "verifyRecordingFile").mockResolvedValue(1);
		vi.spyOn(transcriber, "transcribe").mockResolvedValue("hello world");
	});

	afterEach(() => {
		harness?.controller.dispose();
		harness = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
		restoreSettingsTestState(state);
	});

	/**
	 * Drive the controller's own state callback — the one the real
	 * `STTController` invokes — so a hue frame is observable on a fake clock.
	 * The real start path awaits recorder and model work on real timers, which a
	 * fake clock would never release.
	 */
	async function driveStates(controller: VoiceController): Promise<(state: SttState) => void> {
		let emit: ((state: SttState) => void) | undefined;
		vi.spyOn(STTController.prototype, "toggle").mockImplementation(async (_editor, options) => {
			emit = options.onStateChange;
		});
		await controller.toggle();
		expect(emit).toBeDefined();
		return state => emit?.(state);
	}

	it("names the setting and touches nothing while speech-to-text is off", async () => {
		settings.set("stt.enabled", false);
		harness = makeHarness();

		await harness.controller.toggle();

		expect(harness.warnings.length).toBe(1);
		expect(harness.warnings[0]).toContain("stt.enabled");
		expect(harness.overrides).toEqual([]);
		expect(harness.hardwareCursor).toEqual([]);
		expect(harness.terminalCursor).toEqual([]);
	});

	it("suppresses both cursors and paints the microphone while recording", async () => {
		harness = makeHarness();

		await harness.controller.toggle();

		expect(harness.hardwareCursor).toEqual([false]);
		expect(harness.terminalCursor).toEqual([false]);
		const override = harness.cursorOverride();
		expect(override).toContain(theme.icon.mic);
		expect(override).toMatch(/\x1b\[38;2;\d+;\d+;\d+m/);
		expect(harness.cursorOverrideWidth()).toBe(visibleWidth(override ?? ""));
		expect(harness.renderRequests()).toBeGreaterThan(0);
	});

	it("restores both cursor settings and drops the override once the recording is done", async () => {
		harness = makeHarness();

		await harness.controller.toggle();
		await harness.controller.toggle();

		expect(harness.cursorOverride()).toBeUndefined();
		expect(harness.cursorOverrideWidth()).toBeUndefined();
		expect(harness.hardwareCursor).toEqual([false, true]);
		expect(harness.terminalCursor).toEqual([false, true]);
	});

	it("restores the cursor when the mode tears down mid-recording", async () => {
		harness = makeHarness();

		await harness.controller.toggle();
		expect(harness.cursorOverride()).toBeDefined();

		harness.controller.dispose();

		expect(harness.cursorOverride()).toBeUndefined();
		expect(harness.hardwareCursor).toEqual([false, true]);
		expect(harness.terminalCursor).toEqual([false, true]);
	});

	it("sweeps the microphone hue on its own timer, repainting only the editor", async () => {
		vi.useFakeTimers();
		harness = makeHarness();
		const emit = await driveStates(harness.controller);

		emit("recording");
		const firstFrame = harness.cursorOverride();
		expect(firstFrame).toContain(theme.icon.mic);
		harness.componentRenders.length = 0;

		vi.advanceTimersByTime(300);

		expect(harness.componentRenders.length).toBeGreaterThan(0);
		const editor: object = harness.editor;
		expect(harness.componentRenders.every(component => component === editor)).toBe(true);
		expect(harness.cursorOverride()).not.toBe(firstFrame);
	});

	it("settles the microphone on grey and stops the sweep while transcribing", async () => {
		vi.useFakeTimers();
		harness = makeHarness();
		const emit = await driveStates(harness.controller);

		emit("recording");
		vi.advanceTimersByTime(300);
		emit("transcribing");

		expect(harness.cursorOverride()).toContain("\x1b[38;2;200;200;200m");
		harness.componentRenders.length = 0;
		vi.advanceTimersByTime(600);

		expect(harness.componentRenders).toEqual([]);
		expect(harness.cursorOverride()).toContain("\x1b[38;2;200;200;200m");
	});

	it("stops the hue timer on teardown, so a torn-down mode draws no more frames", async () => {
		vi.useFakeTimers();
		harness = makeHarness();
		const emit = await driveStates(harness.controller);

		emit("recording");
		vi.advanceTimersByTime(120);
		harness.controller.dispose();
		harness.componentRenders.length = 0;

		vi.advanceTimersByTime(1_000);

		expect(harness.componentRenders).toEqual([]);
		expect(harness.cursorOverride()).toBeUndefined();
	});

	it("returns to the composer cursor when a recording ends without a transcript", async () => {
		vi.useFakeTimers();
		harness = makeHarness();
		const emit = await driveStates(harness.controller);

		emit("recording");
		emit("idle");

		expect(harness.cursorOverride()).toBeUndefined();
		expect(harness.cursorOverrideWidth()).toBeUndefined();
		expect(harness.hardwareCursor).toEqual([false, true]);
		expect(harness.terminalCursor).toEqual([false, true]);
	});

	it("restores nothing it never captured, so a cleanup outside a recording is inert", () => {
		harness = makeHarness();

		harness.controller.cleanup();

		expect(harness.hardwareCursor).toEqual([]);
		expect(harness.terminalCursor).toEqual([]);
		expect(harness.overrides).toEqual([undefined]);
	});
});
