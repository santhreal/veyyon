import { hsvToRgb } from "@veyyon/utils";
import { visibleWidth } from "@veyyon/utils/width";
import { settings } from "../../../config/settings";
import { STTController, type SttState } from "../../../speech/stt";
import { vocalizer } from "../../../speech/tts/vocalizer";
import { theme } from "../../../theme/theme";
import type { InteractiveModeContext } from "../types";

/**
 * The slice of the interactive context this controller uses: 4 members of the
 * 215 `InteractiveModeContext` declares. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces.
 */
export type VoiceControllerContext = Pick<InteractiveModeContext, "editor" | "showStatus" | "showWarning" | "ui">;

/** Milliseconds between hue steps of the recording microphone glyph. */
const MIC_FRAME_MS = 60;

/** Degrees of hue per animation frame. */
const MIC_HUE_STEP = 8;

/** The grey the microphone settles on while a recording is transcribed. */
const TRANSCRIBING_GREY = { r: 200, g: 200, b: 200 } as const;

/**
 * Push-to-talk: the speech-to-text toggle and the animated microphone glyph that
 * replaces the composer cursor while a recording is live.
 *
 * The glyph is a cursor override rather than a component, so a hue frame
 * repaints the editor alone and never re-walks the transcript. Both cursor
 * settings a recording suppresses are captured on entry and restored on exit,
 * which is why they are held here: the values to restore are the ones that were
 * live when the recording started.
 */
export class VoiceController {
	#context: VoiceControllerContext;
	#stt: STTController | undefined;
	#animation: NodeJS.Timeout | undefined;
	#hue = 0;
	#previousShowHardwareCursor: boolean | null = null;
	#previousUseTerminalCursor: boolean | null = null;

	constructor(context: VoiceControllerContext) {
		this.#context = context;
	}

	/** Start or stop a recording, stating the setting when the feature is off. */
	async toggle(): Promise<void> {
		if (!settings.get("stt.enabled")) {
			this.#context.showWarning("Speech-to-text is disabled. Enable it in settings: stt.enabled");
			return;
		}
		this.#stt ??= new STTController();
		await this.#stt.toggle(this.#context.editor, {
			showWarning: (msg: string) => this.#context.showWarning(msg),
			showStatus: (msg: string) => this.#context.showStatus(msg),
			requestRender: () => this.#context.ui.requestRender(),
			onStateChange: (state: SttState) => this.#onStateChange(state),
		});
	}

	/** Stop the animation, restore both cursors and release the recogniser. */
	dispose(): void {
		this.cleanup();
		if (this.#stt) {
			this.#stt.dispose();
			this.#stt = undefined;
		}
	}

	/** Stop the animation and restore the cursor settings a recording suppressed. */
	cleanup(): void {
		this.#stopAnimation();
		this.#context.editor.cursorOverride = undefined;
		this.#context.editor.cursorOverrideWidth = undefined;
		if (this.#previousShowHardwareCursor !== null) {
			this.#context.ui.setShowHardwareCursor(this.#previousShowHardwareCursor);
			this.#previousShowHardwareCursor = null;
		}
		if (this.#previousUseTerminalCursor !== null) {
			this.#context.editor.setUseTerminalCursor(this.#previousUseTerminalCursor);
			this.#previousUseTerminalCursor = null;
		}
	}

	#onStateChange(state: SttState): void {
		// Duck assistant speech while the user is talking (push-to-talk); restore after.
		if (state === "recording") vocalizer.duck();
		else vocalizer.unduck();
		if (state === "recording") {
			this.#previousShowHardwareCursor = this.#context.ui.getShowHardwareCursor();
			this.#previousUseTerminalCursor = this.#context.editor.getUseTerminalCursor();
			this.#context.ui.setShowHardwareCursor(false);
			this.#context.editor.setUseTerminalCursor(false);
			this.#startAnimation();
		} else if (state === "transcribing") {
			this.#stopAnimation();
			this.#setCursor(TRANSCRIBING_GREY);
		} else {
			this.cleanup();
		}
		this.#context.ui.requestRender();
	}

	#setCursor(color: { r: number; g: number; b: number }): void {
		const editor = this.#context.editor;
		editor.cursorOverride = `\x1b[38;2;${color.r};${color.g};${color.b}m${theme.icon.mic}\x1b[0m`;
		// Theme symbols can be wide, so measure the rendered override.
		editor.cursorOverrideWidth = visibleWidth(editor.cursorOverride);
	}

	#updateIcon(): void {
		const { r, g, b } = hsvToRgb({ h: this.#hue, s: 0.9, v: 1.0 });
		this.#setCursor({ r, g, b });
	}

	#startAnimation(): void {
		if (this.#animation) return;
		this.#hue = 0;
		this.#updateIcon();
		this.#animation = setInterval(() => {
			this.#hue = (this.#hue + MIC_HUE_STEP) % 360;
			this.#updateIcon();
			// Component-scoped: the hue sweep only recolors the editor's cursor
			// glyph, so the transcript subtree is reused per animation frame.
			this.#context.ui.requestComponentRender(this.#context.editor);
		}, MIC_FRAME_MS);
	}

	#stopAnimation(): void {
		if (this.#animation) {
			clearInterval(this.#animation);
			this.#animation = undefined;
		}
	}
}
