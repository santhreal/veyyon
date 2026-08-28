import { visibleWidth } from "@veyyon/tui";
import { formatCount, hsvToRgb } from "@veyyon/utils";
import { MAIN_AGENT_ID } from "../../registry/agent-registry";
import { STTController, type SttState } from "../../stt";
import { vocalizer } from "../../tts/vocalizer";
import { VibeSessionRegistry } from "../../vibe/runtime";
import type { InteractiveMode } from "../interactive-mode";
import {
	consumeLoopLimitIteration,
	createLoopLimitRuntime,
	describeLoopLimit,
	isLoopDurationExpired,
	parseLoopLimitArgs,
} from "../loop-limit";
import { theme } from "../theme/theme";

export class CommandDispatcher {
	#host: InteractiveMode;
	#loopAutoSubmitTimer: NodeJS.Timeout | undefined;
	#sttController: STTController | undefined;
	#voiceAnimationInterval: NodeJS.Timeout | undefined;
	#voiceHue = 0;
	#voicePreviousShowHardwareCursor: boolean | null = null;
	#voicePreviousUseTerminalCursor: boolean | null = null;
	#vibeModePreviousTools: string[] | undefined;

	constructor(host: InteractiveMode) {
		this.#host = host;
	}

	get sttController(): STTController | undefined {
		return this.#sttController;
	}

	scheduleLoopAutoSubmit(): void {
		if (!this.#host.loopModeEnabled || !this.#host.loopPrompt) return;
		this.cancelLoopAutoSubmit();
		this.#loopAutoSubmitTimer = setTimeout(() => {
			this.#loopAutoSubmitTimer = undefined;
			if (this.#host.loopPrompt) {
				this.submitLoopPromptWhenReady(this.#host.loopPrompt);
			}
		}, 100);
	}

	deferLoopAutoSubmit(callback: () => void): void {
		this.cancelLoopAutoSubmit();
		this.#loopAutoSubmitTimer = setTimeout(() => {
			this.#loopAutoSubmitTimer = undefined;
			callback();
		}, 200);
	}

	cancelLoopAutoSubmit(): void {
		if (this.#loopAutoSubmitTimer) {
			clearTimeout(this.#loopAutoSubmitTimer);
			this.#loopAutoSubmitTimer = undefined;
		}
	}

	#isAutoSubmitBlocked(): boolean {
		return this.#host.session.isStreaming || this.#host.session.isCompacting || this.#host.session.hasPostPromptWork;
	}

	submitLoopPromptWhenReady(loopPrompt: string): void {
		if (isLoopDurationExpired(this.#host.loopLimit)) {
			this.disableLoopMode("Loop duration expired. Loop mode disabled.");
			return;
		}
		if (this.#isAutoSubmitBlocked()) {
			this.deferLoopAutoSubmit(() => this.submitLoopPromptWhenReady(loopPrompt));
			return;
		}
		void this.runLoopIteration("prompt", loopPrompt);
	}

	async runLoopIteration(action: "prompt" | "compact" | "reset", loopPrompt: string): Promise<void> {
		if (!this.#host.loopModeEnabled || this.#host.loopPrompt !== loopPrompt || !this.#host.onInputCallback) return;
		if (this.#isAutoSubmitBlocked()) {
			this.deferLoopAutoSubmit(() => {
				void this.runLoopIteration(action, loopPrompt);
			});
			return;
		}

		if (action === "compact") {
			await this.#host.handleCompactCommand();
			return;
		}
		if (action === "reset") {
			await this.#host.handleClearCommand();
			return;
		}

		const allowed = consumeLoopLimitIteration(this.#host.loopLimit);
		if (!allowed) {
			this.disableLoopMode("Loop iteration limit reached. Loop mode disabled.");
			return;
		}
		this.#host.onInputCallback(this.#host.startPendingSubmission({ text: loopPrompt }));
	}

	disableLoopMode(message = "Loop mode disabled."): void {
		const wasEnabled = this.#host.loopModeEnabled;
		this.#host.loopModeEnabled = false;
		this.#host.loopPrompt = undefined;
		this.#host.loopLimit = undefined;
		this.cancelLoopAutoSubmit();
		if (wasEnabled) {
			this.#host.showStatus(message);
		}
	}

	pauseLoop(): void {
		this.#host.loopPrompt = undefined;
		this.cancelLoopAutoSubmit();
	}

	async handleLoopCommand(args = ""): Promise<string | undefined> {
		if (this.#host.loopModeEnabled) {
			this.disableLoopMode();
			return undefined;
		}

		const parsed = parseLoopLimitArgs(args);
		if (typeof parsed === "string") {
			return parsed;
		}

		this.#host.loopModeEnabled = true;
		this.#host.loopPrompt = undefined;
		this.#host.loopLimit = createLoopLimitRuntime(parsed.limit);
		const limitDescription = parsed.limit ? describeLoopLimit(parsed.limit) : undefined;
		this.#host.showStatus(
			limitDescription
				? `Loop mode enabled (${limitDescription}). Send a prompt to begin.`
				: "Loop mode enabled. Send a prompt to begin.",
		);
		return undefined;
	}

	updateVibeModeStatus(): void {
		this.#host.statusLine.setVibeModeStatus(this.#host.vibeModeEnabled ? { enabled: true } : undefined);
		this.#host.ui.requestRender();
	}

	async enterVibeMode(): Promise<void> {
		if (this.#host.vibeModeEnabled) return;
		if (this.#host.planModeEnabled || this.#host.planModePaused) {
			this.#host.showWarning("Exit plan mode first.");
			return;
		}
		if (this.#host.goalModeEnabled || this.#host.goalModePaused) {
			this.#host.showWarning("Exit goal mode first.");
			return;
		}

		const previousTools = this.#host.session.getActiveToolNames();
		await this.#host.session.activateVibeTools(["read"]);
		this.#vibeModePreviousTools = previousTools;
		this.#host.vibeModeEnabled = true;
		this.#host.lastAssistantUsage = undefined;
		this.#host.session.setVibeModeState({ enabled: true });
		if (this.#host.session.isStreaming) {
			await this.#host.session.sendVibeModeContext({ deliverAs: "steer" });
		}
		this.updateVibeModeStatus();
		this.#host.sessionManager.appendModeChange("vibe");
		this.#host.showStatus("Vibe mode enabled. You direct fast/good worker sessions; toolset is read + vibe tools.");
	}

	async exitVibeMode(): Promise<void> {
		if (!this.#host.vibeModeEnabled) return;
		await this.#host.session.deactivateVibeTools(this.#vibeModePreviousTools ?? []);
		this.#host.session.setVibeModeState(undefined);
		this.#host.vibeModeEnabled = false;
		this.#vibeModePreviousTools = undefined;
		this.#host.lastAssistantUsage = undefined;
		const killed = await VibeSessionRegistry.global().killAll(
			this.#host.session.getAgentId() ?? MAIN_AGENT_ID,
			this.#host.session.asyncJobManager,
		);
		this.updateVibeModeStatus();
		this.#host.sessionManager.appendModeChange("none");
		this.#host.showStatus(
			killed > 0 ? `Vibe mode disabled. Killed ${formatCount("worker session", killed)}.` : "Vibe mode disabled.",
		);
	}

	async handleVibeModeCommand(initialPrompt?: string): Promise<void> {
		if (this.#host.vibeModeEnabled) {
			await this.exitVibeMode();
			return;
		}
		if (this.#host.planModeEnabled || this.#host.planModePaused) {
			this.#host.showWarning("Exit plan mode first.");
			return;
		}
		if (this.#host.goalModeEnabled || this.#host.goalModePaused) {
			this.#host.showWarning("Exit goal mode first.");
			return;
		}
		await this.enterVibeMode();
		if (initialPrompt && this.#host.onInputCallback) {
			this.#host.onInputCallback(this.#host.startPendingSubmission({ text: initialPrompt }));
		}
	}

	#setMicCursor(color: { r: number; g: number; b: number }): void {
		this.#host.editor.cursorOverride = `\x1b[38;2;${color.r};${color.g};${color.b}m${theme.icon.mic}\x1b[0m`;
		this.#host.editor.cursorOverrideWidth = visibleWidth(this.#host.editor.cursorOverride);
	}

	#updateMicIcon(): void {
		const { r, g, b } = hsvToRgb({ h: this.#voiceHue, s: 0.9, v: 1.0 });
		this.#setMicCursor({ r, g, b });
	}

	startMicAnimation(): void {
		if (this.#voiceAnimationInterval) return;
		this.#voiceHue = 0;
		this.#updateMicIcon();
		this.#voiceAnimationInterval = setInterval(() => {
			this.#voiceHue = (this.#voiceHue + 8) % 360;
			this.#updateMicIcon();
			this.#host.ui.requestComponentRender(this.#host.editor);
		}, 60);
	}

	stopMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
	}

	cleanupMicAnimation(): void {
		if (this.#voiceAnimationInterval) {
			clearInterval(this.#voiceAnimationInterval);
			this.#voiceAnimationInterval = undefined;
		}
		this.#host.editor.cursorOverride = undefined;
		this.#host.editor.cursorOverrideWidth = undefined;
		if (this.#voicePreviousShowHardwareCursor !== null) {
			this.#host.ui.setShowHardwareCursor(this.#voicePreviousShowHardwareCursor);
			this.#voicePreviousShowHardwareCursor = null;
		}
		if (this.#voicePreviousUseTerminalCursor !== null) {
			this.#host.editor.setUseTerminalCursor(this.#voicePreviousUseTerminalCursor);
			this.#voicePreviousUseTerminalCursor = null;
		}
	}

	async handleSTTToggle(): Promise<void> {
		if (!this.#host.settings.get("stt.enabled")) {
			this.#host.showWarning("Speech-to-text is disabled. Enable it in settings: stt.enabled");
			return;
		}
		if (!this.#sttController) {
			this.#sttController = new STTController();
		}
		await this.#sttController.toggle(this.#host.editor, {
			showWarning: (msg: string) => this.#host.showWarning(msg),
			showStatus: (msg: string) => this.#host.showStatus(msg),
			requestRender: () => this.#host.ui.requestRender(),
			onStateChange: (state: SttState) => {
				if (state === "recording") vocalizer.duck();
				else vocalizer.unduck();
				if (state === "recording") {
					this.#voicePreviousShowHardwareCursor = this.#host.ui.getShowHardwareCursor();
					this.#voicePreviousUseTerminalCursor = this.#host.editor.getUseTerminalCursor();
					this.#host.ui.setShowHardwareCursor(false);
					this.#host.editor.setUseTerminalCursor(false);
					this.startMicAnimation();
				} else if (state === "transcribing") {
					this.stopMicAnimation();
					this.#setMicCursor({ r: 200, g: 200, b: 200 });
				} else {
					this.cleanupMicAnimation();
				}
				this.#host.ui.requestRender();
			},
		});
	}

	dispose(): void {
		this.cancelLoopAutoSubmit();
		this.cleanupMicAnimation();
		if (this.#sttController) {
			this.#sttController.dispose();
			this.#sttController = undefined;
		}
	}
}
